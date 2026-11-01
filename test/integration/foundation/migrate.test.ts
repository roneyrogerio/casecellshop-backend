import { promises as fs } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MIGRATION_FOLDERS, migrate } from '../../../src/db/migrate.ts';
import { createMigrationPool, createPool } from '../../../src/db/pool.ts';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import { captureUncaught } from '../../helpers/uncaught.ts';
import { createTestPool } from '../../helpers/pool.ts';
import { repoRoot } from '../../helpers/repo-root.ts';
import {
  appliedMigrations,
  fixtureFolder,
  type MigrationContainer,
  runPlainMigrator,
  type ScratchDatabase,
  startMigrationContainer,
  tableExists,
} from '../../helpers/migration-database.ts';

let container: MigrationContainer;

beforeAll(async () => {
  container = await startMigrationContainer();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('FND-11 migrate aplica as pastas pelo Migrator do Kysely', () => {
  it('FND-11 as duas pastas do repositório são o padrão, a da loja antes e o erp_sim depois', () => {
    expect(MIGRATION_FOLDERS).toEqual([
      { dir: path.join(repoRoot, 'migrations', 'store'), schema: 'public' },
      { dir: path.join(repoRoot, 'migrations', 'erp_sim'), schema: 'erp_sim' },
    ]);
  });

  it('FND-11 aplica as pastas na ordem dada, cada uma com a kysely_migration no próprio schema', async () => {
    const { pool } = await container.createDatabase();

    await migrate(pool, [
      fixtureFolder('order/first'),
      fixtureFolder('order/second', 'fnd11_second'),
    ]);

    // A pasta "second" escreve numa tabela que só a "first" cria: a ordem aparece no registro.
    const log = await pool.query<{ who: string }>(
      'SELECT who FROM fnd11_order_log ORDER BY id',
    );
    expect(log.rows.map((row) => row.who)).toEqual([
      'first-1',
      'first-2',
      'second-1',
    ]);
    expect(await appliedMigrations(pool, 'public')).toEqual([
      '20260101000000_create_log',
      '20260101000001_second_migration',
    ]);
    expect(await appliedMigrations(pool, 'fnd11_second')).toEqual([
      '20260101000000_uses_log',
    ]);
  });

  it('FND-11 controle negativo: as pastas na ordem inversa rejeitam, porque a ordem dada é a que vale', async () => {
    const { pool } = await container.createDatabase();

    await expect(
      migrate(pool, [
        fixtureFolder('order/second', 'fnd11_second'),
        fixtureFolder('order/first'),
      ]),
    ).rejects.toThrow(/fnd11_order_log/);

    expect(await tableExists(pool, 'public.fnd11_order_log')).toBe(false);
  });

  it('FND-11 a tabela de controle fica no schema da pasta, e rodar de novo não reaplica nada', async () => {
    const { pool } = await container.createDatabase();
    const folder = fixtureFolder('basic', 'fnd11_controle');

    await migrate(pool, [folder]);
    await migrate(pool, [folder]);

    expect(await appliedMigrations(pool, 'fnd11_controle')).toEqual([
      '20260101000000_create_a',
      '20260101000001_create_b',
    ]);
    expect(await tableExists(pool, 'public.kysely_migration')).toBe(false);
    expect(await tableExists(pool, 'public.fnd11_basic_a')).toBe(true);
    expect(await tableExists(pool, 'public.fnd11_basic_b')).toBe(true);
  });

  it('FND-11 uma migração que chegou com nome anterior ao da última aplicada rejeita (sem allowUnorderedMigrations)', async () => {
    const { uri, pool } = await container.createDatabase();
    await migrate(pool, [fixtureFolder('out-of-order/executed')]);

    await expect(
      migrate(pool, [fixtureFolder('out-of-order/complete')]),
    ).rejects.toThrow(/20260102000000_b/);

    expect(await tableExists(pool, 'public.fnd11_order_a')).toBe(false);
    // Controle negativo: com allowUnorderedMigrations o Migrator aplicaria a migração atrasada.
    const control = await runPlainMigrator(
      uri,
      fixtureFolder('out-of-order/complete'),
      {
        migrator: { allowUnorderedMigrations: true },
      },
    );
    expect(control.error).toBeUndefined();
    expect(await tableExists(pool, 'public.fnd11_order_a')).toBe(true);
  });
});

describe('FND-11 migrate recusa o que o migrador pularia ou aceitaria em silêncio', () => {
  it('FND-11 um .sql na pasta faz o migrate rejeitar, e nada da pasta é aplicado', async () => {
    const { pool } = await container.createDatabase();

    await expect(
      migrate(pool, [fixtureFolder('leftover-sql')]),
    ).rejects.toThrow(/20260101000001_old\.sql/);

    expect(await tableExists(pool, 'public.fnd11_sql_ok')).toBe(false);
    expect(await tableExists(pool, 'public.fnd11_sql_leftover')).toBe(false);
  });

  it('FND-11 controle negativo do .sql: sem o onFileIgnored o arquivo é pulado e o migrador resolve', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder('leftover-sql'));

    expect(result.error).toBeUndefined();
    expect(await tableExists(pool, 'public.fnd11_sql_ok')).toBe(true);
    // O .sql foi pulado sem aviso: é exatamente o que o gancho existe para impedir.
    expect(await tableExists(pool, 'public.fnd11_sql_leftover')).toBe(false);
  });

  it('FND-11 um .ts que não exporta up (só down) faz o migrate rejeitar pelo onFileIgnored', async () => {
    const { pool } = await container.createDatabase();

    await expect(migrate(pool, [fixtureFolder('missing-up')])).rejects.toThrow(
      /20260101000001_only_down\.ts/,
    );

    expect(await tableExists(pool, 'public.fnd11_missing_up_ok')).toBe(false);
  });

  it('FND-11 controle negativo do .ts sem up: sem o onFileIgnored o arquivo é pulado e o migrador resolve', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder('missing-up'));

    expect(result.error).toBeUndefined();
    expect(await tableExists(pool, 'public.fnd11_missing_up_ok')).toBe(true);
  });

  it('FND-11 o .gitkeep da pasta não conta como arquivo ignorado', async () => {
    const { pool } = await container.createDatabase();

    await migrate(pool, [fixtureFolder('gitkeep')]);

    expect(await tableExists(pool, 'public.fnd11_gitkeep')).toBe(true);
  });

  it('FND-11 controle negativo do .gitkeep: um gancho que lança para todo arquivo ignorado reprova a mesma pasta', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder('gitkeep'), {
      provider: {
        onFileIgnored: (fileName) => {
          throw new Error(`ignorado: ${fileName}`);
        },
      },
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(await tableExists(pool, 'public.fnd11_gitkeep')).toBe(false);
  });
});

