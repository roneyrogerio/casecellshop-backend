import { repoRoot } from './repo-root.ts';
import {
  expectSampleCompiles,
  expectSampleTypeError,
} from './sample-type-error.ts';

// OBS-07 (AD-029): amostras para o tsc do projeto sobre o `eventLogger` tipado. Um erro de tipo não se prova por
// execução. `imports` traz a declaração dos eventos (escrita na amostra, ou a real de uma pasta, como
// `HTTP_LOG_EVENTS`), `specs` é a expressão dela, e `calls` são as chamadas a `log`. A amostra de uma pasta mora
// no teste dessa pasta, porque um teste de `shared/` não pode importar uma pasta de negócio (AD-025).
// Na amostra, `log` é o `eventLogger` sobre um logger montado por `fromPino(pino())` (o jeito de montar um logger
// fora de `src/shared/logging.ts`), `appLogger` é um `AppLogger` qualquer e `pino`, `createLogger`, `fromPino` e
// `eventLogger` estão importados (A16, A17).
export interface SampleCase {
  imports: string;
  specs: string;
  calls: string;
}

// O código do erro de campo fora da declaração depende de como o tipo recusa: o literal com campo a mais dá
// TS2353, o campo que vira `never` dá TS2322 e o objeto montado antes da chamada dá TS2345.
export const FIELD_ERROR_CODES = ['TS2353', 'TS2322', 'TS2345'] as const;

function eventLoggerSample({ imports, specs, calls }: SampleCase): string {
  return `import { pino } from 'pino';
import {
  createLogger,
  eventLogger,
  fromPino,
  type AppLogger,
} from '${repoRoot}/src/shared/logging.ts';
import type { LogEventSpec } from '${repoRoot}/src/shared/telemetry-catalog.ts';
${imports}

declare const appLogger: AppLogger;
const log = eventLogger(fromPino(pino()), ${specs});
${calls}
`;
}

export function expectLogCompiles(sample: SampleCase): void {
  expectSampleCompiles('obs07-log-tsc-', eventLoggerSample(sample));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// O erro cita o culpado pelo nome, ou aponta para ele: o `Type 'string' is not assignable to type 'never'` do campo a
// mais não traz o nome, só a linha e a coluna do campo na amostra.
function culpritPattern(source: string, calls: string, text: string): RegExp {
  const index = source.indexOf(text, source.indexOf(calls));
  if (index < 0) return new RegExp(escapeRegExp(text));
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return new RegExp(
    `${escapeRegExp(text)}|amostra\\.ts\\(${line},${column}\\)`,
  );
}

// O culpado do erro é o evento, o nível, o campo fora da declaração ou o método que o `AppLogger` não tem; com uma
// lista de culpados, cada um tem de ser citado.
export function expectLogTypeError(
  sample: SampleCase,
  expected: { code: string | readonly string[]; text: string | string[] },
): void {
  const source = eventLoggerSample(sample);
  expectSampleTypeError('obs07-log-tsc-', source, {
    code: expected.code,
    text: [expected.text]
      .flat()
      .map((text) => culpritPattern(source, sample.calls, text)),
  });
}
