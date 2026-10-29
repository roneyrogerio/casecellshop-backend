import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import express, { type Express, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { healthRoute, type HealthStatus } from './contract/index.ts';
import { createHealthRepository } from './health/repository.ts';
import { createErrorHandler, notFoundHandler, ProblemError } from './http/problem.ts';
import { requestContext } from './http/request-context.ts';
import { validateRequest } from './http/validate.ts';
import type { Telemetry } from './telemetry.ts';

export interface AppDependencies {
  pool: Pool;
  logger: Logger;
  telemetry: Telemetry;
}

// Segundos até o cliente tentar de novo depois de o banco não responder.
const HEALTH_RETRY_AFTER_SECONDS = '5';

// O contrato escreve {orderId}; o Express, :orderId.
function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

// Monta o app sem abrir porta: os testes usam o supertest direto nele.
export function createApp({ pool, logger, telemetry }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(telemetry, logger));

  const health = createHealthRepository(pool, telemetry);

  const getHealth: RequestHandler = async (_req, res) => {
    try {
      await health.ping();
    } catch (error) {
      logger.warn({ event: 'health_failed', err: error }, 'o banco não respondeu ao healthcheck');
      throw new ProblemError({
        status: 503,
        cause: 'service-unavailable',
        title: 'Banco indisponível',
        headers: { 'Retry-After': HEALTH_RETRY_AFTER_SECONDS },
      });
    }
    const body: HealthStatus = { status: 'ok' };
    res.json(body);
  };

  const get = (route: RouteConfig, handler: RequestHandler) => {
    app.get(toExpressPath(route.path), validateRequest(route), handler);
  };
  get(healthRoute, getHealth);

  // Fora do contrato: o /metrics é do Prometheus, não da API.
  app.get('/metrics', (req, res) => {
    res.locals['route'] = '/metrics';
    telemetry.metricsHandler(req, res);
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
