import { repoRoot } from './repo-root.ts';
import {
  expectSampleCompiles,
  expectSampleTypeError,
} from './sample-type-error.ts';

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

export function expectCompiles(
  folder: string,
  accessor: string,
  calls: string,
): void {
  expectSampleCompiles('obs07-tsc-', metricsSample(folder, accessor, calls));
}

export function expectTypeError(
  folder: string,
  accessor: string,
  calls: string,
  expected: { code: string; text: string },
): void {
  expectSampleTypeError(
    'obs07-tsc-',
    metricsSample(folder, accessor, calls),
    expected,
  );
}
