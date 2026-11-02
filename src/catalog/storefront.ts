// A vitrine: a entrada única do cache, carregada do repositório, fatiada em páginas.
import type { ProductPage } from '../contract/index.ts';
import type { Clock } from '../shared/clock.ts';
import type { AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import type { CatalogConfig } from './config.ts';
import type { CatalogRepository } from './repository.ts';

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

export interface Storefront {
  // Página a partir de 1. Rejeita com CatalogNotSyncedError ou CacheUnavailableError (src/cache/), que a rota
  // converte em 503; o span `catalog.cache.get` envolve a leitura do cache.
  page(page: number): Promise<ProductPage>;
}

export function createStorefront(_deps: StorefrontDependencies): Storefront {
  return { page: () => Promise.reject(new Error('não implementado')) };
}
