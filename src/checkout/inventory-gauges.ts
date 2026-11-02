import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { checkoutMetrics } from './telemetry.ts';

// Gauges do estoque (OBS-06; AD-008: lidos do banco e expostos pela API; design.md, "Observabilidade").

export interface InventoryGaugesDependencies {
  pool: Pool;
  telemetry: Telemetry;
}

// Registra os callbacks de `casecellshop.inventory.reserved` e `casecellshop.inventory.oversold_skus`; devolve a
// função que os remove.
export function registerInventoryGauges({
  pool,
  telemetry,
}: InventoryGaugesDependencies): () => void {
  const db = createDb(pool);
  // Um callback em lote: os dois valores saem da mesma consulta, uma por scrape.
  return checkoutMetrics(telemetry).observeBatch(
    ['casecellshop.inventory.reserved', 'casecellshop.inventory.oversold_skus'],
    async (observe) => {
      const row = await db
        .selectFrom('inventory')
        .select((eb) => [
          sql<number>`coalesce(sum(${eb.ref('reserved')}), 0)::float8`.as(
            'reserved',
          ),
          sql<number>`(count(*) filter (where ${eb.ref('reserved')} > ${eb.ref('on_hand')}))::float8`.as(
            'oversold',
          ),
        ])
        .executeTakeFirst();
      observe['casecellshop.inventory.reserved'](row?.reserved ?? 0);
      observe['casecellshop.inventory.oversold_skus'](row?.oversold ?? 0);
    },
  );
}
