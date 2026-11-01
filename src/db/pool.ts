import pg from 'pg';
import type { Logger } from 'pino';

// design.md, "Parâmetros": 5 s / 2 s / 1 s; ninguém espera indefinidamente.
export const STATEMENT_TIMEOUT_MS = 5_000;
export const LOCK_TIMEOUT_MS = 2_000;
export const CONNECTION_TIMEOUT_MS = 1_000;
export const POOL_SIZE = 10;

function buildPool(config: pg.PoolConfig, logger: Logger): pg.Pool {
  const pool = new pg.Pool(config);
  // Sem este ouvinte, o erro de uma conexão ociosa derrubaria o processo.
  pool.on('error', (error) => {
    logger.error(
      { event: 'db_pool_error', err: error },
      'erro numa conexão ociosa do banco',
    );
  });
  return pool;
}

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  return buildPool(
    {
      connectionString,
      max: POOL_SIZE,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
    },
    logger,
  );
}

// Pool só do serviço de migração. Sem statement_timeout nem lock_timeout (o
// padrão do pg é não ter limite): esses dois cortariam a espera pelo advisory
// lock de outra instância e uma migração longa. A espera por conexão mantém o
// prazo de 1 s: nada espera indefinidamente, e um banco mudo deixaria o migrate
// parado para sempre, com a API e o worker sem subir. Roda uma vez e sai, então
// duas conexões bastam.
export function createMigrationPool(
  connectionString: string,
  logger: Logger,
): pg.Pool {
  return buildPool(
    {
      connectionString,
      max: 2,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    },
    logger,
  );
}
