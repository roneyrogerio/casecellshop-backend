import { createServer } from 'node:http';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import request from 'supertest';
import type { Meter, ObservableGauge } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { MetricSpec } from './telemetry-catalog.ts';
import { createInstruments, metricsOf } from './telemetry-instruments.ts';
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

  // O requisito é que o callback removido deixe de ser chamado no scrape. Se o /metrics ainda mostra o último valor da
  // série (o exportador do Prometheus é cumulativo), é detalhe do SDK e não é afirmado aqui.
  it('OBS-07 a função devolvida remove só o callback dela: ele deixa de ser chamado nos scrapes seguintes e o de outro callback segue', async () => {
    const { telemetry, metrics } = newMetrics();
    let billingCalls = 0;
    let dlqCalls = 0;
    const removeBilling = metrics.observe(QUEUE, (observe) => {
      billingCalls += 1;
      observe(4, { 'casecellshop.queue.name': 'billing' });
    });
    metrics.observe(QUEUE, (observe) => {
      dlqCalls += 1;
      observe(2, { 'casecellshop.queue.name': 'dlq' });
    });
    expect(reading(await scrape(telemetry), QUEUE_PROM, BILLING)).toBe(4);
    expect([billingCalls, dlqCalls]).toEqual([1, 1]);

    removeBilling();

    const after = await scrape(telemetry);
    await scrape(telemetry);
    expect(billingCalls, 'o callback removido').toBe(1);
    expect(dlqCalls, 'o callback de outro registro').toBe(3);
    expect(reading(after, QUEUE_PROM, DLQ)).toBe(2);
  });

  it('OBS-07 remover duas vezes não derruba nem remove o callback dos outros', async () => {
    const { telemetry, metrics } = newMetrics();
    let reservedCalls = 0;
    let queueCalls = 0;
    const remove = metrics.observe(RESERVED, (observe) => {
      reservedCalls += 1;
      observe(1);
    });
    metrics.observe(QUEUE, (observe) => {
      queueCalls += 1;
      observe(3, { 'casecellshop.queue.name': 'billing' });
    });
    expect(reading(await scrape(telemetry), RESERVED_PROM)).toBe(1);

    remove();
    remove();

    const text = await scrape(telemetry);
    expect(reservedCalls, 'o callback removido').toBe(1);
    expect(queueCalls, 'o callback de outro gauge').toBe(2);
    expect(reading(text, QUEUE_PROM, BILLING)).toBe(3);
  });

  // O SDK de JavaScript, com a temporalidade cumulativa do exportador Prometheus, segue exportando o último valor de
  // um gauge cujo callback falhou. O que o /metrics mostra da série depois da falha é detalhe do SDK e não é afirmado:
  // o que `observe` garante é que o `onError` é avisado e que o callback segue rejeitando.
  it('OBS-07 um callback que lança chama o onError uma vez por scrape com o erro, e o scrape responde com os outros gauges', async () => {
    const { telemetry, metrics } = newMetrics();
    const failure = new Error('banco indisponível');
    const errors: unknown[] = [];
    metrics.observe(
      RESERVED,
      () => {
        throw failure;
      },
      { onError: (error) => errors.push(error) },
    );
    metrics.observe(QUEUE, (observe) =>
      observe(6, { 'casecellshop.queue.name': 'billing' }),
    );

    const first = await scrape(telemetry);
    expect(errors).toEqual([failure]);
    await scrape(telemetry);

    expect(errors, 'uma chamada por falha').toEqual([failure, failure]);
    expect(reading(first, QUEUE_PROM, BILLING)).toBe(6);
  });

  it('OBS-07 um callback assíncrono que rejeita chama o onError, e a leitura seguinte volta a funcionar sem chamá-lo', async () => {
    const run = await failingThenGood((metrics, read, onError) =>
      metrics.observe(
        RESERVED,
        async (observe) => {
          await read();
          observe(3);
        },
        { onError },
      ),
    );

    expect(run.errorsAfterFailure).toBe(1);
    expect(reading(run.up, RESERVED_PROM)).toBe(3);
    expect(run.errorsAfterRecovery, 'a leitura boa não chama o onError').toBe(
      1,
    );
  });

  it('OBS-07 o onError é opcional: sem ele os callbacks, simples e em lote, que falham não derrubam o scrape', async () => {
    const { telemetry, metrics } = newMetrics();
    const reads: string[] = [];
    metrics.observe(RESERVED, () => {
      reads.push('observe');
      throw new Error('banco indisponível');
    });
    metrics.observeBatch([QUEUE], () => {
      reads.push('observeBatch');
      throw new Error('banco indisponível');
    });

    await scrape(telemetry);

    expect(reads.sort()).toEqual(['observe', 'observeBatch']);
  });

  // O SDK captura a rejeição do callback; para vê-la, o teste pega o callback que `observe` registrou no gauge do
  // próprio `Meter` (os `vi.spyOn` abaixo seguem para a implementação real) e o chama como o SDK chama.
  it('OBS-07 o callback registrado avisa o onError e depois segue rejeitando com o mesmo erro, para o SDK tratar a falha', async () => {
    const { telemetry } = newMetrics();
    const meter = telemetry.meter('test.rejection');
    const created = vi.spyOn(meter, 'createObservableGauge');
    const metrics = createInstruments(meter, SPECS);
    const gauge = gaugeCreated(created, 1);
    const registered = vi.spyOn(gauge, 'addCallback');
    const failure = new Error('banco indisponível');
    const order: string[] = [];
    metrics.observe(RESERVED, () => Promise.reject(failure), {
      onError: () => order.push('onError'),
    });
    const callback = registered.mock.calls[0]?.[0];
    if (!callback) throw new Error('o callback não foi registrado no gauge');

    await expectRejectionAfterOnError(
      () => callback({ observe: () => undefined }),
      failure,
      order,
    );
  });

  it('OBS-07 o callback registrado que lê com sucesso grava o valor e não chama o onError', async () => {
    const { telemetry } = newMetrics();
    const meter = telemetry.meter('test.success');
    const created = vi.spyOn(meter, 'createObservableGauge');
    const metrics = createInstruments(meter, SPECS);
    const gauge = gaugeCreated(created, 1);
    const registered = vi.spyOn(gauge, 'addCallback');
    const onError = vi.fn<(error: unknown) => void>();
    metrics.observe(RESERVED, (observe) => observe(9), { onError });
    const callback = registered.mock.calls[0]?.[0];
    if (!callback) throw new Error('o callback não foi registrado no gauge');
    const written: number[] = [];

    await callback({ observe: (value) => written.push(value) });

    expect(written).toEqual([9]);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('OBS-07 observeBatch: a leitura em lote que falha avisa o onError', () => {
  it('OBS-07 o callback em lote que rejeita chama o onError, e a leitura seguinte volta a funcionar sem chamá-lo', async () => {
    const run = await failingThenGood((metrics, read, onError) =>
      metrics.observeBatch(
        [RESERVED, QUEUE],
        async (observe) => {
          await read();
          observe[RESERVED](5);
          observe[QUEUE](2, { 'casecellshop.queue.name': 'dlq' });
        },
        { onError },
      ),
    );

    expect(run.errorsAfterFailure).toBe(1);
    expect(reading(run.up, RESERVED_PROM)).toBe(5);
    expect(reading(run.up, QUEUE_PROM, DLQ)).toBe(2);
    expect(run.errorsAfterRecovery, 'a leitura boa não chama o onError').toBe(
      1,
    );
  });

  it('OBS-07 o callback em lote registrado avisa o onError e depois segue rejeitando com o mesmo erro', async () => {
    const { telemetry } = newMetrics();
    const meter = telemetry.meter('test.batch');
    const registered = vi.spyOn(meter, 'addBatchObservableCallback');
    const metrics = createInstruments(meter, SPECS);
    const failure = new Error('banco indisponível');
    const order: string[] = [];
    metrics.observeBatch(
      [RESERVED, QUEUE],
      () => {
        throw failure;
      },
      { onError: () => order.push('onError') },
    );
    const callback = registered.mock.calls[0]?.[0];
    if (!callback) throw new Error('o callback não foi registrado no meter');

    await expectRejectionAfterOnError(
      () => callback({ observe: () => undefined }),
      failure,
      order,
    );
  });
});

// Um scrape com a leitura falhando e outro com ela boa, para o `register` ligar o callback do teste (simples ou em
// lote) ao `read` e ao `onError`. Devolve quantos erros o `onError` recebeu depois de cada scrape.
async function failingThenGood(
  register: (
    metrics: ReturnType<typeof newMetrics>['metrics'],
    read: () => Promise<void>,
    onError: (error: unknown) => void,
  ) => void,
) {
  const { telemetry, metrics } = newMetrics();
  let failing = true;
  const errors: unknown[] = [];
  register(
    metrics,
    async () => {
      await Promise.resolve();
      if (failing) throw new Error('banco indisponível');
    },
    (error) => errors.push(error),
  );

  await scrape(telemetry);
  const errorsAfterFailure = errors.length;
  failing = false;
  const up = await scrape(telemetry);
  return { errorsAfterFailure, errorsAfterRecovery: errors.length, up };
}

// O callback que o SDK chama avisa o `onError` e só então rejeita, com o mesmo erro.
async function expectRejectionAfterOnError(
  call: () => void | Promise<void>,
  failure: Error,
  order: string[],
): Promise<void> {
  const rejection = await rejectionOf(() => {
    order.push('chamada');
    return call();
  });

  expect(rejection).toBe(failure);
  expect(order).toEqual(['chamada', 'onError']);
}

// O gauge que o `Meter` devolveu na `index`-ésima criação (a ordem das declarações de SPECS).
function gaugeCreated(
  created: MockInstance<Meter['createObservableGauge']>,
  index: number,
): ObservableGauge {
  const result = created.mock.results[index];
  if (result?.type !== 'return')
    throw new Error('o gauge não foi criado pelo Meter');
  return result.value;
}

// A rejeição (ou o `throw` síncrono) de uma chamada, ou `undefined` se ela terminar bem.
async function rejectionOf(call: () => void | Promise<void>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
}