describe('FND-11 migrate só aceita módulo .ts com down', () => {
  const cases = [
    ['um .mjs', 'mjs', '20260101000000_module.mjs', 'fnd11_mjs'],
    [
      'um .ts sem down',
      'ts-missing-down',
      '20260101000000_missing_down.ts',
      'fnd11_missing_down',
    ],
  ] as const;

  it.each(cases)(
    'FND-11 %s faz o migrate rejeitar pelo import, e a migração não é aplicada',
    async (_label, scenario, file, table) => {
      const { pool } = await container.createDatabase();

      await expect(migrate(pool, [fixtureFolder(scenario)])).rejects.toThrow(
        file,
      );

      expect(await tableExists(pool, `public.${table}`)).toBe(false);
    },
  );

  it.each(cases)(
    'FND-11 controle negativo de %s: sem o import próprio a migração é aplicada',
    async (_label, scenario, _file, table) => {
      const { uri, pool } = await container.createDatabase();

      const result = await runPlainMigrator(uri, fixtureFolder(scenario));

      expect(result.error).toBeUndefined();
      expect(await tableExists(pool, `public.${table}`)).toBe(true);
    },
  );
});

describe('FND-11 as pendentes de um schema rodam numa transação só', () => {
  it('FND-11 uma segunda migração que lança erro faz o migrate rejeitar sem deixar nada da primeira', async () => {
    const { pool } = await container.createDatabase();

    await expect(
      migrate(pool, [fixtureFolder('fails-on-second')]),
    ).rejects.toThrow(/falha de propósito/);

    expect(await tableExists(pool, 'public.fnd11_fail_first')).toBe(false);
    // Nem o que a segunda fez antes de lançar.
    expect(await tableExists(pool, 'public.fnd11_fail_second')).toBe(false);
    expect(await appliedMigrations(pool, 'public')).toEqual([]);
  });

  it('FND-11 controle negativo: com disableTransactions a primeira migração fica gravada', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(
      uri,
      fixtureFolder('fails-on-second'),
      {
        migrator: { disableTransactions: true },
      },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(await tableExists(pool, 'public.fnd11_fail_first')).toBe(true);
    expect(await appliedMigrations(pool, 'public')).toEqual([
      '20260101000000_first',
    ]);
  });
});

