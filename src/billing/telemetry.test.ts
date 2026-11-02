import { afterAll, describe, it } from 'vitest';
import { cleanupTempDirs } from '../../test/helpers/git-sandbox.ts';
import {
  expectCompiles,
  expectTypeError,
} from '../../test/helpers/metrics-sample.ts';

// OBS-07 (AD-029): a gravação das métricas do faturamento é tipada pela declaração (`BILLING_METRICS`). O nome é
// uma chave dela, o instrumento decide se é `add` ou `record`, e os atributos só aceitam as chaves e os valores
// declarados. A prova é o tsc do projeto sobre uma amostra que importa o acessor real.

afterAll(cleanupTempDirs);

const OUTCOME = 'casecellshop.outbox.attempt.outcome';
const ATTEMPTS = 'casecellshop.outbox.attempts';
const DURATION = 'casecellshop.order.accept_to_invoice.duration';

function expectBillingTypeError(
  calls: string,
  expected: { code: string; text: string },
): void {
  expectTypeError('billing', 'billingMetrics', calls, expected);
}

describe('OBS-07 tipo da gravação das métricas do faturamento', () => {
  it('OBS-07 a gravação válida (contador com desfecho, contador sem atributo, histograma) compila: o controle das reprovações', () => {
    expectCompiles(
      'billing',
      'billingMetrics',
      `metrics.add('${ATTEMPTS}', 1, { '${OUTCOME}': 'invoiced' });
metrics.add('casecellshop.outbox.published.messages', 3);
metrics.record('${DURATION}', 2.5);`,
    );
  }, 60_000);

  it('OBS-07 um valor de atributo fora do enum reprova no tsc, e o erro cita o valor', () => {
    expectBillingTypeError(
      `metrics.add('${ATTEMPTS}', 1, { '${OUTCOME}': 'bogus' });`,
      {
        code: 'TS2322',
        text: 'bogus',
      },
    );
  }, 60_000);

  it('OBS-07 um nome de métrica fora da declaração reprova no tsc, e o erro cita o nome', () => {
    expectBillingTypeError(`metrics.add('casecellshop.nao.existe', 1);`, {
      code: 'TS2345',
      text: 'casecellshop.nao.existe',
    });
  }, 60_000);

  it('OBS-07 record num contador reprova no tsc, e o erro cita o contador', () => {
    expectBillingTypeError(
      `metrics.record('${ATTEMPTS}', 1, { '${OUTCOME}': 'invoiced' });`,
      {
        code: 'TS2345',
        text: `Argument of type '"${ATTEMPTS}"'`,
      },
    );
  }, 60_000);

  it('OBS-07 add num histograma reprova no tsc, e o erro cita o histograma', () => {
    expectBillingTypeError(`metrics.add('${DURATION}', 1);`, {
      code: 'TS2345',
      text: `Argument of type '"${DURATION}"'`,
    });
  }, 60_000);

  it('OBS-07 um atributo não declarado reprova no tsc, e o erro cita o atributo', () => {
    expectBillingTypeError(
      `metrics.add('${ATTEMPTS}', 1, { '${OUTCOME}': 'invoiced', 'casecellshop.nao.declarado': 'x' });`,
      { code: 'TS2353', text: 'casecellshop.nao.declarado' },
    );
  }, 60_000);

  it('OBS-07 um atributo numa métrica sem atributos declarados reprova no tsc', () => {
    expectBillingTypeError(
      `metrics.add('casecellshop.outbox.published.messages', 1, { '${OUTCOME}': 'invoiced' });`,
      { code: 'TS2345', text: OUTCOME },
    );
  }, 60_000);
});
