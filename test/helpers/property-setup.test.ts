import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureProperties,
  DEFAULT_NUM_RUNS,
  DEFAULT_SEED,
  readPropertyConfig,
} from './property-setup.ts';

// O arquivo é importado direto, sem depender de o vitest.config.ts já o ligar como setupFiles.
afterEach(() => {
  fc.resetConfigureGlobal();
});

describe('FND-15 configuração da semente e do número de casos', () => {
  it('FND-15 sem variáveis no ambiente vale a semente fixa e 100 casos', () => {
    expect(readPropertyConfig({})).toEqual({
      seed: DEFAULT_SEED,
      numRuns: DEFAULT_NUM_RUNS,
    });
    expect(DEFAULT_NUM_RUNS).toBe(100);
  });

  it('FND-15 variável vazia vale o padrão, como a expressão do CI sem valor', () => {
    expect(
      readPropertyConfig({ FAST_CHECK_SEED: '', FAST_CHECK_NUM_RUNS: '  ' }),
    ).toEqual({ seed: DEFAULT_SEED, numRuns: DEFAULT_NUM_RUNS });
  });

  it('FND-15 lê a semente e o número de casos do ambiente', () => {
    expect(
      readPropertyConfig({
        FAST_CHECK_SEED: '-12345',
        FAST_CHECK_NUM_RUNS: '1000',
      }),
    ).toEqual({ seed: -12345, numRuns: 1000 });
  });

  it.each([
    { name: 'FAST_CHECK_SEED', value: 'abc' },
    { name: 'FAST_CHECK_SEED', value: '1.5' },
    { name: 'FAST_CHECK_SEED', value: '1e3' },
    { name: 'FAST_CHECK_SEED', value: '99999999999999999999' },
    { name: 'FAST_CHECK_NUM_RUNS', value: 'muitos' },
    { name: 'FAST_CHECK_NUM_RUNS', value: '0' },
    { name: 'FAST_CHECK_NUM_RUNS', value: '-5' },
    { name: 'FAST_CHECK_NUM_RUNS', value: '10.5' },
  ])(
    'FND-15 $name=$value lança com a mensagem que diz qual variável está errada',
    ({ name, value }) => {
      expect(() => readPropertyConfig({ [name]: value })).toThrow(
        new RegExp(`${name} inválida: "${value}"`),
      );
    },
  );

  it('FND-15 o valor inválido não cai no padrão em silêncio, nem ao configurar', () => {
    expect(() => configureProperties({ FAST_CHECK_NUM_RUNS: 'x' })).toThrow(
      /FAST_CHECK_NUM_RUNS inválida/,
    );
    expect(fc.readConfigureGlobal().numRuns).toBeUndefined();
  });

  it('FND-15 configureProperties grava a semente e o número de casos no fast-check', () => {
    const config = configureProperties({
      FAST_CHECK_SEED: '42',
      FAST_CHECK_NUM_RUNS: '7',
    });

    expect(config).toEqual({ seed: 42, numRuns: 7 });
    expect(fc.readConfigureGlobal()).toMatchObject({ seed: 42, numRuns: 7 });
    const details = fc.check(fc.property(fc.nat(), () => true));
    expect(details.numRuns).toBe(7);
    expect(details.seed).toBe(42);
  });

  it('FND-15 a mesma semente repete os mesmos casos', () => {
    function sample(): number[] {
      const seen: number[] = [];
      configureProperties({ FAST_CHECK_SEED: '20', FAST_CHECK_NUM_RUNS: '5' });
      fc.assert(
        fc.property(fc.integer(), (value) => {
          seen.push(value);
        }),
      );
      return seen;
    }

    const first = sample();
    expect(first).toHaveLength(5);
    expect(sample()).toEqual(first);
  });

  it('FND-15 uma propriedade que falha imprime a semente e o caminho para reproduzir', () => {
    configureProperties({ FAST_CHECK_SEED: '42', FAST_CHECK_NUM_RUNS: '50' });

    const failure = (): void =>
      fc.assert(fc.property(fc.nat(), (value) => value < 10));

    expect(failure).toThrow(/seed: 42/);
    expect(failure).toThrow(/path: "/);
  });
});
