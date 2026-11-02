// A vitrine: a entrada única do cache, carregada do repositório, fatiada em páginas.
import { SpanKind } from '@opentelemetry/api';
import {
  createInMemoryCache,
  type Cache,
  type CacheResult,
} from '../cache/cache.ts';
import { PRODUCTS_PAGE_SIZE, type ProductPage } from '../contract/index.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { availabilityOf } from './availability.ts';
import type { CatalogConfig } from './config.ts';
import type { CatalogRepository, CatalogRow } from './repository.ts';
import { CATALOG_LOG_EVENTS, catalogMetrics } from './telemetry.ts';

// O catálogo ainda não teve uma sincronização completa: a rota responde 503 (CAT-05).
export class CatalogNotSyncedError extends Error {
  constructor() {
    super('catálogo ainda não sincronizado');
    this.name = 'CatalogNotSyncedError';
  }
}

export interface StorefrontDependencies {
  repository: CatalogRepository;
  clock: Clock;
  random: () => number;
  config: CatalogConfig;
  telemetry: Telemetry;
  logger: AppLogger;
}

export interface StorefrontPage {
  page: ProductPage;
  // O resultado da leitura do cache, para o log da requisição.
  cache: CacheResult;
}

export interface Storefront {
  // Página a partir de 1. Rejeita com CatalogNotSyncedError ou CacheUnavailableError (src/cache/), que a rota
  // converte em 503; o span `catalog.cache.get` envolve a leitura do cache.
  page(page: number): Promise<StorefrontPage>;
}

// A carga mede a origem: quantas em andamento, o desfecho e o log da falha. O erro segue para o cache decidir.
function instrumentedLoad(
  deps: StorefrontDependencies,
): () => Promise<CatalogRow[] | null> {
  const metrics = catalogMetrics(deps.telemetry);
  const events = eventLogger(deps.logger, CATALOG_LOG_EVENTS);
  return async () => {
    metrics.add('casecellshop.catalog.origin.active_loads', 1);
    try {
      const rows = await deps.repository.listAll();
      metrics.add('casecellshop.catalog.origin.loads', 1, {
        'casecellshop.catalog.origin.outcome': 'ok',
      });
      return rows;
    } catch (error) {
      metrics.add('casecellshop.catalog.origin.loads', 1, {
        'casecellshop.catalog.origin.outcome': 'error',
      });
      events.warn(
        'casecellshop.catalog.origin.load_failed',
        { err: error },
        'a carga do catálogo a partir do banco falhou',
      );
      throw error;
    } finally {
      metrics.add('casecellshop.catalog.origin.active_loads', -1);
    }
  };
}

function toPage(
  rows: CatalogRow[],
  page: number,
  lowStockMax: number,
): ProductPage {
  const start = (page - 1) * PRODUCTS_PAGE_SIZE;
  const end = start + PRODUCTS_PAGE_SIZE;
  return {
    items: rows.slice(start, end).map((row) => ({
      sku: row.sku,
      name: row.name,
      unitPrice: row.priceCents,
      availability: availabilityOf(row.onHand - row.reserved, lowStockMax),
    })),
    hasNext: rows.length > end,
  };
}

export function createStorefront(deps: StorefrontDependencies): Storefront {
  const metrics = catalogMetrics(deps.telemetry);
  const cache: Cache<CatalogRow[] | null> = createInMemoryCache({
    load: instrumentedLoad(deps),
    clock: deps.clock,
    ttlMs: deps.config.cacheTtlMs,
    ttlJitter: deps.config.cacheTtlJitter,
    staleCeilingMs: deps.config.staleCeilingMs,
    failurePauseMs: deps.config.originFailurePauseMs,
    random: deps.random,
  });

  return {
    async page(page) {
      // O span envolve o get() para o span do repositório nascer como filho dele quando a leitura dispara a carga.
      const lookup = await deps.telemetry.withSpan(
        'catalog.cache.get',
        { kind: SpanKind.INTERNAL },
        () => cache.get(),
      );
      // Só a leitura que serviu uma entrada conta; o 503 sem entrada não tem resultado nem idade.
      metrics.add('casecellshop.catalog.cache.lookups', 1, {
        'casecellshop.catalog.cache.result': lookup.result,
      });
      metrics.record(
        'casecellshop.catalog.served_entry.age',
        lookup.ageMs / 1000,
      );
      if (lookup.value === null) throw new CatalogNotSyncedError();
      return {
        page: toPage(lookup.value, page, deps.config.lowStockMax),
        cache: lookup.result,
      };
    },
  };
}
