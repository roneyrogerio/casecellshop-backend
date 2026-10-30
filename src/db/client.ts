import type { Pool, PoolClient } from 'pg';

// Um cliente retirado com `pool.connect()` fica sem ouvinte de 'error': o pg-pool
// tira o ouvinte de ocioso na retirada, e o `pool.on('error')` só cobre conexões
// ociosas. Se a conexão cair no meio de uma consulta, o erro vira
// `uncaughtException` e derruba o processo. Estes helpers mantêm um ouvinte
// enquanto o cliente está retirado e descartam a conexão quebrada na devolução.

export async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionError: Error | undefined;
  // O erro também rejeita a consulta em andamento; guardá-lo cobre a queda entre duas consultas.
  const onError = (error: Error): void => {
    connectionError = error;
  };
  client.on('error', onError);

  let failure: Error | undefined;
  try {
    return await fn(client);
  } catch (error) {
    // Sem saber em que estado a falha deixou a conexão, ela não volta ao pool.
    failure = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(connectionError ?? failure);
  }
}

// BEGIN/COMMIT com ROLLBACK na falha. Uma falha de negócio lançada por `fn` (como
// a recusa do ERP) desfaz a transação e devolve a conexão sã ao pool; só o que
// quebra a conexão, ou um ROLLBACK que falha, a descarta.
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionError: Error | undefined;
  const onError = (error: Error): void => {
    connectionError = error;
  };
  client.on('error', onError);

  let discard: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(connectionError ?? discard);
  }
}
