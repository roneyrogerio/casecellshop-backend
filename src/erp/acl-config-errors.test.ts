import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import {
  histogramCount,
  metricValue,
  scrapeMetrics,
  type Exposition,
} from '../../test/helpers/metrics.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { createErpClient } from './acl.ts';
import type { ErpClient, ErpOrderRequest } from './erp-client.ts';
import {
  ErpNetworkError,
  type ErpNetworkCode,
  type ErpResponse,
  type ErpTransport,
} from './transport.ts';

// OBS-02 (erros de configuração do ERP): cada chamada com desfecho `config_error` soma 1 em
// casecellshop.erp.config_errors, com a operação dela, junto com a gravação do histograma de duração. Cada teste tem
// a telemetria dele: o counter é cumulativo.

const COUNTER = 'casecellshop.erp.config_errors';
const DURATION = 'casecellshop.erp.client.operation.duration';
const OPERATION = 'casecellshop.erp.operation';

const orderRequest: ErpOrderRequest = {
  reference: 'pedido-config-0001',
  items: [{ sku: 'CONFIG-CAPA-AZUL', quantity: 1, unitPriceCents: 4990 }],
};
const erpOrder = { erpOrderId: 'erp-1', reference: orderRequest.reference };
const catalogPage = {
  items: [
    { sku: 'CONFIG-CAPA-AZUL', name: 'Capa azul', priceCents: 4990, onHand: 3 },
  ],
  hasNext: false,
};

type Operation = 'create_order' | 'find_order' | 'list_catalog';
const OPERATIONS: Operation[] = ['create_order', 'find_order', 'list_catalog'];

const telemetries: Telemetry[] = [];

afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

function clientOver(respond: () => Promise<ErpResponse>) {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  let sends = 0;
  const transport: ErpTransport = {
    send: () => {
      sends += 1;
      return respond();
    },
  };
  const client = createErpClient({
    transport,
    clock: createManualClock(),
    timeoutMs: 10_000,
    telemetry,
  });
  return { client, telemetry, sends: () => sends };
}

const responding = (status: number, body?: unknown) =>
  clientOver(() => Promise.resolve({ status, body }));

const failingWith = (code: ErpNetworkCode) =>
  clientOver(() => Promise.reject(new ErpNetworkError(code)));

const CALLS: Record<
  Operation,
  (client: ErpClient) => Promise<{ kind: string }>
> = {
  create_order: (client) => client.createOrder(orderRequest),
  find_order: (client) => client.findOrderByReference(orderRequest.reference),
  list_catalog: (client) => client.listCatalog(1),
};

const callOperation = (client: ErpClient, operation: Operation) =>
  CALLS[operation](client);

// A soma dos erros de configuração de uma operação; sem a série, 0 (o counter pode ainda não ter nascido).
function configErrors(families: Exposition, operation: Operation): number {
  return metricValue(families, COUNTER, { [OPERATION]: operation }) ?? 0;
}

function totalConfigErrors(families: Exposition): number {
  return OPERATIONS.reduce(
    (sum, operation) => sum + configErrors(families, operation),
    0,
  );
}

