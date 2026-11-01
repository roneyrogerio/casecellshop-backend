import {
  context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { optionalEnv } from './config.ts';
import type { LogEventSpec } from './telemetry-catalog.ts';
import { logContext } from './logging.ts';
import { resolveServiceIdentity } from './service-identity.ts';

export interface TelemetryOptions {
  // Os testes passam o InMemorySpanExporter; sem ele e sem OTEL_TRACES_EXPORTER, não há exportação.
  spanExporter?: SpanExporter;
  serviceName?: string;
}

export interface Telemetry {
  tracer: Tracer;
  // Cada pasta obtém o Meter do próprio escopo e cria os instrumentos da própria declaração (metricsOf); o
  // MeterProvider fica aqui para cada teste ter o seu e as séries não se misturarem.
  meter(scope: string): Meter;
  // Abre um span ativo, o fecha ao fim da função e registra a falha, se houver.
  withSpan<T>(
    name: string,
    options: { kind: SpanKind; attributes?: Attributes },
    fn: (span: Span) => Promise<T>,
  ): Promise<T>;
  metricsHandler(request: IncomingMessage, response: ServerResponse): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let contextManagerRegistered = false;

// O contexto ativo precisa de um gerenciador global para atravessar os await.
// Registrado uma vez por processo; um segundo createTelemetry (testes) o reaproveita.
function ensureContextManager(): void {
  if (contextManagerRegistered) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  contextManagerRegistered = true;
}

function defaultExporter(): SpanExporter | undefined {
  const choice = optionalEnv('OTEL_TRACES_EXPORTER');
  if (choice === 'console') return new ConsoleSpanExporter();
  if (choice === 'otlp') return new OTLPTraceExporter();
  return undefined;
}

// Um propagador só para o processo: injeta o traceparent da requisição na outbox e o retoma no worker.
export const propagator = new W3CTraceContextPropagator();

export interface ConsumerSpanOptions {
  name: string;
  // Sem traceparent, o span é raiz.
  traceparent: string | null;
  correlationId: string;
  attributes: Attributes;
}

// Roda `fn` num span CONSUMER que continua o trace do checkout (pelo traceparent da mensagem) e
// leva o correlationId dele nos logs; o span fecha ao fim, com sucesso ou erro.
export function runConsumerSpan<T>(
  telemetry: Telemetry,
  options: ConsumerSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const carrier = options.traceparent
    ? { traceparent: options.traceparent }
    : {};
  const parent = propagator.extract(
    ROOT_CONTEXT,
    carrier,
    defaultTextMapGetter,
  );
  return logContext.run({ correlationId: options.correlationId }, () =>
    telemetry.tracer.startActiveSpan(
      options.name,
      { kind: SpanKind.CONSUMER, attributes: options.attributes },
      parent,
      async (span) => {
        try {
          return await fn(span);
        } finally {
          span.end();
        }
      },
    ),
  );
}

function createWithSpan(tracer: Tracer): Telemetry['withSpan'] {
  return (name, spanOptions, fn) =>
    tracer.startActiveSpan(name, spanOptions, async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  ensureContextManager();

  const identity = resolveServiceIdentity(
    options.serviceName ?? 'casecellshop',
  );
  const resource = resourceFromAttributes({
    'service.name': identity.service,
    'deployment.environment.name': identity.env,
    'service.version': identity.version,
  });

  const exporter = options.spanExporter ?? defaultExporter();
  const spanProcessors: SpanProcessor[] = exporter
    ? [new BatchSpanProcessor({ exporter })]
    : [];
  const tracerProvider = new TracerProvider({ resource, spanProcessors });
  const tracer = tracerProvider.getTracer('casecellshop');

  // Sem servidor próprio: o /metrics sai pela API (e pelo worker) com este handler.
  const prometheus = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ resource, readers: [prometheus] });

  return {
    tracer,
    meter: (scope) => meterProvider.getMeter(scope),
    withSpan: createWithSpan(tracer),
    metricsHandler: (request, response) => {
      prometheus.getMetricsRequestHandler(request, response);
    },
    async forceFlush() {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

// OBS-07 (AD-029): os eventos do encerramento do processo (lifecycle.ts), a telemetria declarada por esta pasta.
export const PROCESS_LOG_EVENTS = {
  'casecellshop.process.shutdown.started': {
    level: 'info',
    description: 'O processo recebeu o sinal e começou a encerrar.',
    fields: ['signal'],
  },
  'casecellshop.process.shutdown.completed': {
    level: 'info',
    description: 'O processo encerrou no prazo.',
    fields: [],
  },
  'casecellshop.process.shutdown.timed_out': {
    level: 'error',
    description:
      'O encerramento passou do prazo e o processo saiu com código 1.',
    fields: [],
  },
  'casecellshop.process.shutdown.failed': {
    level: 'error',
    description: 'O encerramento falhou.',
    fields: ['err'],
  },
} as const satisfies Record<string, LogEventSpec>;
