import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { checkoutRoute, healthRoute, orderStatusRoute } from './contract/index.ts';
import { createCheckoutRepository } from './checkout/repository.ts';
import { createCheckoutRoutes } from './checkout/routes.ts';
import { createHealthRepository } from './health/repository.ts';
import { createHealthRoutes } from './health/routes.ts';
import { createOrdersRepository } from './orders/repository.ts';
import { createOrdersRoutes } from './orders/routes.ts';
import { createErrorHandler, notFoundHandler } from './http/problem.ts';
import { requestContext } from './http/request-context.ts';
import type { Telemetry } from './shared/telemetry.ts';

export interface AppDependencies {
  pool: Pool;
  logger: Logger;
  telemetry: Telemetry;
}

// O contrato escreve {orderId}; o Express, :orderId.
function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

// Monta o app sem abrir porta: os testes usam o supertest direto nele.
export function createApp({ pool, logger, telemetry }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(telemetry, logger));

  const health = createHealthRoutes(createHealthRepository(pool, telemetry), logger);
  app.get(toExpressPath(healthRoute.path), ...health.handlers);

  const orders = createOrdersRoutes(createOrdersRepository(pool, telemetry), logger);
  app.get(toExpressPath(orderStatusRoute.path), ...orders.handlers);

  const checkout = createCheckoutRoutes(createCheckoutRepository(pool, telemetry, logger), telemetry, logger);
  app.post(toExpressPath(checkoutRoute.path), ...checkout.handlers);

  // Fora do contrato: o /metrics é do Prometheus, não da API.
  app.get('/metrics', (req, res) => {
    res.locals['route'] = '/metrics';
    telemetry.metricsHandler(req, res);
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
