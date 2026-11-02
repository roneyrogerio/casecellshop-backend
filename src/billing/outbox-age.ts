import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { billingMetrics } from './telemetry.ts';

// Gauge da idade da outbox (AD-008: sinal lido do banco, exposto pela API; design.md, "Observabilidade").

export interface OutboxAgeGaugeDependencies {
  pool: Pool;
  telemetry: Telemetry;
}

// Registra o callback do `casecellshop.outbox.oldest_pending.age`; devolve a função que o remove.
export function registerOutboxAgeGauge({
  pool,
  telemetry,
}: OutboxAgeGaugeDependencies): () => void {
  const db = createDb(pool);
  return billingMetrics(telemetry).observe(
    'casecellshop.outbox.oldest_pending.age',
    async (observe) => {
      // A idade sai do relógio do banco: o mesmo que grava `created_at`. Linha morta (DLQ) e pedido com
      // desfecho ficam de fora; sem nenhuma linha o `min` é nulo e o gauge vale 0.
      const row = await db
        .selectFrom('outbox')
        .innerJoin('orders', 'orders.id', 'outbox.order_id')
        .where('orders.status', '=', 'pending')
        .where('outbox.dead_at', 'is', null)
        .select((eb) =>
          sql<
            number | null
          >`extract(epoch from now() - ${eb.fn.min('outbox.created_at')})::float8`.as(
            'age',
          ),
        )
        .executeTakeFirst();
      observe(row?.age ?? 0);
    },
  );
}
