import express, { type Express } from 'express';
import type { Pool } from 'pg';
import {
  checkoutRoute,
  healthRoute,
  orderStatusRoute,
  productsRoute,
} from './contract/index.ts';
import {
  DEFAULT_CATALOG_CONFIG,
  type CatalogConfig,
} from './catalog/config.ts';
import { createCatalogRepository } from './catalog/repository.ts';
import { createCatalogRoutes } from './catalog/routes.ts';
import { createStorefront } from './catalog/storefront.ts';
import { createCheckoutRepository } from './checkout/repository.ts';
import { createCheckoutRoutes } from './checkout/routes.ts';
import { createHealthRepository } from './health/repository.ts';
import { createHealthRoutes } from './health/routes.ts';
import { createOrdersRepository } from './orders/repository.ts';
import { createOrdersRoutes } from './orders/routes.ts';
import { createErrorHandler, notFoundHandler } from './http/problem.ts';
import { requestContext } from './http/request-context.ts';
import { systemClock, type Clock } from './shared/clock.ts';
import type { AppLogger } from './shared/logging.ts';
import type { Telemetry } from './shared/telemetry.ts';

export interface AppDependencies {
  pool: Pool;
  logger: AppLogger;
  telemetry: Telemetry;
  // Só os testes passam: o relógio do TTL, o sorteio do jitter e os parâmetros da vitrine.
  clock?: Clock;
  random?: () => number;
  catalog?: Partial<CatalogConfig>;
}

// O contrato escreve {orderId}; o Express, :orderId.
function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

// Monta o app sem abrir porta: os testes usam o supertest direto nele.
export function createApp({
  pool,
  logger,
  telemetry,
  clock = systemClock,
  random = Math.random,
  catalog,
}: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(telemetry, logger));

  const health = createHealthRoutes(
    createHealthRepository(pool, telemetry),
    logger,
  );
  app.get(toExpressPath(healthRoute.path), ...health.handlers);

  // Uma vitrine por app: a entrada do cache vive enquanto o processo vive (AD-005).
  const catalogConfig = { ...DEFAULT_CATALOG_CONFIG, ...catalog };
  const storefront = createStorefront({
    repository: createCatalogRepository(pool, telemetry),
    clock,
    random,
    config: catalogConfig,
    telemetry,
    logger,
  });
  const products = createCatalogRoutes(storefront);
  app.get(toExpressPath(productsRoute.path), ...products.handlers);

  const orders = createOrdersRoutes(
    createOrdersRepository(pool, telemetry),
    logger,
  );
  app.get(toExpressPath(orderStatusRoute.path), ...orders.handlers);

  const checkout = createCheckoutRoutes(
    createCheckoutRepository(pool, telemetry, logger),
    telemetry,
    logger,
  );
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
