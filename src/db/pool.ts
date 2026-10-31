import pg from 'pg';
import type { Logger } from 'pino';

// design.md, "Parâmetros": 5 s / 2 s / 1 s; ninguém espera indefinidamente.
export const STATEMENT_TIMEOUT_MS = 5_000;
export const LOCK_TIMEOUT_MS = 2_000;
export const CONNECTION_TIMEOUT_MS = 1_000;
export const POOL_SIZE = 10;

export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: POOL_SIZE,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
  });
  // Sem este ouvinte, o erro de uma conexão ociosa derrubaria o processo.
  pool.on('error', (error) => {
    logger.error({ event: 'db_pool_error', err: error }, 'erro numa conexão ociosa do banco');
  });
  return pool;
}

// Pool só do serviço de migração, sem os limites das requisições. Stub: o
// implementer escreve o corpo.
export function createMigrationPool(_connectionString: string, _logger: Logger): pg.Pool {
  throw new Error('não implementado');
}
