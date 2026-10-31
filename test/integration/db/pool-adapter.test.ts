import type { Socket } from 'node:net';
import { Kysely, PostgresDialect, type PostgresPool, type QueryExecutorProvider, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createErpDb, type ErpSimDb } from '../../../src/db/database.ts';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

// Client cujo ROLLBACK rejeita sem derrubar a conexão: o texto nem chega ao servidor, então a
// transação continua aberta e a conexão continua viva (o caso que o pg-pool não descarta sozinho).
class RollbackFailingClient extends pg.Client {
  constructor(config?: pg.ClientConfig) {
    super(config);
    const original = this.query.bind(this) as (...args: unknown[]) => unknown;
    // Gravável: o adaptador pode embrulhar a `query` do cliente por cima desta.
    Object.defineProperty(this, 'query', {
      writable: true,
      configurable: true,
      value: (...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text;
        if (typeof text === 'string' && /^\s*rollback\s*;?\s*$/i.test(text)) {
          return Promise.reject(new Error('ROLLBACK recusado pelo teste'));
        }
        return original(...args);
      },
    });
  }
}

const noop = (): void => undefined;

function createTestPool(options: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool({ connectionString: database.uri, ...options });
  // Um erro de conexão ociosa não pode derrubar o processo do teste.
  pool.on('error', noop);
  return pool;
}

// Adaptador ingênuo: só repassa connect e chama release() sem argumento, como o Kysely faz. É o
// controle negativo do descarte: o pg-pool só descarta a conexão quando o release recebe o erro.
function createNaivePoolAdapter(pool: pg.Pool): PostgresPool {
  return {
    options: pool.options,
    async connect() {
      const client = await pool.connect();
      const release = client.release.bind(client);
      client.release = () => release();
      return client;
    },
    end: () => pool.end(),
  };
}

async function backendPid(executor: QueryExecutorProvider): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(executor);
  return result.rows[0]?.pid ?? -1;
}

async function backendExists(pid: number): Promise<boolean> {
  const result = await database.pool.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.total === 1;
}

// Destrói o socket do cliente enquanto a consulta `pg_sleep(<segundos>)` roda no servidor.
async function destroySocketDuringQuery(
  seconds: number,
  run: (db: Kysely<ErpSimDb>) => Promise<unknown>,
): Promise<{ outcome: unknown; uncaught: Error[]; stillWorks: boolean }> {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error): void => {
    uncaught.push(error);
  };
  process.on('uncaughtException', onUncaught);
  const clients: pg.Client[] = [];
  const pool = createTestPool({ max: 2 });
  pool.on('connect', (client) => clients.push(client));
  const db = createErpDb(pool);
  try {
    const pending = run(db).then(
      () => 'resolveu',
      (error: unknown) => error,
    );
    // Espera a consulta estar rodando no servidor antes de destruir o socket.
    await vi.waitFor(async () => {
      const active = await database.pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM pg_stat_activity
         WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE $1`,
        [`%pg_sleep(${seconds})%`],
      );
      expect(active.rows[0]?.total).toBe(1);
    });
    const client = clients[0] as unknown as { connection: { stream: Socket } };
    client.connection.stream.destroy(new Error('socket destruído pelo teste'));

    const outcome = await pending;
    // O 'error' do cliente é emitido no mesmo evento do socket; um turno do laço basta para um crash aparecer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const check = await sql<{ ok: number }>`select 1 as ok`.execute(db).then(
      (result) => result.rows[0]?.ok === 1,
      () => false,
    );
    return { outcome, uncaught, stillWorks: check };
  } finally {
    process.off('uncaughtException', onUncaught);
    await pool.end();
  }
}

describe('FND-10 o adaptador do pool: ouvinte de error em toda conexão retirada', () => {
  it('FND-10 destruir o socket no meio de uma consulta fora de transação não derruba o processo', async () => {
    const result = await destroySocketDuringQuery(30, (db) => sql`select pg_sleep(30)`.execute(db));

    expect(result.outcome).toBeInstanceOf(Error);
    expect(result.uncaught).toEqual([]);
    // A conexão caída não fica no pool: a próxima consulta abre outra e funciona.
    expect(result.stillWorks).toBe(true);
  });

  it('FND-10 destruir o socket no meio de uma consulta dentro de transação também não derruba o processo', async () => {
    const result = await destroySocketDuringQuery(31, (db) =>
      db.transaction().execute((trx) => sql`select pg_sleep(31)`.execute(trx)),
    );

    expect(result.outcome).toBeInstanceOf(Error);
    expect(result.uncaught).toEqual([]);
    expect(result.stillWorks).toBe(true);
  });
});

describe('FND-10 o adaptador do pool: descarte da conexão cujo ROLLBACK falhou', () => {
  // Uma transação que falha, com o ROLLBACK recusado; devolve o pid da conexão que a rodou.
  async function failTransaction(db: Kysely<ErpSimDb>): Promise<number> {
    let pidInTransaction = -1;
    await expect(
      db.transaction().execute(async (trx) => {
        pidInTransaction = await backendPid(trx);
        throw new Error('falha de negócio');
      }),
    ).rejects.toBeInstanceOf(Error);
    return pidInTransaction;
  }

  it('FND-10 um ROLLBACK que falha com a conexão ainda viva deixa a conexão fora do pool: a seguinte tem outro pg_backend_pid()', async () => {
    const pool = createTestPool({ max: 1, Client: RollbackFailingClient });
    const db = createErpDb(pool);
    try {
      const pidInTransaction = await failTransaction(db);
      const pidAfter = await backendPid(db);

      expect(pidAfter).not.toBe(pidInTransaction);
      // Descartar é fechar a conexão: o servidor não guarda mais a transação aberta.
      await vi.waitFor(async () => {
        expect(await backendExists(pidInTransaction)).toBe(false);
      });
    } finally {
      await pool.end();
    }
  });

  it('FND-10 controle negativo: com um adaptador ingênuo, o mesmo cenário devolve ao pool a mesma conexão (o mesmo pg_backend_pid())', async () => {
    const pool = createTestPool({ max: 1, Client: RollbackFailingClient });
    const db = new Kysely<ErpSimDb>({ dialect: new PostgresDialect({ pool: createNaivePoolAdapter(pool) }) });
    try {
      const pidInTransaction = await failTransaction(db);
      const pidAfter = await backendPid(db);

      expect(pidAfter).toBe(pidInTransaction);
    } finally {
      await pool.end();
    }
  });

  it('FND-10 um ROLLBACK que funciona devolve a conexão ao pool: a seguinte é a mesma', async () => {
    const pool = createTestPool({ max: 1 });
    const db = createErpDb(pool);
    try {
      const pidInTransaction = await failTransaction(db);
      const pidAfter = await backendPid(db);

      expect(pidAfter).toBe(pidInTransaction);
    } finally {
      await pool.end();
    }
  });
});
