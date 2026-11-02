import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import { countingInvoices } from '../../test/helpers/invoice-reader.ts';
import { metricValue, scrapeMetrics } from '../../test/helpers/metrics.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { createErpClient } from './acl.ts';
import type { ErpOrderRequest } from './erp-client.ts';
import type { ErpTransport } from './transport.ts';

// OBS-06 (a metade do ERP): uma rejeição por falta de estoque no ERP soma 1 em
// casecellshop.erp.out_of_stock.rejections (no /metrics, casecellshop_erp_out_of_stock_rejections_total).
// O gauge de SKUs com reserved > on_hand está em test/integration/observability/db-gauges.test.ts. Cada teste tem a
// telemetria dele: o contador é cumulativo.

const COUNTER = 'casecellshop.erp.out_of_stock.rejections';

const orderRequest: ErpOrderRequest = {
  reference: 'pedido-estoque-0001',
  items: [{ sku: 'ESTOQUE-CAPA-AZUL', quantity: 2, unitPriceCents: 4990 }],
};
const erpOrder = { erpOrderId: 'erp-1', reference: orderRequest.reference };

const telemetries: Telemetry[] = [];

afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

function clientOver(status: number, body?: unknown) {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  let sends = 0;
  const transport: ErpTransport = {
    send: () => {
      sends += 1;
      return Promise.resolve({ status, body });
    },
  };
  const client = createErpClient({
    transport,
    invoiceReader: countingInvoices(),
    clock: createManualClock(),
    timeoutMs: 10_000,
    telemetry,
  });
  return { client, telemetry, sends: () => sends };
}

async function rejections(telemetry: Telemetry): Promise<number | undefined> {
  return metricValue(await scrapeMetrics(telemetry), COUNTER);
}

describe('OBS-06 rejeição por falta de estoque no ERP soma no counter dela', () => {
  it('OBS-06 uma criação recusada com out_of_stock (422) soma 1 no counter e devolve a recusa permanente por falta de estoque', async () => {
    const { client, telemetry, sends } = clientOver(422, {
      code: 'out_of_stock',
      sku: 'ESTOQUE-CAPA-AZUL',
    });

    const result = await client.createOrder(orderRequest);

    expect(sends(), 'a chamada chegou ao transporte').toBe(1);
    // O sku do corpo do 422 vai na recusa, só para o log (OBS-01).
    expect(result).toEqual({
      kind: 'permanent',
      reason: 'out_of_stock',
      sku: 'ESTOQUE-CAPA-AZUL',
    });
    expect(await rejections(telemetry)).toBe(1);
  });

  it('OBS-06 duas criações recusadas por falta de estoque somam 2, e o /metrics expõe a série com o nome do design', async () => {
    const { client, telemetry } = clientOver(422, { code: 'out_of_stock' });

    await client.createOrder(orderRequest);
    await client.createOrder({ ...orderRequest, reference: 'pedido-outro-02' });

    const families = await scrapeMetrics(telemetry);
    expect(
      families.get('casecellshop_erp_out_of_stock_rejections_total')?.type,
    ).toBe('counter');
    expect(metricValue(families, COUNTER)).toBe(2);
  });

  it('OBS-06 controle: uma recusa permanente que não é falta de estoque (422 com outro código) não soma', async () => {
    const { client, telemetry, sends } = clientOver(422, {
      code: 'invalid_order',
    });

    const result = await client.createOrder(orderRequest);

    expect(sends(), 'a chamada chegou ao transporte').toBe(1);
    expect(result).toEqual({ kind: 'permanent', reason: 'rejected' });
    expect((await rejections(telemetry)) ?? 0).toBe(0);
  });

  it('OBS-06 controle: uma criação com sucesso (201) não soma', async () => {
    const { client, telemetry, sends } = clientOver(201, erpOrder);

    const result = await client.createOrder(orderRequest);

    expect(sends(), 'a chamada chegou ao transporte').toBe(1);
    expect(result.kind).toBe('ok');
    expect((await rejections(telemetry)) ?? 0).toBe(0);
  });

  it.each([
    { label: 'indisponível (503)', status: 503 },
    { label: 'erro de configuração (401)', status: 401 },
    { label: 'erro do ERP (500)', status: 500 },
  ])(
    'OBS-06 controle: uma criação com falha técnica, $label, não soma',
    async ({ status }) => {
      const { client, telemetry, sends } = clientOver(status);

      await client.createOrder(orderRequest);

      expect(sends(), 'a chamada chegou ao transporte').toBe(1);
      expect((await rejections(telemetry)) ?? 0).toBe(0);
    },
  );
});
