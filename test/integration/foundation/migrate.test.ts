import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MIGRATION_FOLDERS, migrate } from '../../../src/db/migrate.ts';
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

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');

describe('FND-11 migrate aplica as pastas pelo Migrator do Kysely', () => {
  it('FND-11 as duas pastas do repositório são o padrão, a da loja antes e o erp_sim depois', () => {
    expect(MIGRATION_FOLDERS).toEqual([
      { dir: path.join(repoRoot, 'migrations', 'store'), schema: 'public' },
      { dir: path.join(repoRoot, 'migrations', 'erp_sim'), schema: 'erp_sim' },
    ]);
  });

  it('FND-11 aplica as pastas na ordem dada, cada uma com a kysely_migration no próprio schema', async () => {
    const { pool } = await container.createDatabase();

    await migrate(pool, [fixtureFolder('ordem/primeira'), fixtureFolder('ordem/segunda', 'fnd11_segunda')]);

    // A pasta "segunda" escreve numa tabela que só a "primeira" cria: a ordem aparece no registro.
    const log = await pool.query<{ quem: string }>('SELECT quem FROM fnd11_ordem_log ORDER BY id');
    expect(log.rows.map((row) => row.quem)).toEqual(['primeira-1', 'primeira-2', 'segunda-1']);
    expect(await appliedMigrations(pool, 'public')).toEqual([
      '20260101000000_cria_log',
      '20260101000001_segunda_migracao',
    ]);
    expect(await appliedMigrations(pool, 'fnd11_segunda')).toEqual(['20260101000000_usa_log']);
  });

  it('FND-11 controle negativo: as pastas na ordem inversa rejeitam, porque a ordem dada é a que vale', async () => {
    const { pool } = await container.createDatabase();

    await expect(
      migrate(pool, [fixtureFolder('ordem/segunda', 'fnd11_segunda'), fixtureFolder('ordem/primeira')]),
    ).rejects.toThrow(/fnd11_ordem_log/);

    expect(await tableExists(pool, 'public.fnd11_ordem_log')).toBe(false);
  });

  it('FND-11 a tabela de controle fica no schema da pasta, e rodar de novo não reaplica nada', async () => {
    const { pool } = await container.createDatabase();
    const folder = fixtureFolder('basica', 'fnd11_controle');

    await migrate(pool, [folder]);
    await migrate(pool, [folder]);

    expect(await appliedMigrations(pool, 'fnd11_controle')).toEqual([
      '20260101000000_cria_a',
      '20260101000001_cria_b',
    ]);
    expect(await tableExists(pool, 'public.kysely_migration')).toBe(false);
    expect(await tableExists(pool, 'public.fnd11_basica_a')).toBe(true);
    expect(await tableExists(pool, 'public.fnd11_basica_b')).toBe(true);
  });

  it('FND-11 uma migração que chegou com nome anterior ao da última aplicada rejeita (sem allowUnorderedMigrations)', async () => {
    const { uri, pool } = await container.createDatabase();
    await migrate(pool, [fixtureFolder('fora-de-ordem/executada')]);

    await expect(migrate(pool, [fixtureFolder('fora-de-ordem/completa')])).rejects.toThrow(/20260102000000_b/);

    expect(await tableExists(pool, 'public.fnd11_ordem_a')).toBe(false);
    // Controle negativo: com allowUnorderedMigrations o Migrator aplicaria a migração atrasada.
    const control = await runPlainMigrator(uri, fixtureFolder('fora-de-ordem/completa'), {
      migrator: { allowUnorderedMigrations: true },
    });
    expect(control.error).toBeUndefined();
    expect(await tableExists(pool, 'public.fnd11_ordem_a')).toBe(true);
  });
});

