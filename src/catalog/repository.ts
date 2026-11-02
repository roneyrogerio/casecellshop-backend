// A origem do cache da vitrine: o banco da loja, nunca o ERP (AD-005).
import type { Pool } from 'pg';
import type { Telemetry } from '../shared/telemetry.ts';

export interface CatalogRow {
  sku: string;
  name: string;
  priceCents: number;
  onHand: number;
  reserved: number;
}

export interface CatalogRepository {
  // Todos os produtos com o estoque, em ordem de SKU; `null` antes da primeira sincronização completa (CAT-05).
  // O span `catalog.repository.list` é CLIENT e filho do span ativo (CAT-12).
  listAll(): Promise<CatalogRow[] | null>;
}

export function createCatalogRepository(
  _pool: Pool,
  _telemetry: Telemetry,
): CatalogRepository {
  return { listAll: () => Promise.reject(new Error('não implementado')) };
}
