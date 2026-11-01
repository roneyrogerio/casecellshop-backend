import {
  Kysely,
  PostgresDialect,
  type PostgresPool,
  type PostgresPoolClient,
  sql,
  type Transaction,
} from 'kysely';
import type { Pool } from 'pg';
import type { DB as ErpSimDb } from './types/erp-sim.ts';
import type { DB as StoreDb } from './types/store.ts';

export type { ErpSimDb, StoreDb };

// A guarda antes do COMMIT recebeu 25P02: um erro capturado já tinha abortado a
// transação, e o PostgreSQL trocaria o COMMIT por um ROLLBACK sem erro (FND-10).
export class TransactionAbortedError extends Error {
  constructor(options?: ErrorOptions) {
    super('a transação foi abortada antes do COMMIT', options);
    this.name = 'TransactionAbortedError';
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function queryText(first: unknown): string | undefined {
  if (typeof first === 'string') return first;
  const text = (first as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

// Um cliente retirado com `pool.connect()` fica sem ouvinte de 'error': o pg-pool
// tira o ouvinte de ocioso na retirada, e o `pool.on('error')` só cobre conexões
// ociosas. Se a conexão cair no meio de uma consulta, o erro vira
// `uncaughtException` e derruba o processo. O adaptador mantém um ouvinte
// enquanto o cliente está retirado. E o Kysely devolve a conexão com `release()`
// sem argumento: sem o erro, o pg-pool a reaproveitaria mesmo depois de um
// ROLLBACK que falhou, com a transação ainda aberta no servidor.
export function createPoolAdapter(pool: Pool): PostgresPool {
  return {
    options: pool.options,
    async connect(): Promise<PostgresPoolClient> {
      const client = await pool.connect();
      let discard: Error | undefined;
      const onError = (error: Error): void => {
        discard = error;
      };
      client.on('error', onError);

      // Visão do cliente com propriedades-função: a `query` do pg tem muitas sobrecargas.
      const raw = client as unknown as {
        query: (...args: unknown[]) => unknown;
        release: (error?: Error | boolean) => void;
      };
      const originalQuery = raw.query;
      const originalRelease = raw.release;
      const wrappedQuery = (...args: unknown[]): unknown => {
        const result = originalQuery.apply(client, args);
        if (
          /^\s*rollback\s*;?\s*$/i.test(queryText(args[0]) ?? '') &&
          result instanceof Promise
        ) {
          return result.catch((error: unknown) => {
            discard ??= toError(error);
            throw error;
          });
        }
        return result;
      };
      raw.query = wrappedQuery;
      raw.release = (error?: Error | boolean): void => {
        client.removeListener('error', onError);
        raw.query = originalQuery;
        raw.release = originalRelease;
        originalRelease.call(client, discard ?? error);
      };
      return client;
    },
    end: () => pool.end(),
  };
}

// O pool pertence a quem o criou: o Kysely nunca é destruído aqui.
export function createDb(pool: Pool): Kysely<StoreDb> {
  return new Kysely<StoreDb>({
    dialect: new PostgresDialect({ pool: createPoolAdapter(pool) }),
  });
}

export function createErpDb(pool: Pool): Kysely<ErpSimDb> {
  return new Kysely<ErpSimDb>({
    dialect: new PostgresDialect({ pool: createPoolAdapter(pool) }),
  });
}

// Único invólucro de transação (FND-10). Uma consulta de guarda antes do COMMIT
// pega a transação que um erro capturado já abortou (25P02).
export async function runInTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const trx = await db.startTransaction().execute();
  try {
    const result = await fn(trx);
    try {
      await trx.selectNoFrom(sql<number>`1`.as('guard')).execute();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === '25P02') {
        throw new TransactionAbortedError({ cause: error });
      }
      throw error;
    }
    await trx.commit().execute();
    return result;
  } catch (error) {
    try {
      await trx.rollback().execute();
    } catch {
      // O erro que importa é o original; o adaptador já descarta a conexão se o ROLLBACK falhou.
    }
    throw error;
  }
}
