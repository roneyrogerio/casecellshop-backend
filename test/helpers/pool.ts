import pg from 'pg';

// Única porta de entrada dos pools de teste (FND-13, "Encerramento"): todo pool nasce com o ouvinte de `error`.
// Sem ele, a conexão ociosa que o servidor derruba (57P01, no stop() do contêiner ou no DROP ... WITH (FORCE))
// vira uma uncaughtException e o vitest reprova a rodada inteira por um teste que já passou.
// Os limites (max, statement_timeout, lock_timeout, espera por conexão) entram por `config`.
export type TestPoolConfig = Omit<pg.PoolConfig, 'connectionString'>;

const DEFAULT_MAX = 5;

export function createTestPool(
  uri: string,
  config: TestPoolConfig = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: uri,
    max: DEFAULT_MAX,
    ...config,
  });
  pool.on('error', () => undefined);
  return pool;
}

// Só o controle negativo do FND-13: prova que, sem o ouvinte, o 57P01 escapa como uncaughtException. Nenhum outro
// teste deve usá-la.
export function createPoolWithoutErrorListener(
  uri: string,
  config: TestPoolConfig = {},
): pg.Pool {
  return new pg.Pool({ connectionString: uri, max: DEFAULT_MAX, ...config });
}
