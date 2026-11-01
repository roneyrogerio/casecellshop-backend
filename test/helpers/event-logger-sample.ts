import { repoRoot } from './repo-root.ts';
import {
  expectSampleCompiles,
  expectSampleTypeError,
} from './sample-type-error.ts';

// OBS-07 (AD-029): amostras para o tsc do projeto sobre o `eventLogger` tipado. Um erro de tipo não se prova por
// execução. `imports` traz a declaração dos eventos (escrita na amostra, ou a real de uma pasta, como
// `HTTP_LOG_EVENTS`), `specs` é a expressão dela, e `calls` são as chamadas a `log`. A amostra de uma pasta mora
// no teste dessa pasta, porque um teste de `shared/` não pode importar uma pasta de negócio (AD-025).
export interface SampleCase {
  imports: string;
  specs: string;
  calls: string;
}

function eventLoggerSample({ imports, specs, calls }: SampleCase): string {
  return `import { pino } from 'pino';
import { eventLogger } from '${repoRoot}/src/shared/logging.ts';
import type { LogEventSpec } from '${repoRoot}/src/shared/telemetry-catalog.ts';
${imports}

const log = eventLogger(pino(), ${specs});
${calls}
`;
}

export function expectLogCompiles(sample: SampleCase): void {
  expectSampleCompiles('obs07-log-tsc-', eventLoggerSample(sample));
}

// O culpado do erro é o evento, o nível ou o campo fora da declaração.
export function expectLogTypeError(
  sample: SampleCase,
  expected: { code: string; text: string },
): void {
  expectSampleTypeError('obs07-log-tsc-', eventLoggerSample(sample), expected);
}
