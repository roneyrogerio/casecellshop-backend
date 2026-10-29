import { context, SpanKind, SpanStatusCode, type Attributes, type Histogram, type Span, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
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

export interface TelemetryOptions {
  // Os testes passam o InMemorySpanExporter; sem ele e sem OTEL_TRACES_EXPORTER, não há exportação.
  spanExporter?: SpanExporter;
  serviceName?: string;
}

export interface Telemetry {
  tracer: Tracer;
  // Duração HTTP em segundos; labels: route (template), method e status_class.
  httpRequestDuration: Histogram;
  // Abre um span ativo, o fecha ao fim da função e registra a falha, se houver.
  withSpan<T>(name: string, options: { kind: SpanKind; attributes?: Attributes }, fn: (span: Span) => Promise<T>): Promise<T>;
  metricsHandler(request: IncomingMessage, response: ServerResponse): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

// Limiares dos SLOs (200 ms da vitrine, 500 ms do checkout) entram como fronteiras.
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5, 5, 10];

let contextManagerRegistered = false;

// O contexto ativo precisa de um gerenciador global para atravessar os await.
// Registrado uma vez por processo; um segundo createTelemetry (testes) o reaproveita.
function ensureContextManager(): void {
  if (contextManagerRegistered) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  contextManagerRegistered = true;
}

function defaultExporter(): SpanExporter | undefined {
  const choice = process.env['OTEL_TRACES_EXPORTER'];
  if (choice === 'console') return new ConsoleSpanExporter();
  if (choice === 'otlp') return new OTLPTraceExporter();
  return undefined;
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  ensureContextManager();

  const resource = resourceFromAttributes({
    'service.name': options.serviceName ?? 'casecellshop',
    'deployment.environment.name': process.env['DEPLOY_ENV'] ?? 'development',
    'service.version': process.env['SERVICE_VERSION'] ?? '0.0.0',
  });

  const exporter = options.spanExporter ?? defaultExporter();
  const spanProcessors: SpanProcessor[] = exporter ? [new BatchSpanProcessor({ exporter })] : [];
  const tracerProvider = new TracerProvider({ resource, spanProcessors });
  const tracer = tracerProvider.getTracer('casecellshop');

  // Sem servidor próprio: o /metrics sai pela API (e pelo worker) com este handler.
  const prometheus = new PrometheusExporter({ preventServerStart: true });
  const meterProvider = new MeterProvider({ resource, readers: [prometheus] });
  const meter = meterProvider.getMeter('casecellshop');

  // O exportador Prometheus não acrescenta o sufixo da unidade: o nome já a carrega.
  const httpRequestDuration = meter.createHistogram('http_server_request_duration_seconds', {
    unit: 's',
    description: 'Duração das requisições HTTP, base dos SLOs de latência.',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
  });

  return {
    tracer,
    httpRequestDuration,
    async withSpan(name, spanOptions, fn) {
      return tracer.startActiveSpan(name, spanOptions, async (span) => {
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
    },
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