describe('FND-11 o down da migração da loja desfaz o up', () => {
  const storeTables = [
    'products',
    'inventory',
    'orders',
    'order_items',
    'idempotency_keys',
    'outbox',
  ];

  it('FND-11 o down da migração da loja remove as seis tabelas, e subir de novo recria', async () => {
    const { uri, pool } = await container.createDatabase();
    const storeFolder = MIGRATION_FOLDERS.find(
      (candidate) => candidate.schema === 'public',
    );
    if (!storeFolder)
      throw new Error('a pasta da loja não está em MIGRATION_FOLDERS');
    await migrate(pool, [storeFolder]);
    for (const table of storeTables)
      expect(await tableExists(pool, `public.${table}`), table).toBe(true);

    const down = await runPlainMigrator(uri, storeFolder, {
      rollbackAll: true,
    });

    expect(down.error).toBeUndefined();
    for (const table of storeTables)
      expect(await tableExists(pool, `public.${table}`), table).toBe(false);
    expect(await appliedMigrations(pool, 'public')).toEqual([]);

    await migrate(pool, [storeFolder]);

    for (const table of storeTables)
      expect(await tableExists(pool, `public.${table}`), table).toBe(true);
    expect((await appliedMigrations(pool, 'public')).length).toBeGreaterThan(0);
  });
});

// Chave do advisory lock que a migração lenta da fixture `concurrency` espera (a mesma da fixture).
const BARRIER_KEY = 7_311_001;

const noop = (): void => undefined;

// Segura a chave numa conexão própria até o release: é a barreira que a migração lenta espera.
async function holdBarrier(uri: string): Promise<{ release(): Promise<void> }> {
  const client = new pg.Client({ connectionString: uri });
  client.on('error', noop);
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1::bigint)', [BARRIER_KEY]);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [
        BARRIER_KEY,
      ]);
      await client.end();
    },
  };
}

