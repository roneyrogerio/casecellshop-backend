import { randomUUID } from 'node:crypto';
import {
  context,
  defaultTextMapGetter,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions';
import type { Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { CorrelationId } from '../contract/index.ts';
import { HTTP_METHODS } from '../shared/http-metrics.ts';
import { logContext } from '../shared/logging.ts';
import { propagator, type Telemetry } from '../shared/telemetry.ts';

// Aceita o X-Request-Id válido; qualquer outro vira um UUID novo.
function correlationIdFrom(header: string | string[] | undefined): string {
  if (typeof header === 'string') {
    const parsed = CorrelationId.safeParse(header);
    if (parsed.success) return parsed.data;
  }
  return randomUUID();
}

// Cardinalidade limitada: um método fora da lista da convenção vira `_OTHER`.
function methodAttribute(method: string): string {
  const known: readonly string[] = HTTP_METHODS;
  return known.includes(method) ? method : '_OTHER';
}

interface ConcludedRequest {
  telemetry: Telemetry;
  logger: Logger;
  req: Request;
  res: Response;
  span: Span;
  correlationId: string;
  startedAt: bigint;
}

// Fecha o span, mede a duração e registra o log da requisição.
function concludeRequest({
  telemetry,
  logger,
  req,
  res,
  span,
  correlationId,
  startedAt,
}: ConcludedRequest): void {
  const route =
    typeof res.locals['route'] === 'string' ? res.locals['route'] : 'unmatched';
  const status = res.statusCode;
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  span.updateName(`${req.method} ${route}`);
  span.setAttributes({
    'http.route': route,
    'http.request.method': req.method,
    'http.response.status_code': status,
  });
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  const spanContext = span.spanContext();
  span.end();

  // Atributos da convenção do OpenTelemetry; o `error.type` só na resposta 5xx, como pede a convenção.
  telemetry.httpRequestDuration.record(seconds, {
    [ATTR_HTTP_REQUEST_METHOD]: methodAttribute(req.method),
    [ATTR_HTTP_ROUTE]: route,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
    [ATTR_URL_SCHEME]: req.secure ? 'https' : 'http',
    ...(status >= 500 ? { [ATTR_ERROR_TYPE]: String(status) } : {}),
  });
  // Campos explícitos: o evento 'finish' pode correr fora do contexto assíncrono da requisição.
  // O orderId entra só quando o handler o gravou (pedido existente).
  const orderId =
    typeof res.locals['orderId'] === 'string'
      ? res.locals['orderId']
      : undefined;
  logger[status >= 500 ? 'error' : 'info'](
    {
      ...(orderId === undefined ? {} : { orderId }),
      event: 'http_request',
      correlationId,
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      route,
      method: req.method,
      status,
      duration_ms: Math.round(seconds * 1000),
    },
    'requisição concluída',
  );
}

// Primeiro middleware: fixa o correlationId, abre o span SERVER (continuando um
// traceparent de entrada), roda o resto da requisição dentro do contexto e, ao
// fim da resposta, fecha o span, mede a duração e registra o log da requisição.
export function requestContext(
  telemetry: Telemetry,
  logger: Logger,
): RequestHandler {
  return (req, res, next) => {
    const correlationId = correlationIdFrom(req.headers['x-request-id']);
    res.locals['correlationId'] = correlationId;
    res.setHeader('X-Request-Id', correlationId);
    // Os schemas de cabeçalho do contrato veem sempre o valor já normalizado.
    req.headers['x-request-id'] = correlationId;

    const parent = propagator.extract(
      ROOT_CONTEXT,
      req.headers,
      defaultTextMapGetter,
    );
    const span = telemetry.tracer.startSpan(
      req.method,
      { kind: SpanKind.SERVER },
      parent,
    );
    const startedAt = process.hrtime.bigint();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      concludeRequest({
        telemetry,
        logger,
        req,
        res,
        span,
        correlationId,
        startedAt,
      });
    };
    res.on('finish', finish);
    // Cliente que desconecta antes da resposta: o span não pode ficar aberto.
    res.on('close', finish);

    context.with(trace.setSpan(parent, span), () => {
      logContext.run({ correlationId }, next);
    });
  };
}
