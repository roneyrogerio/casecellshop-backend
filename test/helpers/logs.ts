import type { Logger } from 'pino';
import { createLogger } from '../../src/shared/logging.ts';

export type LogLine = Record<string, unknown>;

export interface CapturedLogs {
  logger: Logger;
  lines: LogLine[];
  // Linhas de um evento, na ordem em que saíram.
  eventsOf(event: string, orderId?: string): LogLine[];
  // Linhas de um pedido.
  ofOrder(orderId: string): LogLine[];
}

// O logger de produção (createLogger) escrevendo as linhas JSON em memória, pelo `destination`.
export function captureLogs(serviceName = 'casecellshop-worker', level = 'info'): CapturedLogs {
  const lines: LogLine[] = [];
  const destination = {
    write(chunk: string): void {
      for (const text of chunk.split('\n')) {
        if (text.trim() !== '') lines.push(JSON.parse(text) as LogLine);
      }
    },
  };
  const logger = createLogger({ serviceName, level, destination });
  return {
    logger,
    lines,
    eventsOf: (event, orderId) => lines.filter((line) => line['event'] === event && (orderId === undefined || line['orderId'] === orderId)),
    ofOrder: (orderId) => lines.filter((line) => line['orderId'] === orderId),
  };
}
