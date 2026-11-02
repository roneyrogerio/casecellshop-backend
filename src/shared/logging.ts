import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger } from 'pino';
import { resolveServiceIdentity } from './service-identity.ts';
import type {
  LogEventSpec,
  LogLevel,
  RESERVED_LOG_FIELD_NAMES,
} from './telemetry-catalog.ts';

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

// O símbolo não sai do módulo: sem nomeá-lo ninguém monta um AppLogger nem alcança o pino que ele guarda, e o
// objeto não tem método de escrita.
const appLoggerBrand: unique symbol = Symbol('AppLogger');

// Os nomes que a linha já tem, derivados da mesma tupla que o catálogo usa para recusar campos de evento: um
// binding com um deles colidiria com o campo do logger ou com o nome do evento. O correlationId, o trace_id e o
// span_id ficam de fora de propósito, pois o filho pode fixá-los.
type ReservedLogField = (typeof RESERVED_LOG_FIELD_NAMES)[number];

// Os bindings de um filho recusam os nomes reservados; o nome do evento só entra pelo `eventLogger`.
export type ChildBindings = Readonly<Record<string, unknown>> & {
  readonly [K in ReservedLogField]?: never;
};

// O logger que o resto de `src/` recebe: só cria filhos; escrever é com o `eventLogger`.
export interface AppLogger {
  // O pino e os campos do filho ficam sob o símbolo privado, fora do alcance de quem recebe o AppLogger.
  readonly [appLoggerBrand]: { readonly pino: Logger; readonly fields: object };
  child(bindings: ChildBindings): AppLogger;
}

// Envolve um logger do pino (os testes montam o deles, com destino próprio).
export function fromPino(logger: Logger): AppLogger {
  return withFields(logger, {});
}

// Os campos do filho ficam aqui, e não no `child` do pino: o pino serializa os bindings à parte e escreve
// depois o objeto do mixin e o da chamada sem deduplicar, o que repetia chaves (como o correlationId) na linha.
// Juntos num objeto só a cada escrita, cada chave sai uma vez; filho de filho acumula e o mais novo vale.
function withFields(pino: Logger, fields: object): AppLogger {
  return {
    [appLoggerBrand]: { pino, fields },
    child: (bindings) => withFields(pino, { ...fields, ...bindings }),
  };
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
  // O pino é sempre o raiz; os campos de um logger filho vêm do que o `AppLogger` guarda e entram no objeto
  // de cada escrita.
  const write =
    (level: LogLevel) =>
    (event: string, fields: object, message: string): void => {
      // O `event` vai depois dos campos para valer sobre qualquer campo de mesmo nome: o nome do evento é o
      // que o catálogo e os painéis procuram, e um campo não pode sobrescrevê-lo.
      // Precedência numa chave repetida: evento, filho, contexto (o mixin do pino fica por baixo, pois o
      // merge padrão dele deixa valer o objeto da chamada).
      const { pino, fields: bound } = logger[appLoggerBrand];
      // Um campo `undefined` do evento sairia no merge por cima do valor do filho e o apagaria; descartá-lo antes
      // deixa valer o do filho.
      const defined = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      pino[level]({ ...bound, ...defined, event }, message);
    };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}