describe('FND-11 migrate recusa o que o migrador pularia ou aceitaria em silêncio', () => {
  it('FND-11 um .sql na pasta faz o migrate rejeitar, e nada da pasta é aplicado', async () => {
    const { pool } = await container.createDatabase();

    await expect(migrate(pool, [fixtureFolder('sql-esquecido')])).rejects.toThrow(/20260101000001_antiga\.sql/);

    expect(await tableExists(pool, 'public.fnd11_sql_ok')).toBe(false);
    expect(await tableExists(pool, 'public.fnd11_sql_esquecido')).toBe(false);
  });

  it('FND-11 controle negativo do .sql: sem o onFileIgnored o arquivo é pulado e o migrador resolve', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder('sql-esquecido'));

    expect(result.error).toBeUndefined();
    expect(await tableExists(pool, 'public.fnd11_sql_ok')).toBe(true);
    // O .sql foi pulado sem aviso: é exatamente o que o gancho existe para impedir.
    expect(await tableExists(pool, 'public.fnd11_sql_esquecido')).toBe(false);
  });

  it('FND-11 um .ts que não exporta up (só down) faz o migrate rejeitar pelo onFileIgnored', async () => {
    const { pool } = await container.createDatabase();

    await expect(migrate(pool, [fixtureFolder('sem-up')])).rejects.toThrow(/20260101000001_so_down\.ts/);

    expect(await tableExists(pool, 'public.fnd11_semup_ok')).toBe(false);
  });

  it('FND-11 controle negativo do .ts sem up: sem o onFileIgnored o arquivo é pulado e o migrador resolve', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder('sem-up'));

    expect(result.error).toBeUndefined();
    expect(await tableExists(pool, 'public.fnd11_semup_ok')).toBe(true);
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
    ['um .mjs', 'mjs', '20260101000000_modulo.mjs', 'fnd11_mjs'],
    ['um .ts sem down', 'ts-sem-down', '20260101000000_sem_down.ts', 'fnd11_semdown'],
  ] as const;

  it.each(cases)('FND-11 %s faz o migrate rejeitar pelo import, e a migração não é aplicada', async (_label, scenario, file, table) => {
    const { pool } = await container.createDatabase();

    await expect(migrate(pool, [fixtureFolder(scenario)])).rejects.toThrow(file);

    expect(await tableExists(pool, `public.${table}`)).toBe(false);
  });

  it.each(cases)('FND-11 controle negativo de %s: sem o import próprio a migração é aplicada', async (_label, scenario, _file, table) => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder(scenario));

    expect(result.error).toBeUndefined();
    expect(await tableExists(pool, `public.${table}`)).toBe(true);
  });
});

describe('FND-11 as pendentes de um schema rodam numa transação só', () => {
  it('FND-11 uma segunda migração que lança erro faz o migrate rejeitar sem deixar nada da primeira', async () => {
    const { pool } = await container.createDatabase();

    await expect(migrate(pool, [fixtureFolder('falha-na-segunda')])).rejects.toThrow(/falha de propósito/);

    expect(await tableExists(pool, 'public.fnd11_falha_primeira')).toBe(false);
    // Nem o que a segunda fez antes de lançar.
    expect(await tableExists(pool, 'public.fnd11_falha_segunda')).toBe(false);
    expect(await appliedMigrations(pool, 'public')).toEqual([]);
  });

  it('FND-11 controle negativo: com disableTransactions a primeira migração fica gravada', async () => {
    const { uri, pool } = await container.createDatabase();

    const result = await runPlainMigrator(uri, fixtureFolder('falha-na-segunda'), {
      migrator: { disableTransactions: true },
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(await tableExists(pool, 'public.fnd11_falha_primeira')).toBe(true);
    expect(await appliedMigrations(pool, 'public')).toEqual(['20260101000000_primeira']);
  });
});

describe('FND-11 o down da migração da loja desfaz o up', () => {
  const storeTables = ['products', 'inventory', 'orders', 'order_items', 'idempotency_keys', 'outbox'];

  it('FND-11 o down da migração da loja remove as seis tabelas, e subir de novo recria', async () => {
    const { uri, pool } = await container.createDatabase();
    const storeFolder = MIGRATION_FOLDERS.find((candidate) => candidate.schema === 'public');
    if (!storeFolder) throw new Error('a pasta da loja não está em MIGRATION_FOLDERS');
    await migrate(pool, [storeFolder]);
    for (const table of storeTables) expect(await tableExists(pool, `public.${table}`), table).toBe(true);

    const down = await runPlainMigrator(uri, storeFolder, { rollbackAll: true });

    expect(down.error).toBeUndefined();
    for (const table of storeTables) expect(await tableExists(pool, `public.${table}`), table).toBe(false);
    expect(await appliedMigrations(pool, 'public')).toEqual([]);

    await migrate(pool, [storeFolder]);

    for (const table of storeTables) expect(await tableExists(pool, `public.${table}`), table).toBe(true);
    expect((await appliedMigrations(pool, 'public')).length).toBeGreaterThan(0);
  });
});

// Chave do advisory lock que a migração lenta da fixture `concorrencia` espera (a mesma da fixture).
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
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [BARRIER_KEY]);
      await client.end();
    },
  };
}

// Quantas conexões esperam por um advisory lock neste banco há pelo menos `minWaitSeconds`, pelo
// relógio do banco. Com o lock do migrador, uma chamada espera a chave da barreira e a outra espera
// o lock do migrador; sem ele, as duas esperam a chave da barreira.
async function advisoryWaiters(pool: pg.Pool, minWaitSeconds: number): Promise<number> {
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
  const { code, message } = outcome.reason as { code?: string; message?: string };
  return `rejected ${code ?? ''} ${message ?? ''}`.trim();
}

