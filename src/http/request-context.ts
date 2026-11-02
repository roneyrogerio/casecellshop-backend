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
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';
import type { Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { CorrelationId } from '../contract/index.ts';
import { HTTP_LOG_EVENTS, HTTP_METHODS, httpMetrics } from './telemetry.ts';
import { eventLogger, logContext } from '../shared/logging.ts';
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
function methodAttribute(method: string): (typeof HTTP_METHODS)[number] {
  // O find devolve o item da lista já tipado, sem asserção.
  return HTTP_METHODS.find((known) => known === method) ?? '_OTHER';
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

function matchedRouteOf(res: Response): string | undefined {
  return typeof res.locals['route'] === 'string'
    ? res.locals['route']
    : undefined;
}

// Só há status a gravar se a resposta foi enviada: o cliente que desconecta antes dela deixa o
// `res.statusCode` no 200 padrão do Node, e a convenção pede o status "if and only if" um foi enviado.
function sentStatusOf(res: Response): number | undefined {
  return res.headersSent ? res.statusCode : undefined;
}

// Atributos da convenção do OpenTelemetry: o `http.response.status_code` e o `error.type` (resposta 5xx)
// só com resposta enviada, e o `http.route` só quando a requisição casou com uma rota.
// O tipo anotado faz o texto do status valer como `${number}`, o que a declaração do atributo aceita.
// O span e a métrica partem desta mesma função, para os valores comuns não divergirem.
function commonAttributes(req: Request, res: Response) {
  const status = sentStatusOf(res);
  const matchedRoute = matchedRouteOf(res);
  const errorType: { [ATTR_ERROR_TYPE]?: `${number}` } =
    status !== undefined && status >= 500
      ? { [ATTR_ERROR_TYPE]: `${status}` }
      : {};
  return {
    [ATTR_HTTP_REQUEST_METHOD]: methodAttribute(req.method),
    ...(matchedRoute === undefined ? {} : { [ATTR_HTTP_ROUTE]: matchedRoute }),
    ...(status === undefined
      ? {}
      : { [ATTR_HTTP_RESPONSE_STATUS_CODE]: status }),
    [ATTR_URL_SCHEME]: req.secure ? 'https' : 'http',
    ...errorType,
  } as const;
}

// Nome do span pela convenção, `{method} {target}`: o método fora da lista (`_OTHER`) vira `HTTP`,
// e o nome mantém a rota quando a requisição casou com uma.
function spanNameOf(req: Request, res: Response): string {
  const method = methodAttribute(req.method);
  const name = method === '_OTHER' ? 'HTTP' : method;
  const matchedRoute = matchedRouteOf(res);
  return matchedRoute === undefined ? name : `${name} ${matchedRoute}`;
}

// O método original só é gravado quando o enviado difere do normalizado.
function applyHttpSpan(span: Span, req: Request, res: Response): void {
  span.updateName(spanNameOf(req, res));
  span.setAttributes({
    ...commonAttributes(req, res),
    [ATTR_URL_PATH]: req.path,
    ...(methodAttribute(req.method) === req.method
      ? {}
      : { [ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: req.method }),
  });
  // Mesma condição do `error.type`: sem resposta enviada não há 5xx a marcar.
  const status = sentStatusOf(res);
  if (status !== undefined && status >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
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
  // Só o log segue com `unmatched`; o span e a métrica omitem a chave sem rota, como a convenção manda.
  const route = matchedRouteOf(res) ?? 'unmatched';
  const status = sentStatusOf(res);
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  applyHttpSpan(span, req, res);
  const spanContext = span.spanContext();
  span.end();

  httpMetrics(telemetry).record(
    METRIC_HTTP_SERVER_REQUEST_DURATION,
    seconds,
    commonAttributes(req, res),
  );
  // Campos explícitos: o evento 'finish' pode correr fora do contexto assíncrono da requisição.
  // O orderId entra só quando o handler o gravou (pedido existente).
  const orderId =
    typeof res.locals['orderId'] === 'string'
      ? res.locals['orderId']
      : undefined;
  const fields = {
    ...(orderId === undefined ? {} : { orderId }),
    ...(status === undefined ? {} : { status }),
    correlationId,
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    route,
    method: req.method,
    duration_ms: Math.round(seconds * 1000),
  };
  const log = eventLogger(logger, HTTP_LOG_EVENTS);
  // `error` só quando um 5xx foi de fato enviado; sem resposta (cliente desconectou) o log sai em info.
  if (status !== undefined && status >= 500) {
    log.error(
      'casecellshop.http.request.completed',
      fields,
      'requisição concluída',
    );
  } else {
    log.info(
      'casecellshop.http.request.completed',
      fields,
      'requisição concluída',
    );
  }
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
