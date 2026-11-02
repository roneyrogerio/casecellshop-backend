import { createMigrationPool } from '../db/pool.ts';
import { migrate, seed } from '../db/migrate.ts';
import { requireEnv } from '../shared/config.ts';
import { createLogger, eventLogger } from '../shared/logging.ts';
import { MAIN_LOG_EVENTS } from './telemetry.ts';

// Serviço de execução única do compose: migra os dois schemas e grava o catálogo
// de exemplo do ERP simulado. Só ele roda o seed.
const logger = createLogger({ serviceName: 'casecellshop-migrate' });
const pool = createMigrationPool(requireEnv('DATABASE_URL'), logger);
try {
  await migrate(pool);
  await seed(pool);
  eventLogger(logger, MAIN_LOG_EVENTS).info(
    'casecellshop.migration.completed',
    {},
    'migrações e seed aplicados',
  );
} finally {
  await pool.end();
}