describe('FND-11 duas chamadas simultâneas esperam pelo advisory lock', () => {
  const rounds = 3;
  const folder = fixtureFolder('concorrencia');
  const expectedNames = ['20260101000000_lenta', '20260101000001_depois'];
  const STATEMENT_TIMEOUT_MS = 1_000;
  const LOCK_TIMEOUT_MS = 500;

  // O pool curto imita o de produção (statement_timeout e lock_timeout menores que a migração mais
  // lenta e que a espera pelo lock); a barreira só é solta depois de as duas chamadas esperarem
  // mais que o dobro do statement_timeout.
  it.each([
    ['sem statement_timeout nem lock_timeout', {}, 0],
    [
      'sobre um pool com statement_timeout de 1 s e lock_timeout de 500 ms, menores que a migração mais lenta',
      { statement_timeout: STATEMENT_TIMEOUT_MS, lock_timeout: LOCK_TIMEOUT_MS },
      2,
    ],
  ] as const)(
    'FND-11 duas chamadas de migrate ao mesmo tempo terminam sem erro, com cada migração aplicada uma vez, %s',
    async (_label, limits, minWaitSeconds) => {
      for (let round = 0; round < rounds; round += 1) {
        const database = await container.createDatabase();
        const migrationPool = new pg.Pool({
          connectionString: database.uri,
          max: 10,
          ...limits,
        });
        migrationPool.on('error', noop);
        try {
          const settled = await runOverlapped(database, minWaitSeconds, () => [
            migrate(migrationPool, [folder]),
            migrate(migrationPool, [folder]),
          ]);

          // A chave primária da tabela de controle impediria uma linha repetida; o que prova a espera
          // é nenhuma das duas chamadas ter falhado no CREATE TABLE repetido, no statement_timeout (57014)
          // nem no lock_timeout (55P03).
          expect(settled.map(describeOutcome)).toEqual(['fulfilled', 'fulfilled']);
          expect(await appliedMigrations(database.pool, 'public')).toEqual(expectedNames);
          expect(await tableExists(database.pool, 'public.fnd11_conc_a')).toBe(true);
          expect(await tableExists(database.pool, 'public.fnd11_conc_b')).toBe(true);
        } finally {
          await migrationPool.end();
        }
      }
    },
    120_000,
  );

  it('FND-11 controle negativo: com um adaptador sem lock, exatamente uma das duas chamadas rejeita', async () => {
    for (let round = 0; round < rounds; round += 1) {
      const database = await container.createDatabase();

      const settled = await runOverlapped(database, 0, () => [
        runPlainMigrator(database.uri, folder, { withoutLock: true }),
        runPlainMigrator(database.uri, folder, { withoutLock: true }),
      ]);

      // O Migrator não lança: a falha vem em `error`. Não se fixa o código do erro (varia com a
      // corrida: relação já existe ou violação de unicidade no catálogo).
      const failures = settled.filter((outcome) => outcome.status === 'rejected' || outcome.value.error !== undefined);
      expect(failures).toHaveLength(1);
      // Quem venceu a corrida aplicou as duas migrações, uma vez.
      expect(await appliedMigrations(database.pool, 'public')).toEqual(expectedNames);
    }
  }, 120_000);

  it('FND-11 controle negativo do pool curto: o Migrator cru sobre um pool com statement_timeout de 1 s é cortado com 57014', async () => {
    const database = await container.createDatabase();
    const shortUri = new URL(database.uri);
    shortUri.searchParams.set('statement_timeout', String(STATEMENT_TIMEOUT_MS));

    // Sem o migrate do projeto, a espera pela barreira passa de 1 s e o servidor cancela o comando.
    const settled = await runOverlapped(database, 2, () => [
      runPlainMigrator(shortUri.toString(), folder),
      runPlainMigrator(shortUri.toString(), folder),
    ]);

    const codes = settled.map((outcome) => {
      const error: unknown = outcome.status === 'fulfilled' ? outcome.value.error : outcome.reason;
      return (error as { code?: string } | undefined)?.code;
    });
    expect(codes).toContain('57014');
  }, 120_000);

  it('FND-11 controle negativo do lock_timeout: o Migrator cru sobre um pool com lock_timeout de 500 ms é cortado com 55P03 ao esperar o lock', async () => {
    const database = await container.createDatabase();
    const shortUri = new URL(database.uri);
    shortUri.searchParams.set('lock_timeout', String(LOCK_TIMEOUT_MS));

    // Sem statement_timeout: só o lock_timeout pode cortar a espera pela barreira e pelo lock do migrador.
    const settled = await runOverlapped(database, 2, () => [
      runPlainMigrator(shortUri.toString(), folder),
      runPlainMigrator(shortUri.toString(), folder),
    ]);

    const codes = settled.map((outcome) => {
      const error: unknown = outcome.status === 'fulfilled' ? outcome.value.error : outcome.reason;
      return (error as { code?: string } | undefined)?.code;
    });
    expect(codes).toContain('55P03');
  }, 120_000);
});
