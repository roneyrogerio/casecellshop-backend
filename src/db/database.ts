import type { Kysely, PostgresPool, Transaction } from 'kysely';
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

// Stub da fatia 2: o implementer escreve o corpo.
export function createPoolAdapter(_pool: Pool): PostgresPool {
  throw new Error('não implementado');
}

export function createDb(_pool: Pool): Kysely<StoreDb> {
  throw new Error('não implementado');
}

export function createErpDb(_pool: Pool): Kysely<ErpSimDb> {
  throw new Error('não implementado');
}

export function runInTransaction<DB, T>(_db: Kysely<DB>, _fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return Promise.reject(new Error('não implementado'));
}
