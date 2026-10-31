import {
  context,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
  type Tracer,
  type UpDownCounter,
} from '@opentelemetry/api';
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
import { resolveServiceIdentity } from './service-identity.ts';

export interface TelemetryOptions {
  // Os testes passam o InMemorySpanExporter; sem ele e sem OTEL_TRACES_EXPORTER, não há exportação.
  spanExporter?: SpanExporter;
  serviceName?: string;
}

export interface Telemetry {
  tracer: Tracer;
  // Duração HTTP em segundos; labels: route (template), method e status_class.
  httpRequestDuration: Histogram;
  // Desfecho de cada checkout; único label: outcome, de lista fechada (OBS-02).
  checkoutOutcome: Counter;
  // Métricas do worker e da camada anticorrupção (design.md, "Nomes das métricas do worker").
  // Labels de lista fechada; nunca orderId nem sku.
  outboxAttemptOutcome: Counter;
  outboxConclusionNoRow: Counter;
  orderAcceptToInvoice: Histogram;
  erpRequestDuration: Histogram;
  erpRequestTotal: Counter;
  erpRequestsInFlight: UpDownCounter;
  erpConfigError: Counter;
  erpOutOfStockRejection: Counter;
  // Abre um span ativo, o fecha ao fim da função e registra a falha, se houver.
  withSpan<T>(name: string, options: { kind: SpanKind; attributes?: Attributes }, fn: (span: Span) => Promise<T>): Promise<T>;
  metricsHandler(request: IncomingMessage, response: ServerResponse): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

// Limiares dos SLOs (200 ms da vitrine, 500 ms do checkout) entram como fronteiras.
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5, 5, 10];
// A chamada ao ERP vai até o timeout de 10 s com folga; a última fronteira é 30.
const ERP_DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
// Do aceite ao faturamento pode levar minutos (H4, backoff): a fronteira em 60 separa o normal do lento.
const ACCEPT_TO_INVOICE_BUCKETS_SECONDS = [1, 5, 15, 30, 60, 120, 300, 600, 1800];

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

  const identity = resolveServiceIdentity(options.serviceName ?? 'casecellshop');
  const resource = resourceFromAttributes({
    'service.name': identity.service,
    'deployment.environment.name': identity.env,
    'service.version': identity.version,
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

  const checkoutOutcome = meter.createCounter('checkout_outcome_total', {
    description: 'Checkouts por desfecho: accepted, replay, out_of_stock, price_changed, invalid ou unavailable.',
  });

  return {
    tracer,
    httpRequestDuration,
    checkoutOutcome,
    outboxAttemptOutcome: meter.createCounter('outbox_attempt_outcome_total', {
      description: 'Tentativas da outbox por desfecho: invoiced, failed, retry, dead, closed ou lease_short.',
    }),
    outboxConclusionNoRow: meter.createCounter('outbox_conclusion_no_row_total', {
      description: 'Conclusões que não afetaram linha porque o token já não valia.',
    }),
    orderAcceptToInvoice: meter.createHistogram('order_accept_to_invoice_seconds', {
      unit: 's',
      description: 'Tempo do aceite do pedido até o faturamento no ERP.',
      advice: { explicitBucketBoundaries: ACCEPT_TO_INVOICE_BUCKETS_SECONDS },
    }),
    erpRequestDuration: meter.createHistogram('erp_request_duration_seconds', {
      unit: 's',
      description: 'Duração das chamadas ao ERP, por operação e desfecho.',
      advice: { explicitBucketBoundaries: ERP_DURATION_BUCKETS_SECONDS },
    }),
    erpRequestTotal: meter.createCounter('erp_request_total', { description: 'Chamadas ao ERP por operação e desfecho.' }),
    erpRequestsInFlight: meter.createUpDownCounter('erp_requests_in_flight', { description: 'Chamadas ao ERP em andamento.' }),
    erpConfigError: meter.createCounter('erp_config_error_total', {
      description: 'Respostas do ERP que indicam erro de configuração, por operação.',
    }),
    erpOutOfStockRejection: meter.createCounter('erp_out_of_stock_rejection_total', {
      description: 'Pedidos que o ERP recusou por falta de estoque.',
    }),
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
