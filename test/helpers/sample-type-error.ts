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

interface ExpectedTypeError {
  // Um código, ou os que o tipo pode dar conforme a forma do erro (o campo a mais, por exemplo).
  code: string | readonly string[];
  // O trecho (ou o padrão) que nomeia o culpado; com uma lista, cada item tem de aparecer.
  text: string | RegExp | readonly (string | RegExp)[];
}

// A amostra reprovada pelo erro esperado: o código do TypeScript e o trecho do texto que nomeia o culpado.
export function expectSampleTypeError(
  prefix: string,
  source: string,
  expected: ExpectedTypeError,
): void {
  const result = typecheckSample(prefix, source);
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBeNull();
  expect(result.output).toContain('amostra.ts');
  // O erro tem de ser o da gravação ou da chamada, e não o de um acessor ou de um módulo que falta.
  expect(result.output).not.toContain('has no exported member');
  expect(result.output).not.toContain('Cannot find module');
  const codes = [expected.code].flat();
  expect(
    codes.some((code) => result.output.includes(`error ${code}`)),
    `nenhum de ${codes.join(', ')} na saída:\n${result.output}`,
  ).toBe(true);
  for (const text of [expected.text].flat()) {
    if (typeof text === 'string') expect(result.output).toContain(text);
    else expect(result.output).toMatch(text);
  }
}
