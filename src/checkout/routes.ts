import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';
import type { Logger } from 'pino';
import {
  CheckoutRequest,
  checkoutRoute,
  MAX_BODY_BYTES,
  type CheckoutAccepted,
} from '../contract/index.ts';
import { ProblemError } from '../http/problem.ts';
import { validateRequest } from '../http/validate.ts';
import { eventLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import type { CheckoutRepository } from './repository.ts';
import { CHECKOUT_LOG_EVENTS, checkoutMetrics } from './telemetry.ts';

// Segundos até o cliente consultar o status do pedido (também na repetição).
const ACCEPTED_RETRY_AFTER_SECONDS = '4';

type Outcome =
  | 'accepted'
  | 'replay'
  | 'out_of_stock'
  | 'price_changed'
  | 'invalid'
  | 'unavailable';

// Desfecho de cada recusa pela causa do problema; o que não está aqui é entrada recusada.
function outcomeOf(cause: string): Outcome {
  switch (cause) {
    case 'out-of-stock':
      return 'out_of_stock';
    case 'price-changed':
      return 'price_changed';
    case 'service-unavailable':
    case 'idempotency-key-in-progress':
      return 'unavailable';
    default:
      return 'invalid';
  }
}

// O `reason` do log é o tipo do problem em snake_case (`out_of_stock`), como os valores das métricas.
function reasonOf(cause: string): string {
  return cause.replaceAll('-', '_');
}

// O parser de JSON do Express (body-parser) erra com `type` e `status`; viram problem+json.
function parserProblem(error: unknown): ProblemError | undefined {
  const type = (error as { type?: unknown } | null)?.type;
  switch (type) {
    case 'entity.too.large':
      return new ProblemError({
        status: 413,
        cause: 'payload-too-large',
        title: 'Corpo acima de 16 KiB',
      });
    case 'entity.parse.failed':
      return new ProblemError({
        status: 400,
        cause: 'invalid-request',
        title: 'JSON malformado',
      });
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new ProblemError({
        status: 415,
        cause: 'unsupported-media-type',
        title: 'Codificação não suportada',
      });
    case 'request.aborted':
    case 'request.size.invalid':
    case 'stream.encoding.set':
    case 'entity.verify.failed':
      return new ProblemError({
        status: 400,
        cause: 'invalid-request',
        title: 'Corpo da requisição inválido',
      });
    default:
      return undefined;
  }
}

export interface CheckoutRoutes {
  // Os middlewares da rota, na ordem, mais o tratamento de erro que mede e registra o desfecho.
  handlers: (RequestHandler | ErrorRequestHandler)[];
}

// Antes de tudo, para o 413, o 415 e o 400 sem chave também saírem com a rota certa.
const markRoute: RequestHandler = (_req, res, next) => {
  res.locals['route'] = checkoutRoute.path;
  next();
};

const requireJson: RequestHandler = (req, _res, next) => {
  if (!req.is('application/json')) {
    next(
      new ProblemError({
        status: 415,
        cause: 'unsupported-media-type',
        title: 'Use Content-Type: application/json',
      }),
    );
    return;
  }
  next();
};

// A falta da chave tem causa própria e vem antes da validação do contrato.
const requireKey: RequestHandler = (req, _res, next) => {
  if (req.headers['idempotency-key'] === undefined) {
    next(
      new ProblemError({
        status: 400,
        cause: 'idempotency-key-required',
        title: 'Idempotency-Key é obrigatória',
      }),
    );
    return;
  }
  next();
};

const rejectDuplicateSku: RequestHandler = (req, _res, next) => {
  const skus = (req.body as CheckoutRequest).items.map((item) => item.sku);
  if (new Set(skus).size !== skus.length) {
    next(
      new ProblemError({
        status: 400,
        cause: 'duplicate-sku',
        title: 'SKU repetido no pedido',
      }),
    );
    return;
  }
  next();
};

function createAccept(
  checkout: CheckoutRepository,
  telemetry: Telemetry,
  logger: Logger,
): RequestHandler {
  return async (req, res) => {
    const result = await checkout.create({
      idempotencyKey: req.headers['idempotency-key'] as string,
      correlationId: res.locals['correlationId'] as string,
      request: CheckoutRequest.parse(req.body),
    });
    res.locals['orderId'] = result.orderId;
    if (result.kind === 'accepted') {
      eventLogger(logger, CHECKOUT_LOG_EVENTS).info(
        'casecellshop.checkout.accepted',
        {
          orderId: result.orderId,
          correlationId: res.locals['correlationId'] as string,
        },
        'checkout aceito',
      );
    }
    checkoutMetrics(telemetry).add('casecellshop.checkout.requests', 1, {
      'casecellshop.checkout.outcome': result.kind,
    });
    const body: CheckoutAccepted = {
      orderId: result.orderId,
      status: result.status,
      total: result.total,
    };
    res
      .status(202)
      .setHeader('Location', `/orders/${result.orderId}/status`)
      .setHeader('Retry-After', ACCEPTED_RETRY_AFTER_SECONDS)
      .json(body);
  };
}

// Erro de qualquer passo da rota: converte o do parser, conta o desfecho e registra a causa.
// O erro segue para o middleware único, que monta o problem+json.
function createOnError(
  telemetry: Telemetry,
  logger: Logger,
): ErrorRequestHandler {
  // O Express identifica o middleware de erro pela aridade 4: os quatro parâmetros ficam.
  return (error: unknown, _req, res, next) => {
    const problem =
      error instanceof ProblemError ? error : parserProblem(error);
    if (!problem) {
      next(error);
      return;
    }
    const { cause, currentPrices } = problem.init;
    const correlationId = res.locals['correlationId'] as string;
    checkoutMetrics(telemetry).add('casecellshop.checkout.requests', 1, {
      'casecellshop.checkout.outcome': outcomeOf(cause),
    });
    const log = eventLogger(logger, CHECKOUT_LOG_EVENTS);
    const reason = reasonOf(cause);
    log.warn(
      'casecellshop.checkout.rejected',
      { reason, correlationId },
      'checkout recusado',
    );
    if (currentPrices) {
      log.warn(
        'casecellshop.checkout.price_changed',
        { reason, correlationId, items: currentPrices.length },
        'preço alterado desde que o cliente o viu',
      );
    }
    next(problem);
  };
}

export function createCheckoutRoutes(
  checkout: CheckoutRepository,
  telemetry: Telemetry,
  logger: Logger,
): CheckoutRoutes {
  const jsonBody = express.json({ limit: MAX_BODY_BYTES });
  const accept = createAccept(checkout, telemetry, logger);
  const onError = createOnError(telemetry, logger);
  return {
    handlers: [
      markRoute,
      requireJson,
      jsonBody,
      requireKey,
      validateRequest(checkoutRoute),
      rejectDuplicateSku,
      accept,
      onError,
    ],
  };
}
