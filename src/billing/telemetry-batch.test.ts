import { afterAll, describe, it } from 'vitest';
import { cleanupTempDirs } from '../../test/helpers/git-sandbox.ts';
import {
  expectCompiles,
  metricsSample,
} from '../../test/helpers/metrics-sample.ts';
import { expectSampleTypeError } from '../../test/helpers/sample-type-error.ts';

// OBS-07 (AD-029): o callback em lote dos gauges (`observeBatch`) segue o desenho do OpenTelemetry
// (`BatchObservableResult.observe(observable, value, attributes)`): recebe `observe(name, value, ...attributes)`, em que
// `name` é um dos nomes pedidos e os atributos são tipados pela declaração do gauge. A prova é o tsc do projeto sobre
// uma amostra que importa o acessor real do faturamento, o único com um gauge com atributo e outro sem.

afterAll(cleanupTempDirs);

const QUEUE = 'casecellshop.queue.messages';
const QUEUE_NAME = 'casecellshop.queue.name';
const AGE = 'casecellshop.outbox.oldest_pending.age';
const ATTEMPTS = 'casecellshop.outbox.attempts';

function expectBatchTypeError(
  calls: string,
  expected: Parameters<typeof expectSampleTypeError>[2],
): void {
  expectSampleTypeError(
    'obs07-tsc-',
    metricsSample('billing', 'billingMetrics', calls),
    expected,
  );
}

describe('OBS-07 tipo da gravação do callback em lote dos gauges', () => {
  it('OBS-07 a leitura em lote válida (gauge com atributo, gauge sem atributo, onError) compila: o controle das reprovações', () => {
    expectCompiles(
      'billing',
      'billingMetrics',
      `metrics.observeBatch(
  ['${QUEUE}', '${AGE}'],
  (observe) => {
    observe('${QUEUE}', 1, { '${QUEUE_NAME}': 'billing' });
    observe('${QUEUE}', 2, { '${QUEUE_NAME}': 'dlq' });
    observe('${AGE}', 3);
  },
  { onError: () => undefined },
);`,
    );
  }, 60_000);

  it('OBS-07 pedir no lote uma métrica que não é gauge reprova no tsc, e o erro cita o nome', () => {
    expectBatchTypeError(`metrics.observeBatch(['${ATTEMPTS}'], () => {});`, {
      code: ['TS2345', 'TS2322'],
      text: ATTEMPTS,
    });
  }, 60_000);

  it('OBS-07 um valor de atributo fora do enum do gauge reprova no tsc, e o erro cita o valor', () => {
    expectBatchTypeError(
      `metrics.observeBatch(['${QUEUE}'], (observe) => {
  observe('${QUEUE}', 1, { '${QUEUE_NAME}': 'bogus' });
});`,
      { code: ['TS2322', 'TS2345'], text: 'bogus' },
    );
  }, 60_000);

  it('OBS-07 omitir o atributo obrigatório do gauge reprova no tsc', () => {
    expectBatchTypeError(
      `metrics.observeBatch(['${QUEUE}'], (observe) => {
  observe('${QUEUE}', 1);
});`,
      {
        code: ['TS2554', 'TS2345'],
        text: new RegExp(`Expected 3 arguments|${QUEUE_NAME}`),
      },
    );
  }, 60_000);

  it('OBS-07 um atributo num gauge sem atributos declarados reprova no tsc', () => {
    expectBatchTypeError(
      `metrics.observeBatch(['${AGE}'], (observe) => {
  observe('${AGE}', 1, { '${QUEUE_NAME}': 'billing' });
});`,
      {
        code: ['TS2345', 'TS2554'],
        text: new RegExp(`${QUEUE_NAME}|Expected 2 arguments`),
      },
    );
  }, 60_000);
});
