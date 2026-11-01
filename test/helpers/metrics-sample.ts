import { expect } from 'vitest';
import { typecheckSample } from './lint-tree.ts';
import { repoRoot } from './repo-root.ts';

// OBS-07 (AD-029): amostras para o tsc do projeto sobre o acessor tipado de uma pasta (`httpMetrics`,
// `billingMetrics`). Um erro de tipo não se prova por execução, e a amostra mora na pasta da declaração
// usada, porque um teste de `shared/` não pode importar uma pasta de negócio (AD-025).

// A amostra importa o acessor real da pasta e o `Telemetry` real; `calls` são as gravações em `metrics`.
export function metricsSample(
  folder: string,
  accessor: string,
  calls: string,
): string {
  return `import { ${accessor} } from '${repoRoot}/src/${folder}/telemetry.ts';
import { createTelemetry } from '${repoRoot}/src/shared/telemetry.ts';

const metrics = ${accessor}(createTelemetry());
${calls}
`;
}

// A amostra de controle: o tsc a aceita sem uma linha de saída, o que prova que a reprovação das outras vem do
// erro que elas têm e não de uma amostra quebrada.
export function expectCompiles(
  folder: string,
  accessor: string,
  calls: string,
): void {
  const result = typecheckSample(
    'obs07-tsc-',
    metricsSample(folder, accessor, calls),
  );
  expect(result.output).toBe('');
  expect(result.status).toBe(0);
}

// A amostra reprovada pelo erro esperado: o código do TypeScript e o trecho do texto que nomeia o culpado.
export function expectTypeError(
  folder: string,
  accessor: string,
  calls: string,
  expected: { code: string; text: string },
): void {
  const result = typecheckSample(
    'obs07-tsc-',
    metricsSample(folder, accessor, calls),
  );
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBeNull();
  expect(result.output).toContain('amostra.ts');
  // O erro tem de ser o da gravação, e não o de um acessor ou de um módulo que falta.
  expect(result.output).not.toContain('has no exported member');
  expect(result.output).not.toContain('Cannot find module');
  expect(result.output).toContain(`error ${expected.code}`);
  expect(result.output).toContain(expected.text);
}
