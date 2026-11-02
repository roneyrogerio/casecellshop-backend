import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { CHECKOUT_LOG_EVENTS, checkoutMetrics } from './telemetry.ts';

// Gauges do estoque (OBS-06; AD-008: lidos do banco e expostos pela API; design.md, "Observabilidade").

export interface InventoryGaugesDependencies {
  pool: Pool;
  telemetry: Telemetry;
  logger: AppLogger;
}

// Registra os callbacks de `casecellshop.inventory.reserved` e `casecellshop.inventory.oversold_skus`; devolve a
// função que os remove. Se a leitura falhar, os gauges mantêm o último valor: o counter e o evento de falha são o
// sinal para o alerta.
export function registerInventoryGauges({
  pool,
  telemetry,
  logger,
}: InventoryGaugesDependencies): () => void {
  const db = createDb(pool);
  // Um callback em lote: os dois valores saem da mesma consulta, uma por scrape.
  return checkoutMetrics(telemetry).observeBatch(
    ['casecellshop.inventory.reserved', 'casecellshop.inventory.oversold_skus'],
    async (observe) => {
      const row = await db
        .selectFrom('inventory')
        .select((eb) => [
          eb
            .cast<number>(
              eb.fn.coalesce(eb.fn.sum('reserved'), eb.lit(0)),
              'float8',
            )
            .as('reserved'),
          eb
            .cast<number>(
              eb.fn.countAll().filterWhere('reserved', '>', eb.ref('on_hand')),
              'float8',
            )
            .as('oversold'),
        ])
        .executeTakeFirst();
      observe['casecellshop.inventory.reserved'](row?.reserved ?? 0);
      observe['casecellshop.inventory.oversold_skus'](row?.oversold ?? 0);
    },
    {
      onError(error) {
        checkoutMetrics(telemetry).add(
          'casecellshop.checkout.gauge.read_failures',
          1,
          { 'casecellshop.gauge.name': 'inventory' },
        );
        eventLogger(logger, CHECKOUT_LOG_EVENTS).error(
          'casecellshop.checkout.gauge.read_failed',
          { gauge: 'inventory', err: error },
          'falha ao ler os gauges do estoque',
        );
      },
    },
  );
}
