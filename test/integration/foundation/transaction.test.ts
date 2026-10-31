import type { Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createErpDb, type ErpSimDb, runInTransaction, TransactionAbortedError } from '../../../src/db/database.ts';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

// A tabela erp_sim.invoices tem `dedup_key` único, o que dá a violação de unicidade do cenário
// (a `reference` deixou de ser única para o modo sem a H1b).
async function insertInvoice(trx: Transaction<ErpSimDb>, reference: string): Promise<void> {
  await trx
    .insertInto('erp_sim.invoices')
    .values({ reference, dedup_key: reference, items: '[]', total_cents: 0 })
    .execute();
}

// O código do defeito: a segunda gravação viola a unicidade, o erro é capturado e a função
// segue até o fim sem nenhuma consulta depois dele. A transação já está abortada (25P02).
async function insertDuplicateAndSwallow(trx: Transaction<ErpSimDb>, reference: string): Promise<string> {
  await insertInvoice(trx, reference);
  try {
    await insertInvoice(trx, reference);
  } catch {
    // Capturado de propósito: é o defeito que a guarda precisa pegar.
  }
  return 'terminou';
}

async function countInvoices(reference: string): Promise<number> {
  const result = await database.pool.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM erp_sim.invoices WHERE reference = $1',
    [reference],
  );
  return result.rows[0]?.total ?? -1;
}

// Conexão que ficou com a transação aberta depois de o invólucro devolver o controle.
async function idleInTransactionConnections(): Promise<number> {
  const result = await database.pool.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
  );
  return result.rows[0]?.total ?? -1;
}

describe('FND-10 a guarda da transação contra o PostgreSQL real', () => {
  it('FND-10 uma transação sem erro grava e devolve o valor da função', async () => {
    const db = createErpDb(database.erpPool);

    const value = await runInTransaction(db, async (trx) => {
      await insertInvoice(trx, 'fnd10-sem-erro');
      return 42;
    });

    expect(value).toBe(42);
    expect(await countInvoices('fnd10-sem-erro')).toBe(1);
  });

  it('FND-10 a transação que esbarra numa violação de unicidade, captura o erro e continua rejeita com TransactionAbortedError, e a linha não fica gravada', async () => {
    const db = createErpDb(database.erpPool);

    await expect(
      runInTransaction(db, (trx) => insertDuplicateAndSwallow(trx, 'fnd10-capturado')),
    ).rejects.toBeInstanceOf(TransactionAbortedError);

    expect(await countInvoices('fnd10-capturado')).toBe(0);
    // A transação foi desfeita, não largada aberta com a conexão devolvida ao pool.
    expect(await idleInTransactionConnections()).toBe(0);
  });

  it('FND-10 a conexão da transação abortada volta ao pool em estado usável', async () => {
    const db = createErpDb(database.erpPool);

    await expect(
      runInTransaction(db, (trx) => insertDuplicateAndSwallow(trx, 'fnd10-reuso')),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    const value = await runInTransaction(db, async (trx) => {
      await insertInvoice(trx, 'fnd10-reuso');
      return 'ok';
    });

    expect(value).toBe('ok');
    expect(await countInvoices('fnd10-reuso')).toBe(1);
  });

  it('FND-10 um erro lançado pela função desfaz a transação e chega ao chamador como foi lançado', async () => {
    const db = createErpDb(database.erpPool);
    const failure = new Error('falha de negócio');

    await expect(
      runInTransaction(db, async (trx) => {
        await insertInvoice(trx, 'fnd10-falha-de-negocio');
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await countInvoices('fnd10-falha-de-negocio')).toBe(0);
    expect(await idleInTransactionConnections()).toBe(0);
  });

  it('FND-10 controle negativo: o db.transaction().execute() do Kysely, sem a guarda, resolve sem erro e também não grava nada', async () => {
    const db = createErpDb(database.erpPool);

    const value = await db.transaction().execute((trx) => insertDuplicateAndSwallow(trx, 'fnd10-sem-guarda'));

    // O PostgreSQL trocou o COMMIT por um ROLLBACK sem erro: é o defeito que a guarda evita.
    expect(value).toBe('terminou');
    expect(await countInvoices('fnd10-sem-guarda')).toBe(0);
  });
});
