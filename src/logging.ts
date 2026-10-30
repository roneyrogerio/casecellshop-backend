import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';
import { resolveServiceIdentity } from './service-identity.ts';

export interface LogContext {
  correlationId: string;
}

// O AsyncLocalStorage leva o correlationId da requisição até qualquer log
// emitido nela, sem passar o logger por parâmetro em cada camada.
export const logContext = new AsyncLocalStorage<LogContext>();

// `serviceName` é o nome do processo, o mesmo que o createTelemetry recebe; o
// OTEL_SERVICE_NAME o substitui, e `service`, `env` e `version` saem da mesma fonte do recurso dos traces.
export function createLogger(options: { serviceName: string; level?: string }): Logger {
  const { service, env, version } = resolveServiceIdentity(options.serviceName);
  return pino({
    level: options.level ?? 'info',
    base: { service, env, version },
    // `time` em ISO e `level` como texto, para o log ser legível sem decodificar números.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    // Campos do design.md: correlationId e, no topo do JSON, trace_id (32 hex), span_id (16 hex)
    // e trace_flags (2 hex, como no traceparent do W3C).
    mixin() {
      const spanContext = trace.getActiveSpan()?.spanContext();
      return {
        correlationId: logContext.getStore()?.correlationId,
        trace_id: spanContext?.traceId,
        span_id: spanContext?.spanId,
        trace_flags: spanContext && spanContext.traceFlags.toString(16).padStart(2, '0'),
      };
    },
  });
}
