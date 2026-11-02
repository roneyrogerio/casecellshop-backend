import { expect } from 'vitest';
import { typecheckSample } from './lint-tree.ts';

// OBS-07 (AD-029): a conferência comum das amostras para o tsc do projeto (metrics-sample.ts e
// event-logger-sample.ts). O erro de tipo não se prova por execução, e a amostra de controle prova que a
// reprovação das outras vem do erro que elas têm e não de uma amostra quebrada.

// A amostra de controle: o tsc a aceita sem uma linha de saída.
export function expectSampleCompiles(prefix: string, source: string): void {
  const result = typecheckSample(prefix, source);
  expect(result.output).toBe('');
  expect(result.status).toBe(0);
}

// A amostra reprovada pelo erro esperado: o código do TypeScript e o trecho do texto que nomeia o culpado.
export function expectSampleTypeError(
  prefix: string,
  source: string,
  expected: { code: string; text: string },
): void {
  const result = typecheckSample(prefix, source);
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBeNull();
  expect(result.output).toContain('amostra.ts');
  // O erro tem de ser o da gravação ou da chamada, e não o de um acessor ou de um módulo que falta.
  expect(result.output).not.toContain('has no exported member');
  expect(result.output).not.toContain('Cannot find module');
  expect(result.output).toContain(`error ${expected.code}`);
  expect(result.output).toContain(expected.text);
}
