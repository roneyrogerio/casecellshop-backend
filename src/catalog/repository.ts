// A origem do cache da vitrine: o banco da loja, nunca o ERP (AD-005).
import { SpanKind } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
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
  pool: Pool,
  telemetry: Telemetry,
): CatalogRepository {
  const db = createDb(pool);
  return {
    listAll() {
      return telemetry.withSpan(
        'catalog.repository.list',
        {
          kind: SpanKind.CLIENT,
          attributes: { 'db.system.name': 'postgresql' },
        },
        async () => {
          const state = await db
            .selectFrom('sync_state')
            .select('last_completed_at')
            .executeTakeFirst();
          if (!state?.last_completed_at) return null;
          const rows = await db
            .selectFrom('products')
            .innerJoin('inventory', 'inventory.sku', 'products.sku')
            .select([
              'products.sku',
              'products.name',
              'products.price_cents',
              'inventory.on_hand',
              'inventory.reserved',
            ])
            .orderBy('products.sku')
            .execute();
          return rows.map((row) => ({
            sku: row.sku,
            name: row.name,
            priceCents: row.price_cents,
            onHand: row.on_hand,
            reserved: row.reserved,
          }));
        },
      );
    },
  };
}
