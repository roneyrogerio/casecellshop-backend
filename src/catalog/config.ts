// Os parâmetros da vitrine e da sincronização (design.md, "Parâmetros"), como padrão: o src/main não os muda, e os
// testes trocam só o que precisam.
export interface CatalogConfig {
  cacheTtlMs: number;
  cacheTtlJitter: number;
  staleCeilingMs: number;
  originFailurePauseMs: number;
  // Até quantas unidades livres o produto aparece como "últimas unidades".
  lowStockMax: number;
  // Segundos do Retry-After do 503, o mesmo do /health.
  retryAfterSeconds: number;
}

export const DEFAULT_CATALOG_CONFIG: CatalogConfig = {
  cacheTtlMs: 5_000,
  cacheTtlJitter: 0.1,
  staleCeilingMs: 60_000,
  originFailurePauseMs: 5_000,
  lowStockMax: 5,
  retryAfterSeconds: 5,
};

export interface CatalogSyncConfig {
  intervalMs: number;
}

export const DEFAULT_CATALOG_SYNC_CONFIG: CatalogSyncConfig = {
  intervalMs: 60_000,
};
