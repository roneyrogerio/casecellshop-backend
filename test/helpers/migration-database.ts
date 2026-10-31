import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresAdapter, PostgresDialect } from 'kysely';
import {
  FileMigrationProvider,
  type FileMigrationProviderProps,
  type MigrationResultSet,
  Migrator,
  type MigratorProps,
  NO_MIGRATIONS,
} from 'kysely/migration';
import pg from 'pg';
import type { MigrationFolder } from '../../src/db/migrate.ts';

// Ajudantes dos testes do FND-11: um banco novo por teste, no mesmo contêiner, e um Migrator do
// Kysely montado à mão, para os controles negativos provarem que o gancho do migrate é o que
// faz a diferença.

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/migrations/', import.meta.url));

// Pasta de migrações de teste (caminho absoluto), com o schema da tabela de controle.
export function fixtureFolder(name: string, schema = 'public'): MigrationFolder {
  return { dir: path.join(FIXTURES_DIR, name), schema };
}

export interface ScratchDatabase {
  uri: string;
  pool: pg.Pool;
}

export interface MigrationContainer {
  // Banco vazio e exclusivo do teste: as tabelas de controle e as de fixture não vazam entre testes.
  createDatabase(): Promise<ScratchDatabase>;
  stop(): Promise<void>;
}

export async function startMigrationContainer(): Promise<MigrationContainer> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:18.6').start();
  const adminPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  adminPool.on('error', () => undefined);
  const pools: pg.Pool[] = [];
  let counter = 0;
  return {
    async createDatabase() {
      counter += 1;
      // Nome montado só de um contador, nunca de entrada externa; DDL não aceita parâmetro.
      const name = `fnd11_${counter}`;
      await adminPool.query(`CREATE DATABASE ${name}`);
      const url = new URL(container.getConnectionUri());
      url.pathname = `/${name}`;
      const uri = url.toString();
      // Pool folgado: duas chamadas de migrate ao mesmo tempo seguram uma conexão cada.
      const pool = new pg.Pool({ connectionString: uri, max: 10 });
      pool.on('error', () => undefined);
      pools.push(pool);
      return { uri, pool };
    },
    async stop() {
      await Promise.all(pools.map((pool) => pool.end()));
      await adminPool.end();
      await container.stop();
    },
  };
}

// Adaptador cujo lock não faz nada: o controle negativo do advisory lock.
class NoLockAdapter extends PostgresAdapter {
  override acquireMigrationLock(): Promise<void> {
    return Promise.resolve();
  }
}

class NoLockDialect extends PostgresDialect {
  override createAdapter(): PostgresAdapter {
    return new NoLockAdapter();
  }
}

export interface MigratorControl {
  // Ganchos do provider que o migrate do projeto define; aqui ficam de fora, salvo se passados.
  provider?: Pick<FileMigrationProviderProps, 'import' | 'onFileIgnored'>;
  migrator?: Pick<MigratorProps, 'allowUnorderedMigrations' | 'disableTransactions'>;
  withoutLock?: boolean;
  // Desfaz tudo (down de cada migração aplicada) em vez de subir.
  rollbackAll?: boolean;
}

// Roda o Migrator do Kysely direto numa pasta, sem os ganchos do migrate, e devolve o
// resultado cru (o Migrator não lança: o erro vem em `error`).
export async function runPlainMigrator(
  uri: string,
  folder: MigrationFolder,
  control: MigratorControl = {},
): Promise<MigrationResultSet> {
  const pool = new pg.Pool({ connectionString: uri, max: 4 });
  pool.on('error', () => undefined);
  const dialect = control.withoutLock ? new NoLockDialect({ pool }) : new PostgresDialect({ pool });
  // O destroy do Kysely encerra o pool.
  const db = new Kysely<object>({ dialect });
  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({ fs, path, migrationFolder: folder.dir, ...control.provider }),
      migrationTableSchema: folder.schema,
      ...control.migrator,
    });
    return control.rollbackAll ? await migrator.migrateTo(NO_MIGRATIONS) : await migrator.migrateToLatest();
  } finally {
    await db.destroy();
  }
}

export async function tableExists(pool: pg.Pool, qualifiedName: string): Promise<boolean> {
  const result = await pool.query<{ found: string | null }>('SELECT to_regclass($1)::text AS found', [qualifiedName]);
  return result.rows[0]?.found !== null;
}

// Nomes gravados na tabela de controle do Kysely no schema dado, em ordem.
export async function appliedMigrations(pool: pg.Pool, schema: string): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM ${pg.escapeIdentifier(schema)}.kysely_migration ORDER BY name`,
  );
  return result.rows.map((row) => row.name);
}
