import * as fc from 'fast-check';

// FND-15: configuração global do fast-check para o projeto `unit`. O vitest.config.ts a liga como `setupFiles`,
// então ela roda antes de cada arquivo de teste. No PR a semente é fixa e o número de casos é o padrão; o agendado
// passa a semente da execução e mais casos pelo ambiente, e uma falha imprime a semente e o caminho do contraexemplo
// (o fast-check já o faz na mensagem do `fc.assert`), para reproduzir com os mesmos valores.

export const DEFAULT_SEED = 20261101;
export const DEFAULT_NUM_RUNS = 100;

export interface PropertyConfig {
  seed: number;
  numRuns: number;
}

type Env = Record<string, string | undefined>;

// Variável ausente ou vazia vale o padrão (uma expressão do CI sem valor chega vazia); o resto tem de ser inteiro.
function readInteger(
  env: Env,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(
      `${name} inválida: "${raw}" não é um inteiro${min > Number.MIN_SAFE_INTEGER ? ` maior ou igual a ${min}` : ''}`,
    );
  }
  return value;
}

export function readPropertyConfig(env: Env = process.env): PropertyConfig {
  return {
    seed: readInteger(
      env,
      'FAST_CHECK_SEED',
      DEFAULT_SEED,
      Number.MIN_SAFE_INTEGER,
    ),
    numRuns: readInteger(env, 'FAST_CHECK_NUM_RUNS', DEFAULT_NUM_RUNS, 1),
  };
}

export function configureProperties(env: Env = process.env): PropertyConfig {
  const config = readPropertyConfig(env);
  fc.configureGlobal({ seed: config.seed, numRuns: config.numRuns });
  return config;
}

configureProperties();
