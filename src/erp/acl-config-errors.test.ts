import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import {
  countingInvoices,
  rejectingInvoices,
  type FakeInvoiceReader,
} from '../../test/helpers/invoice-reader.ts';
import {
  histogramCount,
  metricValue,
  scrapeMetrics,
  type Exposition,
} from '../../test/helpers/metrics.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { createErpClient } from './acl.ts';
import { erpMetrics } from './telemetry.ts';
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
    // Estes testes não exercitam a contagem de faturas (AD-031): o leitor só satisfaz a opção obrigatória.
    invoiceReader: countingInvoices(),
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

// A contagem de faturas lê o banco do ERP, e não a API: não tem erro de configuração (a falha da leitura sai como
// `transient` e alerta pelo CasecellshopVerificacaoTardiaSemLeitura). A série `count_invoices` nunca se moveria, então
// o counter não a declara; o histograma de duração continua com as quatro operações.
describe('OBS-08 o counter de erro de configuração só tem as operações da API', () => {
  const API_OPERATIONS = ['create_order', 'find_order', 'list_catalog'];

  // O ERP responde 200 a tudo; o que varia é o leitor do banco do ERP.
  function readerOver(invoiceReader: FakeInvoiceReader) {
    const telemetry = createTelemetry({
      spanExporter: new InMemorySpanExporter(),
    });
    telemetries.push(telemetry);
    const client = createErpClient({
      transport: {
        send: () => Promise.resolve({ status: 200, body: undefined }),
      },
      clock: createManualClock(),
      timeoutMs: 10_000,
      telemetry,
      invoiceReader,
    });
    return { client, telemetry };
  }

  function operationsOfCounter(families: Exposition): string[] {
    return (families.get('casecellshop_erp_config_errors_total')?.samples ?? [])
      .map((sample) => sample.labels['casecellshop_erp_operation'] ?? '')
      .sort();
  }

  it('OBS-08 logo depois da subida, antes de qualquer chamada, o counter tem as três operações da API em 0 e nenhuma série count_invoices', async () => {
    const { telemetry } = responding(200);
    // O worker cria os instrumentos do ERP na subida (src/main/worker.ts), e é aí que as séries nascem em 0.
    erpMetrics(telemetry);

    const families = await scrapeMetrics(telemetry);

    for (const operation of API_OPERATIONS)
      expect(
        metricValue(families, COUNTER, { [OPERATION]: operation }),
        `série de ${operation} em 0`,
      ).toBe(0);
    expect(
      metricValue(families, COUNTER, { [OPERATION]: 'count_invoices' }),
    ).toBeUndefined();
    expect(operationsOfCounter(families)).toEqual([...API_OPERATIONS].sort());
  });

  it('OBS-08 a contagem de faturas, com sucesso ou com a leitura falhando, entra no histograma de duração e não cria série no counter de erro de configuração', async () => {
    const reading = readerOver(countingInvoices(2));
    const failingReader = rejectingInvoices();
    const unreadable = readerOver(failingReader);

    const counted = await reading.client.countInvoicesByReference(
      orderRequest.reference,
    );
    const failed = await unreadable.client.countInvoicesByReference(
      orderRequest.reference,
    );

    expect(counted).toEqual({ kind: 'ok', count: 2 });
    expect(failed.kind).toBe('transient');
    expect(failingReader.calls, 'a leitura falhou de fato').toHaveLength(1);
    for (const [rig, outcome] of [
      [reading, 'ok'],
      [unreadable, 'transient'],
    ] as const) {
      const families = await scrapeMetrics(rig.telemetry);
      expect(
        histogramCount(families, DURATION, {
          [OPERATION]: 'count_invoices',
          'casecellshop.erp.outcome': outcome,
        }),
        `o histograma segue com count_invoices (${outcome})`,
      ).toBe(1);
      expect(operationsOfCounter(families)).toEqual([...API_OPERATIONS].sort());
    }
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
