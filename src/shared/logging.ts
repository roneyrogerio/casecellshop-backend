import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger } from 'pino';
import { resolveServiceIdentity } from './service-identity.ts';
import type { LogEventSpec, LogLevel } from './telemetry-catalog.ts';

export interface LogContext {
  correlationId: string;
}

// O AsyncLocalStorage leva o correlationId da requisição até qualquer log
// emitido nela, sem passar o logger por parâmetro em cada camada.
export const logContext = new AsyncLocalStorage<LogContext>();

// `serviceName` é o nome do processo, o mesmo que o createTelemetry recebe; o
// OTEL_SERVICE_NAME o substitui, e `service`, `env` e `version` saem da mesma fonte do recurso dos traces.
// `destination` deixa o teste capturar as linhas JSON; sem ele, o pino escreve no stdout.
export function createLogger(options: {
  serviceName: string;
  level?: string;
  destination?: DestinationStream;
}): Logger {
  const { service, env, version } = resolveServiceIdentity(options.serviceName);
  return pino(
    {
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
          trace_flags:
            spanContext && spanContext.traceFlags.toString(16).padStart(2, '0'),
        };
      },
    },
    options.destination,
  );
}

type EventSpecs = Readonly<Record<string, LogEventSpec>>;

// Os campos de correlação, que todo evento aceita além dos próprios: o log da requisição os passa à mão,
// porque o `finish` pode correr fora do contexto assíncrono dela.
export interface CorrelationFields {
  correlationId?: string;
  trace_id?: string;
  span_id?: string;
}

// Os eventos da declaração que saem no nível `L`.
export type EventsAt<S extends EventSpecs, L extends LogLevel> = {
  [N in keyof S & string]: L extends S[N]['levels'][number] ? N : never;
}[keyof S & string];

// Os campos que o evento declara, mais os de correlação; um campo fora deles não compila.
export type FieldsOf<E extends LogEventSpec> = Partial<
  Record<E['fields'][number], unknown>
> &
  CorrelationFields;

export interface EventLogger<S extends EventSpecs> {
  info<N extends EventsAt<S, 'info'>>(
    event: N,
    fields: FieldsOf<S[N]>,
    message: string,
  ): void;
  warn<N extends EventsAt<S, 'warn'>>(
    event: N,
    fields: FieldsOf<S[N]>,
    message: string,
  ): void;
  error<N extends EventsAt<S, 'error'>>(
    event: N,
    fields: FieldsOf<S[N]>,
    message: string,
  ): void;
}

// Escreve os eventos de uma declaração pelo `logger` dado (inclusive um filho, com os campos dele), no
// nível pedido e com o nome no campo `event` (OBS-07, AD-029).
export function eventLogger<S extends EventSpecs>(
  logger: Logger,
  specs: S,
): EventLogger<S> {
  void logger;
  void specs;
  throw new Error('não implementado');
}
