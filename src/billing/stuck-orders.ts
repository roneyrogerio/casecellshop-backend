import { sql, type Kysely } from 'kysely';
import type { Pool } from 'pg';
import { createDb, type StoreDb } from '../db/database.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { BILLING_LOG_EVENTS, billingMetrics } from './telemetry.ts';

// Pedidos sem desfecho em 60 s (OBS-04; design.md, "Observabilidade"): a verificação periódica da API marca a
// linha com `sli_breached_at` por `UPDATE … RETURNING` e conta só o que marcou, uma vez em qualquer réplica.

export interface StuckOrderMonitorConfig {
  intervalMs: number;
  thresholdSeconds: number;
  batchSize: number;
}

export const DEFAULT_STUCK_ORDER_MONITOR_CONFIG: StuckOrderMonitorConfig = {
  intervalMs: 10_000,
  thresholdSeconds: 60,
  batchSize: 500,
};

export interface StuckOrderMonitorDependencies {
  pool: Pool;
  logger: AppLogger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<StuckOrderMonitorConfig>;
}

export interface StuckOrderMonitor {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Uma verificação: resolve com o número de pedidos que esta chamada marcou.
  checkOnce(): Promise<number>;
}

// Um lote por chamada. O SKIP LOCKED pula o pedido que uma conclusão está travando (ele entra na verificação
// seguinte) e deixa duas réplicas levarem lotes diferentes; o `sli_breached_at IS NULL` repetido no UPDATE fecha a
// janela em que outra réplica marcou a linha entre a escolha e a escrita (no Read Committed o PostgreSQL reavalia o
// WHERE sobre a versão nova da linha). O contador soma as linhas que o RETURNING devolve: só as que esta chamada
// marcou.
async function markBatch(
  db: Kysely<StoreDb>,
  telemetry: Telemetry,
  settings: StuckOrderMonitorConfig,
): Promise<number> {
  // O limite entra como parâmetro, nunca interpolado no texto da consulta.
  const threshold = sql`make_interval(secs => ${settings.thresholdSeconds})`;
  const marked = await db
    .updateTable('orders')
    .set({ sli_breached_at: sql<Date>`now()` })
    .where('sli_breached_at', 'is', null)
    .where('id', 'in', (eb) =>
      eb
        .selectFrom('orders')
        .select('id')
        .where('sli_breached_at', 'is', null)
        .where((cond) =>
          cond.and([
            cond(
              cond.ref('accepted_at'),
              '<=',
              sql<Date>`now() - ${threshold}`,
            ),
            cond.or([
              cond('outcome_at', 'is', null),
              cond(
                'outcome_at',
                '>',
                sql<Date>`${cond.ref('accepted_at')} + ${threshold}`,
              ),
            ]),
          ]),
        )
        .orderBy('accepted_at')
        .limit(settings.batchSize)
        .forUpdate()
        .skipLocked(),
    )
    .returning('id')
    .execute();
  if (marked.length > 0)
    billingMetrics(telemetry).add('casecellshop.order.stuck', marked.length);
  return marked.length;
}

export function createStuckOrderMonitor({
  pool,
  logger,
  telemetry,
  clock,
  config,
}: StuckOrderMonitorDependencies): StuckOrderMonitor {
  const settings: StuckOrderMonitorConfig = {
    ...DEFAULT_STUCK_ORDER_MONITOR_CONFIG,
    ...config,
  };
  const db = createDb(pool);
  const checkOnce = () => markBatch(db, telemetry, settings);

  const runner = createLoopRunner({
    async run(isRunning) {
      while (isRunning()) {
        try {
          await checkOnce();
        } catch (error) {
          // A falha de uma rodada não derruba o laço: a seguinte tenta de novo.
          eventLogger(logger, BILLING_LOG_EVENTS).error(
            'casecellshop.order.stuck_check.failed',
            { err: error },
            'falha na verificação dos pedidos sem desfecho',
          );
        }
        if (isRunning()) await clock.sleep(settings.intervalMs);
      }
    },
  });

  return {
    start: () => runner.start(),
    stop: () => runner.stop(),
    checkOnce,
  };
}
