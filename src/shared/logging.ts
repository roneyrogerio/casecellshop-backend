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
}): AppLogger {
  const { service, env, version } = resolveServiceIdentity(options.serviceName);
  return fromPino(
    pino(
      {
        level: options.level ?? 'info',
        base: { service, env, version },
        // `time` em ISO e `level` como texto, para o log ser legível sem decodificar números.
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
        formatters: { level: (label) => ({ level: label }) },
        mixin: traceMixin,
      },
      options.destination,
    ),
  );
}

// Campos do design.md: correlationId e, no topo do JSON, trace_id (32 hex), span_id (16 hex)
// e trace_flags (2 hex, como no traceparent do W3C).
function traceMixin(): object {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return {
    correlationId: logContext.getStore()?.correlationId,
    trace_id: spanContext?.traceId,
    span_id: spanContext?.spanId,
    trace_flags:
      spanContext && spanContext.traceFlags.toString(16).padStart(2, '0'),
  };
}

// O marcador não sai do módulo: sem nomear o símbolo ninguém monta um AppLogger, e o objeto não tem método de escrita.
const appLoggerBrand: unique symbol = Symbol('AppLogger');

// Os bindings de um filho recusam `event`: o nome do evento só entra pelo `eventLogger`.
export type ChildBindings = Readonly<Record<string, unknown>> & {
  readonly event?: never;
};

// O logger que o resto de `src/` recebe: só cria filhos; escrever é com o `eventLogger`.
export interface AppLogger {
  readonly [appLoggerBrand]: true;
  child(bindings: ChildBindings): AppLogger;
}

// O pino de cada AppLogger fica aqui, fora do alcance de quem recebe o AppLogger.
const pinoOf = new WeakMap<AppLogger, Logger>();

// Envolve um logger do pino (os testes montam o deles, com destino próprio).
export function fromPino(logger: Logger): AppLogger {
  const appLogger: AppLogger = {
    [appLoggerBrand]: true,
    child: (bindings) => fromPino(logger.child(bindings)),
  };
  pinoOf.set(appLogger, logger);
  return appLogger;
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

// Recusa o campo a mais mesmo num objeto montado antes (a técnica do `Exact` do type-fest): cada chave fora
// da declaração vira `never`.
type ExactFields<F, E extends LogEventSpec> = F &
  Record<Exclude<keyof F, keyof FieldsOf<E>>, never>;

export interface EventLogger<S extends EventSpecs> {
  info<N extends EventsAt<S, 'info'>, F extends FieldsOf<S[N]>>(
    event: N,
    fields: ExactFields<F, S[N]>,
    message: string,
  ): void;
  warn<N extends EventsAt<S, 'warn'>, F extends FieldsOf<S[N]>>(
    event: N,
    fields: ExactFields<F, S[N]>,
    message: string,
  ): void;
  error<N extends EventsAt<S, 'error'>, F extends FieldsOf<S[N]>>(
    event: N,
    fields: ExactFields<F, S[N]>,
    message: string,
  ): void;
}

// Escreve os eventos de uma declaração pelo `logger` dado (inclusive um filho, com os campos dele), no
// nível pedido e com o nome no campo `event` (OBS-07, AD-029).
export function eventLogger<S extends EventSpecs>(
  logger: AppLogger,
  specs: S,
): EventLogger<S> {
  // A declaração só serve ao compilador (nome, nível e campos); em execução o nome vai direto ao campo `event`.
  void specs;
  // Escrever pelo pino deste `logger` (e não por um global) preserva os campos de um logger filho.
  const write =
    (level: LogLevel) =>
    (event: string, fields: object, message: string): void => {
      pinoOf.get(logger)?.[level]({ event, ...fields }, message);
    };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}
