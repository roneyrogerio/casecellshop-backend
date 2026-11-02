import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { Meter, ObservableGauge } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  parseExposition,
  scrapeMetricsText as scrape,
  valueOf,
  type Exposition,
  type Sample,
} from '#test-helpers/metrics.ts';
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
          observe(RESERVED, 5);
          observe(QUEUE, 2, { 'casecellshop.queue.name': 'dlq' });
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

// OBS-08: ao criar os instrumentos, cada counter e UpDownCounter de atributos todos `required` e de lista fechada
// soma 0 uma vez por combinação dos valores, para o `increase()` de um alerta contar o primeiro evento. Estas
// declarações são do teste: cobrem cada forma da regra e cada exclusão.

const ZERO_SPECS = {
  // Sem atributos: uma série só.
  'casecellshop.zero.plain': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter sem atributos.',
    attributes: {},
  },
  // Um atributo enum required: uma série por valor.
  'casecellshop.zero.one_enum': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter com um atributo enum.',
    attributes: {
      'casecellshop.zero.kind': {
        description: 'Tipo.',
        requirement: 'required',
        values: { kind: 'enum', values: ['alpha', 'beta', 'gamma'] },
      },
    },
  },
  // Dois atributos enum required: o produto cartesiano, 2 x 3 = 6 séries.
  'casecellshop.zero.two_enums': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter com dois atributos enum.',
    attributes: {
      'casecellshop.zero.color': {
        description: 'Cor.',
        requirement: 'required',
        values: { kind: 'enum', values: ['red', 'blue'] },
      },
      'casecellshop.zero.size': {
        description: 'Tamanho.',
        requirement: 'required',
        values: { kind: 'enum', values: ['small', 'medium', 'large'] },
      },
    },
  },
  'casecellshop.zero.level': {
    instrument: 'up_down_counter',
    unit: '{item}',
    description: 'UpDownCounter sem atributos.',
    attributes: {},
  },
  'casecellshop.zero.latency': {
    instrument: 'histogram',
    unit: 's',
    description: 'Histograma: a API do OpenTelemetry não cria um vazio.',
    buckets: [1, 2],
    attributes: {},
  },
  'casecellshop.zero.depth': {
    instrument: 'gauge',
    unit: '{item}',
    description: 'Gauge: lido a cada coleta.',
    attributes: {},
  },
  // Lista aberta: não há valores para combinar.
  'casecellshop.zero.by_status': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter com o status HTTP.',
    attributes: {
      'http.response.status_code': {
        description: 'Status.',
        requirement: 'required',
        values: { kind: 'http_status_code' },
      },
    },
  },
  'casecellshop.zero.by_route': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter com a rota.',
    attributes: {
      'http.route': {
        description: 'Rota.',
        requirement: 'required',
        values: { kind: 'http_route' },
      },
    },
  },
  // Um enum required junto de uma lista aberta: a métrica inteira fica de fora.
  'casecellshop.zero.enum_and_route': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter com um enum e a rota.',
    attributes: {
      'casecellshop.zero.kind': {
        description: 'Tipo.',
        requirement: 'required',
        values: { kind: 'enum', values: ['alpha', 'beta'] },
      },
      'http.route': {
        description: 'Rota.',
        requirement: 'required',
        values: { kind: 'http_route' },
      },
    },
  },
  // `conditionally_required`: só vale quando a condição ocorre, e a combinação sem ele é outra série.
  'casecellshop.zero.conditional': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter com um atributo condicional.',
    attributes: {
      'casecellshop.zero.kind': {
        description: 'Tipo.',
        requirement: 'required',
        values: { kind: 'enum', values: ['alpha', 'beta'] },
      },
      'casecellshop.zero.reason': {
        description: 'Motivo, só quando houve erro.',
        requirement: 'conditionally_required',
        values: { kind: 'enum', values: ['timeout', 'refused'] },
      },
    },
  },
  'casecellshop.zero.only_conditional': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Counter só com um atributo condicional.',
    attributes: {
      'casecellshop.zero.reason': {
        description: 'Motivo, só quando houve erro.',
        requirement: 'conditionally_required',
        values: { kind: 'enum', values: ['timeout', 'refused'] },
      },
    },
  },
} as const satisfies Record<string, MetricSpec>;

const PLAIN = 'casecellshop_zero_plain_total';
const ONE_ENUM = 'casecellshop_zero_one_enum_total';
const TWO_ENUMS = 'casecellshop_zero_two_enums_total';
const LEVEL = 'casecellshop_zero_level';
const EXCLUDED = [
  'casecellshop_zero_latency',
  'casecellshop_zero_depth',
  'casecellshop_zero_by_status',
  'casecellshop_zero_by_route',
  'casecellshop_zero_enum_and_route',
  'casecellshop_zero_conditional',
  'casecellshop_zero_only_conditional',
];
const KINDS = ['alpha', 'beta', 'gamma'];
const COLORS = ['red', 'blue'];
const SIZES = ['small', 'medium', 'large'];

function zeroTelemetry(): Telemetry {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  return telemetry;
}

async function exposition(telemetry: Telemetry): Promise<Exposition> {
  return parseExposition(await scrape(telemetry));
}

function seriesOf(families: Exposition, name: string): Sample[] {
  return families.get(name)?.samples ?? [];
}