// Quantas conexões esperam por um advisory lock neste banco há pelo menos `minWaitSeconds`, pelo
// relógio do banco. Com o lock do migrador, uma chamada espera a chave da barreira e a outra espera
// o lock do migrador; sem ele, as duas esperam a chave da barreira.
async function advisoryWaiters(
  pool: pg.Pool,
  minWaitSeconds: number,
): Promise<number> {
  const result = await pool.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting
       FROM pg_locks lock
       JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory' AND NOT lock.granted
        AND lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND clock_timestamp() - activity.query_start >= make_interval(secs => $1::double precision)`,
    [minWaitSeconds],
  );
  return result.rows[0]?.waiting ?? 0;
}

// Roda as duas chamadas atrás da barreira e só a solta quando as duas estão esperando (e esperaram
// por `minWaitSeconds`): a sobreposição vem dessa condição, e não de uma pausa. Se uma chamada
// termina antes, a espera acaba e o resultado dela (o erro) aparece na asserção do teste.
async function runOverlapped<T>(
  database: ScratchDatabase,
  minWaitSeconds: number,
  startCalls: () => [Promise<T>, Promise<T>],
): Promise<PromiseSettledResult<T>[]> {
  const barrier = await holdBarrier(database.uri);
  try {
    let finishedEarly = false;
    const calls = startCalls().map((call) =>
      call.finally(() => {
        finishedEarly = true;
      }),
    );
    // Anexado já, para uma chamada que falha enquanto se espera não vire rejeição sem tratamento.
    const outcomes = Promise.allSettled(calls);
    await vi.waitFor(
      async () => {
        if (finishedEarly) return;
        expect(await advisoryWaiters(database.pool, minWaitSeconds)).toBe(2);
      },
      { timeout: 30_000, interval: 100 },
    );
    await barrier.release();
    return await outcomes;
  } finally {
    await barrier.release();
  }
}

function describeOutcome(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status === 'fulfilled') return 'fulfilled';
  const { code, message } = outcome.reason as {
    code?: string;
    message?: string;
  };
  return `rejected ${code ?? ''} ${message ?? ''}`.trim();
}

describe('FND-11 duas chamadas simultâneas esperam pelo advisory lock', () => {
  const rounds = 3;
  const folder = fixtureFolder('concurrency');
  const expectedNames = ['20260101000000_slow', '20260101000001_after'];
  const logger = pino({ level: 'silent' });
  // A barreira só é solta depois de as duas chamadas esperarem mais que os 2 s do lock_timeout das
  // requisições (e menos que os 5 s do statement_timeout, para o corte ser o do lock).
  const WAIT_PAST_REQUEST_LIMITS_SECONDS = 3;

  it.each([
    [
      'sobre um pool sem statement_timeout nem lock_timeout',
      0,
      (uri: string): pg.Pool => {
        return createTestPool(uri, { max: 10 });
      },
    ],
    [
      'sobre o pool do serviço de migração, com a espera acima dos 2 s do lock_timeout das requisições',
      WAIT_PAST_REQUEST_LIMITS_SECONDS,
      (uri: string): pg.Pool => createMigrationPool(uri, logger),
    ],
  ] as const)(
    'FND-11 duas chamadas de migrate ao mesmo tempo terminam sem erro, com cada migração aplicada uma vez, %s',
    async (_label, minWaitSeconds, makePool) => {
      for (let round = 0; round < rounds; round += 1) {
        const database = await container.createDatabase();
        const migrationPool = makePool(database.uri);
        try {
          const settled = await runOverlapped(database, minWaitSeconds, () => [
            migrate(migrationPool, [folder]),
            migrate(migrationPool, [folder]),
          ]);

          // A chave primária da tabela de controle impediria uma linha repetida; o que prova a espera
          // é nenhuma das duas chamadas ter falhado no CREATE TABLE repetido, no statement_timeout (57014)
          // nem no lock_timeout (55P03).
          expect(settled.map(describeOutcome)).toEqual([
            'fulfilled',
            'fulfilled',
          ]);
          expect(await appliedMigrations(database.pool, 'public')).toEqual(
            expectedNames,
          );
          expect(await tableExists(database.pool, 'public.fnd11_conc_a')).toBe(
            true,
          );
          expect(await tableExists(database.pool, 'public.fnd11_conc_b')).toBe(
            true,
          );
        } finally {
          await migrationPool.end();
        }
      }
    },
    120_000,
  );

  it('FND-11 controle negativo: sobre o pool das requisições, a mesma espera é cortada pelo lock_timeout ou pelo statement_timeout', async () => {
    for (let round = 0; round < rounds; round += 1) {
      const database = await container.createDatabase();
      const requestPool = createPool(database.uri, logger);
      try {
        const settled = await runOverlapped(
          database,
          WAIT_PAST_REQUEST_LIMITS_SECONDS,
          () => [
            migrate(requestPool, [folder]),
            migrate(requestPool, [folder]),
          ],
        );

        // Os 2 s do lock_timeout vencem os 5 s do statement_timeout; aceitam-se os dois códigos para o
        // teste não depender de qual limite o servidor aplica primeiro.
        const failures = settled.filter(
          (outcome) => outcome.status === 'rejected',
        );
        expect(failures.length).toBeGreaterThanOrEqual(1);
        for (const failure of failures) {
          expect((failure.reason as { code?: string }).code).toMatch(
            /^(55P03|57014)$/,
          );
        }
      } finally {
        await requestPool.end();
      }
    }
  }, 120_000);

  it('FND-11 os limites do pool: o do serviço de migração não tem statement_timeout nem lock_timeout, e o das requisições tem 5 s e 2 s', async () => {
    const database = await container.createDatabase();
    const migrationPool = createMigrationPool(database.uri, logger);
    const requestPool = createPool(database.uri, logger);
    try {
      const show = async (
        pool: pg.Pool,
      ): Promise<{ statement: string; lock: string }> => {
        const statement = await pool.query<{ statement_timeout: string }>(
          'SHOW statement_timeout',
        );
        const lock = await pool.query<{ lock_timeout: string }>(
          'SHOW lock_timeout',
        );
        return {
          statement: statement.rows[0]?.statement_timeout ?? '',
          lock: lock.rows[0]?.lock_timeout ?? '',
        };
      };

      expect(await show(migrationPool)).toEqual({ statement: '0', lock: '0' });
      expect(await show(requestPool)).toEqual({ statement: '5s', lock: '2s' });
    } finally {
      await migrationPool.end();
      await requestPool.end();
    }
  }, 60_000);

  it('FND-11 controle negativo: com um adaptador sem lock, exatamente uma das duas chamadas rejeita', async () => {
    for (let round = 0; round < rounds; round += 1) {
      const database = await container.createDatabase();

      const settled = await runOverlapped(database, 0, () => [
        runPlainMigrator(database.uri, folder, { withoutLock: true }),
        runPlainMigrator(database.uri, folder, { withoutLock: true }),
      ]);

      // O Migrator não lança: a falha vem em `error`. Não se fixa o código do erro (varia com a
      // corrida: relação já existe ou violação de unicidade no catálogo).
      const failures = settled.filter(
        (outcome) =>
          outcome.status === 'rejected' || outcome.value.error !== undefined,
      );
      expect(failures).toHaveLength(1);
      // Quem venceu a corrida aplicou as duas migrações, uma vez.
      expect(await appliedMigrations(database.pool, 'public')).toEqual(
        expectedNames,
      );
    }
  }, 120_000);
});

// A conexão do migrate fica retirada do pool durante a migração toda. Sem o createPoolAdapter, ela não tem
// ouvinte de `error`, e um socket que cai no meio de uma migração lenta derrubaria o processo do deploy.
describe('FND-10 o migrate monta o Kysely sobre o adaptador do pool', () => {
  const SLEEP_MARKER = '%pg_sleep(37)%';

  // Destrói o socket da conexão que roda o pg_sleep da fixture e devolve o que `run` fez e as
  // uncaughtException do processo (captureUncaught tira os ouvintes do vitest durante o cenário).
  async function destroySocketDuringSlowMigration(
    database: ScratchDatabase,
    run: (pool: pg.Pool) => Promise<unknown>,
  ): Promise<{ outcome: unknown; uncaught: Error[] }> {
    const { errors: uncaught, restore } = captureUncaught();
    const clients: pg.PoolClient[] = [];
    const pool = createTestPool(database.uri, { max: 4 });
    pool.on('connect', (client) => clients.push(client));
    try {
      const pending = run(pool).then(
        () => 'resolveu',
        (error: unknown) => error,
      );
      // Espera a migração estar dormindo no servidor, e acha a conexão dela pelo pid do backend.
      let sleepingPid = -1;
      await vi.waitFor(
        async () => {
          const active = await database.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
              WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE $1`,
            [SLEEP_MARKER],
          );
          expect(active.rows).toHaveLength(1);
          sleepingPid = active.rows[0]?.pid ?? -1;
        },
        { timeout: WAIT_GUARD_MS },
      );
      const victim = clients.find(
        (client) =>
          (client as unknown as { processID: number }).processID ===
          sleepingPid,
      );
      expect(victim).toBeDefined();
      (
        victim as unknown as { connection: { stream: Socket } }
      ).connection.stream.destroy(new Error('socket destruído pelo teste'));

      const outcome = await pending;
      // O 'error' do cliente é emitido no mesmo evento do socket; um turno do laço basta para um crash aparecer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { outcome, uncaught };
    } finally {
      restore();
      // O servidor continua no pg_sleep depois de o cliente cair; encerra o backend para não segurar o lock.
      await database.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE $1`,
        [SLEEP_MARKER],
      );
      await pool.end();
    }
  }

  it('FND-10 destruir o socket da conexão do migrate no meio de uma migração lenta não derruba o processo, e o migrate rejeita', async () => {
    const database = await container.createDatabase();

    const result = await destroySocketDuringSlowMigration(database, (pool) =>
      migrate(pool, [fixtureFolder('destroyed-socket')]),
    );

    expect(result.outcome).toBeInstanceOf(Error);
    expect(result.uncaught).toEqual([]);
    // A migração não terminou: nada dela ficou gravado.
    expect(
      await tableExists(database.pool, 'public.fnd10_destroyed_socket'),
    ).toBe(false);
  }, 60_000);

  it('FND-10 controle negativo: o Migrator do Kysely sobre o pool cru, no mesmo cenário, gera uma uncaughtException', async () => {
    const database = await container.createDatabase();
    const folder = fixtureFolder('destroyed-socket');

    const result = await destroySocketDuringSlowMigration(database, (pool) => {
      // O que o migrate fazia sem o createPoolAdapter: o dialeto sobre o pool cru.
      const db = new Kysely<object>({ dialect: new PostgresDialect({ pool }) });
      const migrator = new Migrator({
        db,
        provider: new FileMigrationProvider({
          fs,
          path,
          migrationFolder: folder.dir,
        }),
        migrationTableSchema: folder.schema,
      });
      return migrator.migrateToLatest();
    });

    expect(result.uncaught.length).toBeGreaterThan(0);
    expect(result.uncaught[0]?.message).toContain(
      'socket destruído pelo teste',
    );
  }, 60_000);
});
