import { createServer } from 'node:http';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricSpec } from './telemetry-catalog.ts';
import { metricsOf } from './telemetry-instruments.ts';
import { createTelemetry, type Telemetry } from './telemetry.ts';

// OBS-07 (AD-029): `observe` registra o callback que o scrape chama para ler um gauge, com os atributos da declaração,
// e devolve a função que o remove (as métricas de fila e de estoque do M5 dependem dele).

const SPECS = {
  'casecellshop.queue.messages': {
    instrument: 'gauge',
    unit: '{message}',
    description: 'Mensagens por fila.',
    attributes: {
      'casecellshop.queue.name': {
        description: 'Fila.',
        requirement: 'required',
        values: { kind: 'enum', values: ['billing', 'dlq'] },
      },
    },
  },
  'casecellshop.inventory.reserved': {
    instrument: 'gauge',
    unit: '{unit}',
    description: 'Unidades reservadas.',
    attributes: {},
  },
} as const satisfies Record<string, MetricSpec>;

const QUEUE = 'casecellshop.queue.messages';
const RESERVED = 'casecellshop.inventory.reserved';
const QUEUE_PROM = 'casecellshop_queue_messages';
const RESERVED_PROM = 'casecellshop_inventory_reserved';

const telemetries: Telemetry[] = [];

afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

function newMetrics() {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  return { telemetry, metrics: metricsOf(telemetry, 'test.scope', SPECS) };
}

// O texto do /metrics como o Prometheus o recebe. Um teste de `shared/` não importa os helpers de `test/` (AD-025).
async function scrape(telemetry: Telemetry): Promise<string> {
  const server = createServer((req, res) => telemetry.metricsHandler(req, res));
  const res = await request(server).get('/metrics');
  expect(res.status).toBe(200);
  return res.text;
}

// Os labels de uma série, sem os do escopo, que o exportador acrescenta a toda série.
function labelsOf(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const label of text.matchAll(
    /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
  )) {
    const [, key, value] = label;
    if (key?.startsWith('otel_scope') === false && value !== undefined)
      found[key] = value;
  }
  return found;
}

function sameLabels(
  found: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  return (
    Object.keys(found).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => found[key] === value)
  );
}

// O valor da série com exatamente estes labels.
function reading(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(
      line,
    );
    if (match?.[1] === name && sameLabels(labelsOf(match[2] ?? ''), labels))
      return Number(match[3]);
  }
  return undefined;
}

const BILLING = { casecellshop_queue_name: 'billing' };
const DLQ = { casecellshop_queue_name: 'dlq' };

describe('OBS-07 observe: o callback do gauge é lido no scrape', () => {
  it('OBS-07 o valor do callback sai no /metrics com os atributos da gravação, e o gauge sem atributos sai sem label', async () => {
    const { telemetry, metrics } = newMetrics();
    metrics.observe(QUEUE, (observe) => {
      observe(4, { 'casecellshop.queue.name': 'billing' });
      observe(2, { 'casecellshop.queue.name': 'dlq' });
    });
    metrics.observe(RESERVED, (observe) => observe(9));

    const text = await scrape(telemetry);

    expect(text).toContain(`# TYPE ${QUEUE_PROM} gauge`);
    expect(reading(text, QUEUE_PROM, BILLING)).toBe(4);
    expect(reading(text, QUEUE_PROM, DLQ)).toBe(2);
    expect(reading(text, RESERVED_PROM)).toBe(9);
  });

  it('OBS-07 o callback é chamado a cada scrape e o valor acompanha o estado de cada leitura', async () => {
    const { telemetry, metrics } = newMetrics();
    let reserved = 1;
    let reads = 0;
    metrics.observe(RESERVED, (observe) => {
      reads += 1;
      observe(reserved);
    });

    const first = await scrape(telemetry);
    reserved = 7;
    const second = await scrape(telemetry);

    expect(reading(first, RESERVED_PROM)).toBe(1);
    expect(reading(second, RESERVED_PROM)).toBe(7);
    expect(reads).toBe(2);
  });

  it('OBS-07 o scrape espera o callback assíncrono antes de escrever o valor', async () => {
    const { telemetry, metrics } = newMetrics();
    metrics.observe(RESERVED, async (observe) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      observe(5);
    });

    const text = await scrape(telemetry);

    expect(reading(text, RESERVED_PROM)).toBe(5);
  });

  it('OBS-07 sem callback registrado o gauge não tem série', async () => {
    const { telemetry } = newMetrics();

    const text = await scrape(telemetry);

    expect(reading(text, RESERVED_PROM)).toBeUndefined();
  });

  it('OBS-07 a função devolvida remove só o callback dela: a série some e a de outro callback segue', async () => {
    const { telemetry, metrics } = newMetrics();
    const removeBilling = metrics.observe(QUEUE, (observe) =>
      observe(4, { 'casecellshop.queue.name': 'billing' }),
    );
    metrics.observe(QUEUE, (observe) =>
      observe(2, { 'casecellshop.queue.name': 'dlq' }),
    );
    expect(reading(await scrape(telemetry), QUEUE_PROM, BILLING)).toBe(4);

    removeBilling();

    const after = await scrape(telemetry);
    expect(reading(after, QUEUE_PROM, BILLING)).toBeUndefined();
    expect(reading(after, QUEUE_PROM, DLQ)).toBe(2);
  });

  it('OBS-07 remover duas vezes não derruba nem remove o callback dos outros', async () => {
    const { telemetry, metrics } = newMetrics();
    const remove = metrics.observe(RESERVED, (observe) => observe(1));
    metrics.observe(QUEUE, (observe) =>
      observe(3, { 'casecellshop.queue.name': 'billing' }),
    );
    expect(reading(await scrape(telemetry), RESERVED_PROM)).toBe(1);

    remove();
    remove();

    const text = await scrape(telemetry);
    expect(reading(text, RESERVED_PROM)).toBeUndefined();
    expect(reading(text, QUEUE_PROM, BILLING)).toBe(3);
  });

  it('OBS-07 um callback que lança deixa só a série dele sem valor naquele scrape: o scrape responde e os outros gauges saem', async () => {
    const { telemetry, metrics } = newMetrics();
    metrics.observe(RESERVED, () => {
      throw new Error('banco indisponível');
    });
    metrics.observe(QUEUE, (observe) =>
      observe(6, { 'casecellshop.queue.name': 'billing' }),
    );

    const text = await scrape(telemetry);

    expect(reading(text, RESERVED_PROM)).toBeUndefined();
    expect(reading(text, QUEUE_PROM, BILLING)).toBe(6);
  });

  it('OBS-07 um callback assíncrono que rejeita deixa a série sem valor naquele scrape, e a leitura seguinte volta a funcionar', async () => {
    const { telemetry, metrics } = newMetrics();
    let failing = true;
    metrics.observe(RESERVED, async (observe) => {
      await Promise.resolve();
      if (failing) throw new Error('banco indisponível');
      observe(3);
    });

    const down = await scrape(telemetry);
    failing = false;
    const up = await scrape(telemetry);

    expect(reading(down, RESERVED_PROM)).toBeUndefined();
    expect(reading(up, RESERVED_PROM)).toBe(3);
  });
});
