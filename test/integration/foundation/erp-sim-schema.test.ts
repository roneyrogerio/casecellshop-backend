import { readdir } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, MIGRATION_FOLDERS } from '../../../src/db/migrate.ts';
import {
  appliedMigrations,
  type MigrationContainer,
  runPlainMigrator,
  startMigrationContainer,
  tableExists,
} from '../../helpers/migration-database.ts';

// O esquema esperado é o que a migração 20260101000000_create_erp_sim.sql criava no M1; o .sql
// foi apagado na conversão única (AD-017), então a conferência está escrita aqui, pelo catálogo.

let container: MigrationContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await startMigrationContainer();
  ({ pool } = await container.createDatabase());
  await migrate(pool);
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

// Nomes das migrações de uma pasta, sem a extensão, em ordem; é o que a kysely_migration deve listar.
async function migrationNamesInFolder(schema: string): Promise<string[]> {
  const folder = MIGRATION_FOLDERS.find((candidate) => candidate.schema === schema);
  if (!folder) throw new Error(`a pasta do schema ${schema} não está em MIGRATION_FOLDERS`);
  const files = await readdir(folder.dir);
  return files
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -'.ts'.length))
    .sort();
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('FND-11 a migração erp_sim em TypeScript cria o mesmo esquema da .sql', () => {
  it('FND-11 colunas, tipos, nulidade, identidade do id e padrão do created_at', async () => {
    const result = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity, identity_generation
         FROM information_schema.columns
        WHERE table_schema = 'erp_sim' AND table_name IN ('products', 'invoices')
        ORDER BY table_name, ordinal_position`,
    );

    expect(result.rows).toEqual([
      {
        table_name: 'invoices',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'YES',
        identity_generation: 'ALWAYS',
      },
      {
        table_name: 'invoices',
        column_name: 'reference',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'invoices',
        column_name: 'items',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'invoices',
        column_name: 'total_cents',
        data_type: 'bigint',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'invoices',
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'products',
        column_name: 'sku',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'products',
        column_name: 'name',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'products',
        column_name: 'price_cents',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'products',
        column_name: 'on_hand',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: null,
        is_identity: 'NO',
        identity_generation: null,
      },
    ]);
  });

  it('FND-11 chaves primárias, unicidade da reference e os CHECKs, pelo catálogo', async () => {
    // contype 'n' (NOT NULL como restrição, no PostgreSQL 18) fica de fora: a nulidade já foi conferida acima.
    const result = await pool.query(
      `SELECT cls.relname AS table_name, con.contype, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'erp_sim' AND cls.relname IN ('products', 'invoices') AND con.contype IN ('p', 'u', 'c')
        ORDER BY cls.relname, con.contype, 3`,
    );

    expect(result.rows).toEqual([
      { table_name: 'invoices', contype: 'c', definition: 'CHECK ((total_cents >= 0))' },
      { table_name: 'invoices', contype: 'p', definition: 'PRIMARY KEY (id)' },
      { table_name: 'invoices', contype: 'u', definition: 'UNIQUE (reference)' },
      { table_name: 'products', contype: 'c', definition: 'CHECK ((on_hand >= 0))' },
      { table_name: 'products', contype: 'c', definition: 'CHECK ((price_cents >= 0))' },
      { table_name: 'products', contype: 'p', definition: 'PRIMARY KEY (sku)' },
    ]);
  });

  it('FND-11 o esquema se comporta como o da .sql: CHECKs, unicidade, id sempre gerado e created_at preenchido', async () => {
    const sku = 'FND11-SKU-1';
    await pool.query('INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, 100, 1)', [
      sku,
      'Capa',
    ]);

    const negativePrice = await sqlState(
      pool.query('INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, -1, 1)', [
        'FND11-SKU-2',
        'Capa',
      ]),
    );
    const negativeStock = await sqlState(
      pool.query('INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, 1, -1)', [
        'FND11-SKU-3',
        'Capa',
      ]),
    );
    const duplicateSku = await sqlState(
      pool.query('INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, 100, 1)', [
        sku,
        'Capa',
      ]),
    );
    expect(negativePrice).toBe('23514');
    expect(negativeStock).toBe('23514');
    expect(duplicateSku).toBe('23505');

    const created = await pool.query<{ id: string; created_at: Date; recent: boolean }>(
      `INSERT INTO erp_sim.invoices (reference, items, total_cents) VALUES ('fnd11-ref-1', '[]'::jsonb, 0)
       RETURNING id::text, created_at, created_at BETWEEN now() - interval '1 minute' AND now() AS recent`,
    );
    expect(created.rows[0]?.id).toMatch(/^\d+$/);
    expect(created.rows[0]?.recent).toBe(true);

    const duplicateReference = await sqlState(
      pool.query(`INSERT INTO erp_sim.invoices (reference, items, total_cents) VALUES ('fnd11-ref-1', '[]'::jsonb, 0)`),
    );
    const negativeTotal = await sqlState(
      pool.query(`INSERT INTO erp_sim.invoices (reference, items, total_cents) VALUES ('fnd11-ref-2', '[]'::jsonb, -1)`),
    );
    // GENERATED ALWAYS: informar o id à mão é recusado (428C9).
    const explicitId = await sqlState(
      pool.query(`INSERT INTO erp_sim.invoices (id, reference, items, total_cents) VALUES (999, 'fnd11-ref-3', '[]'::jsonb, 0)`),
    );
    expect(duplicateReference).toBe('23505');
    expect(negativeTotal).toBe('23514');
    expect(explicitId).toBe('428C9');
  });

  it('FND-11 o histórico fica na kysely_migration do erp_sim, e a pgmigrations do node-pg-migrate não existe', async () => {
    // Cada schema guarda só as migrações da sua própria pasta, lidas do disco: o histórico do
    // `public` não traz as do erp_sim, e o do erp_sim não traz as da loja.
    const storeNames = await migrationNamesInFolder('public');
    const erpSimNames = await migrationNamesInFolder('erp_sim');
    expect(erpSimNames).toContain('20260101000000_create_erp_sim');
    expect(await appliedMigrations(pool, 'erp_sim')).toEqual(erpSimNames);
    expect(await appliedMigrations(pool, 'public')).toEqual(storeNames);
    for (const name of erpSimNames) expect(storeNames).not.toContain(name);
    expect(await tableExists(pool, 'erp_sim.pgmigrations')).toBe(false);
    expect(await tableExists(pool, 'public.pgmigrations')).toBe(false);
  });

  it('FND-11 o down da migração desfaz o up, e subir de novo recria o esquema', async () => {
    const { pool: scratch, uri: scratchUri } = await container.createDatabase();
    await migrate(scratch);

    const erpFolder = MIGRATION_FOLDERS.find((folder) => folder.schema === 'erp_sim');
    if (!erpFolder) throw new Error('a pasta erp_sim não está em MIGRATION_FOLDERS');
    const down = await runPlainMigrator(scratchUri, erpFolder, { rollbackAll: true });

    expect(down.error).toBeUndefined();
    expect(await tableExists(scratch, 'erp_sim.products')).toBe(false);
    expect(await tableExists(scratch, 'erp_sim.invoices')).toBe(false);
    expect(await appliedMigrations(scratch, 'erp_sim')).toEqual([]);

    await migrate(scratch);

    expect(await tableExists(scratch, 'erp_sim.products')).toBe(true);
    expect(await tableExists(scratch, 'erp_sim.invoices')).toBe(true);
  });
});
