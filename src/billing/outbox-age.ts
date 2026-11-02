import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { BILLING_LOG_EVENTS, billingMetrics } from './telemetry.ts';

// Gauge da idade da outbox (AD-008: sinal lido do banco, exposto pela API; design.md, "Observabilidade").

export interface OutboxAgeGaugeDependencies {
  pool: Pool;
  telemetry: Telemetry;
  logger: AppLogger;
}

// Registra o callback do `casecellshop.outbox.oldest_pending.age`; devolve a função que o remove. Se a leitura
// falhar, o gauge mantém o último valor: o counter e o evento de falha são o sinal para o alerta.
export function registerOutboxAgeGauge({
  pool,
  telemetry,
  logger,
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
    {
      onError(error) {
        billingMetrics(telemetry).add(
          'casecellshop.billing.gauge.read_failures',
          1,
          { 'casecellshop.gauge.name': 'outbox_oldest_pending_age' },
        );
        eventLogger(logger, BILLING_LOG_EVENTS).error(
          'casecellshop.billing.gauge.read_failed',
          { gauge: 'outbox_oldest_pending_age', err: error },
          'falha ao ler a idade da outbox',
        );
      },
    },
  );
}