// Os pares cor e tamanho das séries de `two_enums`, com o valor de cada um.
function twoEnumsValues(families: Exposition): Map<string, number> {
  return new Map(
    seriesOf(families, TWO_ENUMS).map((sample) => [
      `${sample.labels['casecellshop_zero_color']}/${sample.labels['casecellshop_zero_size']}`,
      sample.value,
    ]),
  );
}

const ALL_PAIRS = COLORS.flatMap((color) =>
  SIZES.map((size) => `${color}/${size}`),
);

describe('OBS-08 séries em 0 na criação dos instrumentos, antes de qualquer gravação', () => {
  it('OBS-08 o counter sem atributos sai com uma série em 0 logo depois de criado, sem nenhuma gravação', async () => {
    const telemetry = zeroTelemetry();
    createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);

    const families = await exposition(telemetry);

    expect(families.get(PLAIN)?.type).toBe('counter');
    expect(seriesOf(families, PLAIN)).toHaveLength(1);
    expect(valueOf(families, PLAIN)).toBe(0);
  });

  it('OBS-08 o counter com um atributo enum required sai com uma série em 0 por valor da lista', async () => {
    const telemetry = zeroTelemetry();
    createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);

    const families = await exposition(telemetry);

    expect(seriesOf(families, ONE_ENUM)).toHaveLength(KINDS.length);
    for (const kind of KINDS)
      expect(
        valueOf(families, ONE_ENUM, { casecellshop_zero_kind: kind }),
        `série ${kind}`,
      ).toBe(0);
  });

  it('OBS-08 o counter com dois atributos enum required sai com o produto cartesiano das listas: 2 x 3 = 6 séries em 0', async () => {
    const telemetry = zeroTelemetry();
    createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);

    const values = twoEnumsValues(await exposition(telemetry));

    expect([...values.keys()].sort()).toEqual([...ALL_PAIRS].sort());
    expect([...values.values()]).toEqual(ALL_PAIRS.map(() => 0));
  });

  it('OBS-08 o UpDownCounter sem atributos sai com uma série em 0', async () => {
    const telemetry = zeroTelemetry();
    createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);

    const families = await exposition(telemetry);

    expect(seriesOf(families, LEVEL)).toHaveLength(1);
    expect(valueOf(families, LEVEL)).toBe(0);
  });

  it('OBS-08 histograma, gauge, lista aberta (status HTTP e rota) e atributo conditionally_required ficam sem série, e os counters elegíveis da mesma declaração saem em 0', async () => {
    const telemetry = zeroTelemetry();
    createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);

    const text = await scrape(telemetry);
    const families = parseExposition(text);

    // O controle positivo na mesma leitura: sem ele a exclusão passaria também se nada fosse criado em 0.
    expect(valueOf(families, PLAIN), 'o counter elegível sai em 0').toBe(0);
    for (const name of EXCLUDED)
      expect(text, `${name} não tem série`).not.toContain(name);
  });

  it('OBS-08 a série em 0 não muda a contagem: depois de add(1) com os atributos dela, só ela vale 1 e as outras seguem em 0', async () => {
    const telemetry = zeroTelemetry();
    const metrics = createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);

    metrics.add('casecellshop.zero.two_enums', 1, {
      'casecellshop.zero.color': 'blue',
      'casecellshop.zero.size': 'medium',
    });
    metrics.add('casecellshop.zero.plain', 1);

    const families = await exposition(telemetry);
    const values = twoEnumsValues(families);
    expect(values.size, 'continuam 6 séries, sem uma a mais').toBe(6);
    for (const pair of ALL_PAIRS)
      expect(values.get(pair), `série ${pair}`).toBe(
        pair === 'blue/medium' ? 1 : 0,
      );
    expect(seriesOf(families, PLAIN)).toHaveLength(1);
    expect(valueOf(families, PLAIN)).toBe(1);
    expect(
      valueOf(families, ONE_ENUM, { casecellshop_zero_kind: 'alpha' }),
    ).toBe(0);
  });

  it('OBS-08 o UpDownCounter em 0 acompanha as gravações: add(3) e add(-1) deixam 2', async () => {
    const telemetry = zeroTelemetry();
    const metrics = createInstruments(telemetry.meter('test.zero'), ZERO_SPECS);
    expect(valueOf(await exposition(telemetry), LEVEL), 'antes').toBe(0);

    metrics.add('casecellshop.zero.level', 3);
    metrics.add('casecellshop.zero.level', -1);

    expect(valueOf(await exposition(telemetry), LEVEL)).toBe(2);
  });

  it('OBS-08 metricsOf chamado duas vezes para a mesma telemetria e escopo não duplica as séries nem zera de novo o valor gravado', async () => {
    const telemetry = zeroTelemetry();
    const first = metricsOf(telemetry, 'test.zero.shared', ZERO_SPECS);
    first.add('casecellshop.zero.two_enums', 5, {
      'casecellshop.zero.color': 'red',
      'casecellshop.zero.size': 'large',
    });

    const second = metricsOf(telemetry, 'test.zero.shared', ZERO_SPECS);

    expect(second).toBe(first);
    const values = twoEnumsValues(await exposition(telemetry));
    expect(values.size, 'sem séries duplicadas').toBe(6);
    expect(values.get('red/large')).toBe(5);
    expect(values.get('red/small')).toBe(0);
    expect(valueOf(await exposition(telemetry), PLAIN)).toBe(0);
  });
});
