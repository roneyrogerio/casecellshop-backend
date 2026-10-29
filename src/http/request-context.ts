import { randomUUID } from 'node:crypto';
import { context, defaultTextMapGetter, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { CorrelationId } from '../contract/index.ts';
import { logContext } from '../logging.ts';
import type { Telemetry } from '../telemetry.ts';

const propagator = new W3CTraceContextPropagator();

// Aceita o X-Request-Id válido; qualquer outro vira um UUID novo.
function correlationIdFrom(header: string | string[] | undefined): string {
  if (typeof header === 'string') {
    const parsed = CorrelationId.safeParse(header);
    if (parsed.success) return parsed.data;
  }
  return randomUUID();
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

// Primeiro middleware: fixa o correlationId, abre o span SERVER (continuando um
// traceparent de entrada), roda o resto da requisição dentro do contexto e, ao
// fim da resposta, fecha o span, mede a duração e registra o log da requisição.
export function requestContext(telemetry: Telemetry, logger: Logger): RequestHandler {
  return (req, res, next) => {
    const correlationId = correlationIdFrom(req.headers['x-request-id']);
    res.locals['correlationId'] = correlationId;
    res.setHeader('X-Request-Id', correlationId);
    // Os schemas de cabeçalho do contrato veem sempre o valor já normalizado.
    req.headers['x-request-id'] = correlationId;

    const parent = propagator.extract(ROOT_CONTEXT, req.headers, defaultTextMapGetter);
    const span = telemetry.tracer.startSpan(req.method, { kind: SpanKind.SERVER }, parent);
    const startedAt = process.hrtime.bigint();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const route = typeof res.locals['route'] === 'string' ? res.locals['route'] : 'unmatched';
      const status = res.statusCode;
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      span.updateName(`${req.method} ${route}`);
      span.setAttributes({ 'http.route': route, 'http.request.method': req.method, 'http.response.status_code': status });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      const spanContext = span.spanContext();
      span.end();

      // Labels de lista fechada: rota como template, método e classe de status.
      telemetry.httpRequestDuration.record(seconds, {
        route,
        method: req.method,
        status_class: statusClass(status),
      });
      // Campos explícitos: o evento 'finish' pode correr fora do contexto assíncrono da requisição.
      logger[status >= 500 ? 'error' : 'info'](
        {
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
    };
    res.on('finish', finish);
    // Cliente que desconecta antes da resposta: o span não pode ficar aberto.
    res.on('close', finish);

    context.with(trace.setSpan(parent, span), () => {
      logContext.run({ correlationId }, next);
    });
  };
}
