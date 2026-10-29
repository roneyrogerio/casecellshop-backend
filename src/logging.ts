import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

export interface LogContext {
  correlationId: string;
}

// O AsyncLocalStorage leva o correlationId da requisição até qualquer log
// emitido nela, sem passar o logger por parâmetro em cada camada.
export const logContext = new AsyncLocalStorage<LogContext>();

export function createLogger(options: { service: string; level?: string }): Logger {
  return pino({
    level: options.level ?? 'info',
    base: { service: options.service },
    // `time` em ISO e `level` como texto, para o log ser legível sem decodificar números.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    // Campos obrigatórios do design.md: correlationId, trace_id e span_id.
    mixin() {
      const spanContext = trace.getActiveSpan()?.spanContext();
      return {
        correlationId: logContext.getStore()?.correlationId,
        trace_id: spanContext?.traceId,
        span_id: spanContext?.spanId,
      };
    },
  });
}
