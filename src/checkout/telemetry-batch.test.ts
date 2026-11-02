import { afterAll, describe, it } from 'vitest';
import { cleanupTempDirs } from '../../test/helpers/git-sandbox.ts';
import {
  expectCompiles,
  metricsSample,
} from '../../test/helpers/metrics-sample.ts';
import { expectSampleTypeError } from '../../test/helpers/sample-type-error.ts';

// OBS-07 (AD-029): `observeBatch` só aceita gravar os gauges que o lote pediu. A amostra mora no checkout porque ele
// declara dois gauges sem atributos: com os dois iguais em tudo, menos o nome, a recusa do tsc só pode vir do nome
// (com um gauge com atributo, o tsc reportaria a aridade da gravação e não o nome).

afterAll(cleanupTempDirs);

const RESERVED = 'casecellshop.inventory.reserved';
const OVERSOLD = 'casecellshop.inventory.oversold_skus';

describe('OBS-07 nome gravado no callback em lote dos gauges', () => {
  it('OBS-07 gravar um gauge que o lote pediu compila: o controle da reprovação por nome', () => {
    expectCompiles(
      'checkout',
      'checkoutMetrics',
      `metrics.observeBatch(['${RESERVED}'], (observe) => {
  observe('${RESERVED}', 1);
});`,
    );
  }, 60_000);

  it('OBS-07 observar um gauge declarado mas fora da lista pedida reprova no tsc, e o erro cita o nome', () => {
    expectSampleTypeError(
      'obs07-tsc-',
      metricsSample(
        'checkout',
        'checkoutMetrics',
        `metrics.observeBatch(['${RESERVED}'], (observe) => {
  observe('${OVERSOLD}', 1);
});`,
      ),
      { code: 'TS2345', text: OVERSOLD },
    );
  }, 60_000);
});