describe('OBS-02 o config_error de cada operação soma no counter dela', () => {
  it.each(OPERATIONS)(
    'OBS-02 %s com 401 soma 1 em casecellshop.erp.config_errors só na operação dela, junto com a gravação do histograma',
    async (operation) => {
      const { client, telemetry, sends } = responding(401);

      const result = await callOperation(client, operation);

      expect(sends(), 'a chamada chegou ao transporte').toBe(1);
      expect(result.kind).toBe('config_error');
      const families = await scrapeMetrics(telemetry);
      expect(configErrors(families, operation)).toBe(1);
      for (const other of OPERATIONS.filter((name) => name !== operation))
        expect(configErrors(families, other), `operação ${other}`).toBe(0);
      expect(
        histogramCount(families, DURATION, {
          [OPERATION]: operation,
          'casecellshop.erp.outcome': 'config_error',
        }),
        'o histograma conta a mesma chamada',
      ).toBe(1);
    },
  );

  it('OBS-02 o counter é exposto como counter, com o nome do catálogo', async () => {
    const { client, telemetry } = responding(403);

    await client.createOrder(orderRequest);

    const families = await scrapeMetrics(telemetry);
    expect(families.get('casecellshop_erp_config_errors_total')?.type).toBe(
      'counter',
    );
  });

  it.each([400, 401, 403])(
    'OBS-02 a criação com %i, erro de configuração, soma 1',
    async (status) => {
      const { client, telemetry } = responding(status);

      await client.createOrder(orderRequest);

      expect(configErrors(await scrapeMetrics(telemetry), 'create_order')).toBe(
        1,
      );
    },
  );

  it('OBS-02 o 404 da listagem, erro de configuração, soma 1', async () => {
    const { client, telemetry } = responding(404);

    const result = await client.listCatalog(1);

    expect(result.kind).toBe('config_error');
    expect(configErrors(await scrapeMetrics(telemetry), 'list_catalog')).toBe(
      1,
    );
  });

  it('OBS-02 três chamadas com config_error em duas operações somam 2 e 1, cada uma na sua série', async () => {
    const { client, telemetry } = responding(401);

    await client.createOrder(orderRequest);
    await client.createOrder({ ...orderRequest, reference: 'pedido-outro-02' });
    await client.findOrderByReference(orderRequest.reference);

    const families = await scrapeMetrics(telemetry);
    expect(configErrors(families, 'create_order')).toBe(2);
    expect(configErrors(families, 'find_order')).toBe(1);
    expect(configErrors(families, 'list_catalog')).toBe(0);
  });
});

describe('OBS-02 controle: outros desfechos não somam no counter de erro de configuração', () => {
  const cases: {
    label: string;
    operation: Operation;
    client: () => ReturnType<typeof clientOver>;
    outcome: string;
  }[] = [
    {
      label: 'criação 201 (ok)',
      operation: 'create_order',
      client: () => responding(201, erpOrder),
      outcome: 'ok',
    },
    {
      label: 'criação 422 (permanent)',
      operation: 'create_order',
      client: () => responding(422, { code: 'rejected' }),
      outcome: 'permanent',
    },
    {
      label: 'criação 503 (transient)',
      operation: 'create_order',
      client: () => responding(503),
      outcome: 'transient',
    },
    {
      label: 'criação com ECONNRESET (ambiguous)',
      operation: 'create_order',
      client: () => failingWith('ECONNRESET'),
      outcome: 'ambiguous',
    },
    {
      label: 'consulta 200 (found)',
      operation: 'find_order',
      client: () => responding(200, erpOrder),
      outcome: 'found',
    },
    {
      label: 'consulta 404 order_not_found (not_found)',
      operation: 'find_order',
      client: () => responding(404, { code: 'order_not_found' }),
      outcome: 'not_found',
    },
    {
      label: 'consulta 503 (transient)',
      operation: 'find_order',
      client: () => responding(503),
      outcome: 'transient',
    },
    {
      label: 'listagem 200 (ok)',
      operation: 'list_catalog',
      client: () => responding(200, catalogPage),
      outcome: 'ok',
    },
    {
      label: 'listagem 503 (transient)',
      operation: 'list_catalog',
      client: () => responding(503),
      outcome: 'transient',
    },
  ];

  it.each(cases)(
    'OBS-02 $label não soma em casecellshop.erp.config_errors, e o histograma conta a chamada com o desfecho dela',
    async ({ operation, client: make, outcome }) => {
      const { client, telemetry, sends } = make();

      await callOperation(client, operation);

      expect(sends(), 'a chamada chegou ao transporte').toBe(1);
      const families = await scrapeMetrics(telemetry);
      expect(totalConfigErrors(families)).toBe(0);
      // O controle positivo: a chamada foi medida pelo histograma, só não entrou no counter de configuração.
      expect(
        histogramCount(families, DURATION, {
          [OPERATION]: operation,
          'casecellshop.erp.outcome': outcome,
        }),
      ).toBe(1);
    },
  );
});
