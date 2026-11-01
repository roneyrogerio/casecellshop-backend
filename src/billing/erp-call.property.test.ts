import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  expectFalsified,
  expectProperty,
} from '../../test/helpers/properties.ts';
import {
  retrySeconds,
  type CallContext,
  type CallSettings,
} from './erp-call.ts';

// FND-15, "Novo prazo do faturamento": o prazo da volta à fila é inteiro e fica entre o atraso mínimo e o atraso
// mínimo mais o teto do backoff, em segundos arredondados para cima.

type RetrySeconds = (ctx: CallContext, attempt: number) => number;

// A função só lê `settings` e `random`; o resto do contexto (banco, ERP, relógio) não participa do cálculo.
function contextOf(settings: CallSettings, random: number): CallContext {
  return { settings, random: () => random } as CallContext;
}

const settingsArb: fc.Arbitrary<CallSettings> = fc
  .record({
    minDelayMs: fc.integer({ min: 0, max: 600_000 }),
    erpTimeoutMs: fc.integer({ min: 0, max: 60_000 }),
    leaseMarginMs: fc.integer({ min: 0, max: 60_000 }),
    backoffBaseMs: fc.integer({ min: 1, max: 600_000 }),
    capExtraMs: fc.integer({ min: 0, max: 3_600_000 }),
  })
  .map(({ capExtraMs, ...rest }) => ({
    ...rest,
    backoffCapMs: rest.backoffBaseMs + capExtraMs,
  }));

// O sorteio em [0, 1): os extremos entram de propósito, porque é na borda que o arredondamento erra.
const LARGEST_BELOW_ONE = 1 - 2 ** -53;
const randomArb = fc.oneof(
  fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
  fc.constant(0),
  fc.constant(LARGEST_BELOW_ONE),
);

// Inclui tentativas enormes: 2 ** (attempt - 1) estoura para Infinity e o teto tem de segurar.
const attemptArb = fc.oneof(
  fc.integer({ min: 1, max: 20 }),
  fc.integer({ min: 1, max: 100_000 }),
);

function boundsHold(candidate: RetrySeconds) {
  return fc.property(
    settingsArb,
    randomArb,
    attemptArb,
    (settings, random, attempt) => {
      const seconds = candidate(contextOf(settings, random), attempt);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(
        Math.ceil(settings.minDelayMs / 1000),
      );
      expect(seconds).toBeLessThanOrEqual(
        Math.ceil((settings.minDelayMs + settings.backoffCapMs) / 1000),
      );
    },
  );
}

// Versões quebradas de retrySeconds, escritas aqui: cada opção desliga uma parte da fórmula do módulo.
function brokenRetrySeconds(
  options: {
    round?: (ms: number) => number;
    capped?: boolean;
    withMinDelay?: boolean;
  } = {},
): RetrySeconds {
  const {
    round = (ms) => Math.ceil(ms / 1000),
    capped = true,
    withMinDelay = true,
  } = options;
  return ({ settings, random }, attempt) => {
    const exponential = settings.backoffBaseMs * 2 ** (attempt - 1);
    const ceiling = capped
      ? Math.min(settings.backoffCapMs, exponential)
      : exponential;
    return round((withMinDelay ? settings.minDelayMs : 0) + random() * ceiling);
  };
}

describe('FND-15 retrySeconds', () => {
  it('FND-15 o prazo é inteiro e fica entre o atraso mínimo e o atraso mínimo mais o teto, para qualquer tentativa e sorteio', () => {
    expectProperty(boundsHold(retrySeconds));
  });

  it('FND-15 o sorteio 0 dá exatamente o atraso mínimo em segundos para cima', () => {
    expectProperty(
      fc.property(settingsArb, attemptArb, (settings, attempt) => {
        expect(retrySeconds(contextOf(settings, 0), attempt)).toBe(
          Math.ceil(settings.minDelayMs / 1000),
        );
      }),
    );
  });

  it.each([
    {
      defect: 'sem o Math.ceil, o prazo sai fracionário',
      broken: brokenRetrySeconds({ round: (ms) => ms / 1000 }),
    },
    {
      defect: 'com Math.floor, o prazo cai abaixo do atraso mínimo',
      broken: brokenRetrySeconds({ round: (ms) => Math.floor(ms / 1000) }),
    },
    {
      defect: 'sem o teto do backoff, o prazo passa do limite',
      broken: brokenRetrySeconds({ capped: false }),
    },
    {
      defect: 'sem o atraso mínimo, o prazo cai abaixo dele',
      broken: brokenRetrySeconds({ withMinDelay: false }),
    },
  ])(
    'FND-15 controle negativo: a mesma propriedade reprova a versão $defect',
    ({ broken }) => {
      expectFalsified(boundsHold(broken));
    },
  );
});
