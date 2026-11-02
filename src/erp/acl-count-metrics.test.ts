import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { settle, track } from '../../test/helpers/async.ts';
import { createManualClock } from '../../test/helpers/clock.ts';
import {
  countingInvoices,
  hangingInvoices,
  rejectingInvoices,
} from '../../test/helpers/invoice-reader.ts';
import { histogramCount, scrapeMetrics } from '../../test/helpers/metrics.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { createErpClient } from './acl.ts';
import type { ErpInvoiceReader, ErpTransport } from './transport.ts';

// ORD-21 e OBS-02 (AD-031): a contagem de faturas mede no histograma de duração do ERP com a operação
// `count_invoices` e o desfecho da lista fechada. Cada teste tem a telemetria dele: o histograma é cumulativo.

const DURATION = 'casecellshop.erp.client.operation.duration';
const TIMEOUT_MS = 10_000;

const telemetries: Telemetry[] = [];

afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

// A contagem não usa o transporte da API: uma chamada a ele derrubaria o teste.
const unusedTransport: ErpTransport = {
  send: () => Promise.reject(new Error('o transporte da API não se usa aqui')),
};

function clientOver(invoiceReader: ErpInvoiceReader) {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  const clock = createManualClock();
  const client = createErpClient({
    transport: unusedTransport,
    invoiceReader,
    clock,
    timeoutMs: TIMEOUT_MS,
    telemetry,
  });
  return { client, clock, telemetry };
}

describe('ORD-21 a contagem de faturas mede no histograma de duração do ERP', () => {
  it('ORD-21 uma contagem conclusiva soma 1 no _count de count_invoices com o desfecho ok', async () => {
    const { client, telemetry } = clientOver(countingInvoices(2));

    expect(await client.countInvoicesByReference('pedido-contagem-1')).toEqual({
      kind: 'ok',
      count: 2,
    });

    const families = await scrapeMetrics(telemetry);
    expect(
      histogramCount(families, DURATION, {
        'casecellshop.erp.operation': 'count_invoices',
        'casecellshop.erp.outcome': 'ok',
      }),
    ).toBe(1);
  });

  it('ORD-21 a leitura que rejeita soma 1 com o desfecho transient, e nenhum ok', async () => {
    const { client, telemetry } = clientOver(rejectingInvoices());

    await client.countInvoicesByReference('pedido-contagem-2');

    const families = await scrapeMetrics(telemetry);
    expect(
      histogramCount(families, DURATION, {
        'casecellshop.erp.operation': 'count_invoices',
        'casecellshop.erp.outcome': 'transient',
      }),
    ).toBe(1);
    expect(
      histogramCount(families, DURATION, {
        'casecellshop.erp.operation': 'count_invoices',
        'casecellshop.erp.outcome': 'ok',
      }),
    ).toBeUndefined();
  });

  it('ORD-21 a duração da contagem corre no relógio injetável: o timeout de 10 s mede 10 s', async () => {
    const { client, clock, telemetry } = clientOver(hangingInvoices());

    const call = track(client.countInvoicesByReference('pedido-contagem-3'));
    await settle();
    clock.advance(TIMEOUT_MS);
    await settle();
    expect(call.settled).toBe(true);

    const families = await scrapeMetrics(telemetry);
    expect(
      histogramCount(families, DURATION, {
        'casecellshop.erp.operation': 'count_invoices',
        'casecellshop.erp.outcome': 'transient',
      }),
    ).toBe(1);
    const sum = families
      .get('casecellshop_erp_client_operation_duration')
      ?.samples.find(
        (sample) =>
          sample.name === 'casecellshop_erp_client_operation_duration_sum' &&
          sample.labels['casecellshop_erp_operation'] === 'count_invoices',
      )?.value;
    expect(sum).toBe(TIMEOUT_MS / 1000);
  });
});
