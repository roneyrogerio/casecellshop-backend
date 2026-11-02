import { createLogger, type AppLogger } from '../../src/shared/logging.ts';
import { duplicateKeys } from './duplicate-keys.ts';

export type LogLine = Record<string, unknown>;

export interface CapturedLogs {
  logger: AppLogger;
  lines: LogLine[];
  // O texto cru de cada linha, na mesma ordem de `lines`: o `JSON.parse` esconde a chave repetida (OBS-01).
  raw: string[];
  // As linhas que escrevem a mesma chave duas vezes no primeiro nível, com o texto cru e as chaves repetidas;
  // vazio quando nenhuma repete.
  repeatedKeys(): { line: string; keys: string[] }[];
  // O texto cru das linhas de um evento (e de um pedido, se dado), na ordem em que saíram.
  rawOf(event: string, orderId?: string): string[];
  // Linhas de um evento, na ordem em que saíram.
  eventsOf(event: string, orderId?: string): LogLine[];
  // Linhas de um pedido.
  ofOrder(orderId: string): LogLine[];
}

// As linhas cruas que escrevem alguma chave duas vezes no primeiro nível, com o texto e as chaves repetidas.
export function repeatedKeys(
  raw: readonly string[],
): { line: string; keys: string[] }[] {
  return raw
    .map((line) => ({ line, keys: duplicateKeys(line) }))
    .filter((found) => found.keys.length > 0);
}

// O destino em memória: guarda cada linha JSON que o logger escreve, já lida (`lines`) e no texto cru (`raw`).
export function memoryDestination() {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const destination = {
    write(chunk: string): void {
      for (const text of chunk.split('\n')) {
        if (text.trim() === '') continue;
        raw.push(text);
        lines.push(JSON.parse(text) as LogLine);
      }
    },
  };
  return { lines, raw, destination };
}

// O logger de produção (createLogger) escrevendo as linhas JSON em memória, pelo `destination`.
export function captureLogs(
  serviceName = 'casecellshop-worker',
  level = 'info',
): CapturedLogs {
  const { lines, raw, destination } = memoryDestination();
  const logger = createLogger({ serviceName, level, destination });
  const matches = (line: LogLine, event: string, orderId?: string): boolean =>
    line['event'] === event &&
    (orderId === undefined || line['orderId'] === orderId);
  return {
    logger,
    lines,
    raw,
    repeatedKeys: () => repeatedKeys(raw),
    rawOf: (event, orderId) =>
      raw.filter((_, at) => matches(lines[at] ?? {}, event, orderId)),
    eventsOf: (event, orderId) =>
      lines.filter((line) => matches(line, event, orderId)),
    ofOrder: (orderId) => lines.filter((line) => line['orderId'] === orderId),
  };
}
