import type { RequestHandler } from 'express';
import { productsRoute } from '../contract/index.ts';
import { ProblemError } from '../http/problem.ts';
import { validateRequest } from '../http/validate.ts';
import type { CatalogConfig } from './config.ts';
import type { Storefront } from './storefront.ts';

export interface CatalogRoutes {
  // Os middlewares da rota, na ordem.
  handlers: RequestHandler[];
}

export function createCatalogRoutes(
  _storefront: Storefront,
  _config: CatalogConfig,
): CatalogRoutes {
  const notImplemented: RequestHandler = () => {
    throw new ProblemError({
      status: 501,
      cause: 'not-implemented',
      title: 'Não implementado',
    });
  };
  return { handlers: [validateRequest(productsRoute), notImplemented] };
}
