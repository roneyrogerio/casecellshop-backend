import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { CATALOG_LOG_EVENTS, catalogMetrics } from './telemetry.ts';

// Gauge da idade da sincronização (CAT-15, AD-008: sinal lido do banco, exposto pela API; assim segue crescendo
// com o worker parado).

export interface SyncAgeGaugeDependencies {
  pool: Pool;
  telemetry: Telemetry;
  logger: AppLogger;
}

// Registra o callback do `casecellshop.catalog.sync.age`; devolve a função que o remove. Se a leitura falhar, o
// gauge mantém o último valor: o counter e o evento de falha são o sinal para o alerta.
export function registerSyncAgeGauge({
  pool,
  telemetry,
  logger,
}: SyncAgeGaugeDependencies): () => void {
  const db = createDb(pool);
  return catalogMetrics(telemetry).observe(
    'casecellshop.catalog.sync.age',
    async (observe) => {
      // Relógio do banco, o mesmo que grava `last_completed_at`. Sem rodada completa a marca é nula e o gauge
      // não grava ponto: o alerta de ERP fora lê a ausência.
      const row = await db
        .selectFrom('sync_state')
        .select((eb) =>
          sql<
            number | null
          >`extract(epoch from now() - ${eb.ref('last_completed_at')})::float8`.as(
            'age',
          ),
        )
        .executeTakeFirst();
      if (row?.age != null) observe(row.age);
    },
    {
      onError: (error) => {
        catalogMetrics(telemetry).add(
          'casecellshop.catalog.gauge.read_failures',
          1,
          { 'casecellshop.gauge.name': 'catalog_sync_age' },
        );
        eventLogger(logger, CATALOG_LOG_EVENTS).error(
          'casecellshop.catalog.gauge.read_failed',
          { gauge: 'catalog_sync_age', err: error },
          'falha ao ler a idade da sincronização',
        );
      },
    },
  );
}
