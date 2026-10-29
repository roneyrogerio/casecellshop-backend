import { requireEnv } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { migrate, seed } from '../db/migrate.ts';
import { createLogger } from '../logging.ts';

// Serviço de execução única do compose: migra os dois schemas e grava o catálogo
// de exemplo do ERP simulado. Só ele roda o seed.
const logger = createLogger({ service: 'migrate' });
const pool = createPool(requireEnv('DATABASE_URL'), logger);
try {
  await migrate(pool);
  await seed(pool);
  logger.info({ event: 'migrate_completed' }, 'migrações e seed aplicados');
} finally {
  await pool.end();
}
