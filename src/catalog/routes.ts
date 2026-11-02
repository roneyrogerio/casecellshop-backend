import type { RequestHandler } from 'express';
import { productsRoute } from '../contract/index.ts';
import { CacheUnavailableError } from '../cache/cache.ts';
import {
  ProblemError,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '../http/problem.ts';
import { validateRequest } from '../http/validate.ts';
import { CatalogNotSyncedError, type Storefront } from './storefront.ts';

export interface CatalogRoutes {
  // Os middlewares da rota, na ordem.
  handlers: RequestHandler[];
}

export function createCatalogRoutes(storefront: Storefront): CatalogRoutes {
  // Primeiro, para valer também no 400, no 503 e no 500: sem o no-store, um cache no caminho aplicaria frescor
  // heurístico (CAT-10).
  const noStore: RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  const listProducts: RequestHandler = async (req, res) => {
    // A query já foi validada: a regex garante o texto de um inteiro de 1 a 999999.
    const raw = req.query['page'];
    const page = typeof raw === 'string' ? Number(raw) : 1;
    try {
      res.json(await storefront.page(page));
    } catch (error) {
      // Só a falta de vitrine servível é 503; um defeito do código segue para o middleware único (500).
      if (
        error instanceof CatalogNotSyncedError ||
        error instanceof CacheUnavailableError
      ) {
        throw new ProblemError({
          status: 503,
          cause: 'service-unavailable',
          title: 'Catálogo indisponível',
          headers: { 'Retry-After': UNAVAILABLE_RETRY_AFTER_SECONDS },
        });
      }
      throw error;
    }
  };

  return {
    handlers: [noStore, validateRequest(productsRoute), listProducts],
  };
}
