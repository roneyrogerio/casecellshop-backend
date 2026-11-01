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

// O esquema do erp_sim fica fixado aqui, pelo catálogo: as colunas, as restrições e o comportamento
// que o M1 entregou e que o ERP simulado usa. Mudar a migração sem mudar este arquivo reprova.

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
  const folder = MIGRATION_FOLDERS.find(
    (candidate) => candidate.schema === schema,
  );
  if (!folder)
    throw new Error(
      `a pasta do schema ${schema} não está em MIGRATION_FOLDERS`,
    );
  const files = await readdir(folder.dir);
  return files
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -'.ts'.length))
    .sort();
}

// O código e o nome da restrição vêm do erro do driver; a mensagem não é contrato.
async function violation(
  promise: Promise<unknown>,
): Promise<
  { code: string | undefined; constraint: string | undefined } | undefined
> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const { code, constraint } = error as {
      code?: string;
      constraint?: string;
    };
    return { code, constraint };
  }
}

describe('FND-11 a migração erp_sim em TypeScript fixa o esquema do erp_sim', () => {
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
      // Chave de deduplicação da H1b: anulável, para o modo sem a H1b gravar NULL (design.md, "Modo sem a H1b").
      {
        table_name: 'invoices',
        column_name: 'dedup_key',
        data_type: 'text',
        is_nullable: 'YES',
        column_default: null,
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

  it('FND-11 chaves primárias, unicidade da dedup_key e os CHECKs, pelo catálogo', async () => {
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
      {
        table_name: 'invoices',
        contype: 'c',
        definition: 'CHECK ((total_cents >= 0))',
      },
      { table_name: 'invoices', contype: 'p', definition: 'PRIMARY KEY (id)' },
      {
        table_name: 'invoices',
        contype: 'u',
        definition: 'UNIQUE (dedup_key)',
      },
      {
        table_name: 'products',
        contype: 'c',
        definition: 'CHECK ((on_hand >= 0))',
      },
      {
        table_name: 'products',
        contype: 'c',
        definition: 'CHECK ((price_cents >= 0))',
      },
      { table_name: 'products', contype: 'p', definition: 'PRIMARY KEY (sku)' },
    ]);
  });

  it('FND-11 a reference das invoices deixa de ser única e ganha um índice simples; a dedup_key tem o índice único', async () => {
    const result = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'erp_sim' AND tablename = 'invoices'`,
    );

    // O nome do índice não é contrato (pode ser gerado): compara só a definição, sem o nome.
    const definitions = result.rows
      .map((row) =>
        row.indexdef.replace(
          /^CREATE (UNIQUE )?INDEX \S+ ON /,
          'CREATE $1INDEX ON ',
        ),
      )
      .sort();
    expect(definitions).toEqual([
      'CREATE INDEX ON erp_sim.invoices USING btree (reference)',
      'CREATE UNIQUE INDEX ON erp_sim.invoices USING btree (dedup_key)',
      'CREATE UNIQUE INDEX ON erp_sim.invoices USING btree (id)',
    ]);
  });

  it('FND-11 o esquema do erp_sim recusa o que deve: CHECKs, unicidade e id informado à mão, e preenche o created_at', async () => {
    const sku = 'FND11-SKU-1';
    await pool.query(
      'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, 100, 1)',
      [sku, 'Capa'],
    );

    const negativePrice = await violation(
      pool.query(
        'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, -1, 1)',
        ['FND11-SKU-2', 'Capa'],
      ),
    );
    const negativeStock = await violation(
      pool.query(
        'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, 1, -1)',
        ['FND11-SKU-3', 'Capa'],
      ),
    );
    const duplicateSku = await violation(
      pool.query(
        'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, 100, 1)',
        [sku, 'Capa'],
      ),
    );
    expect(negativePrice).toEqual({
      code: '23514',
      constraint: 'products_price_cents_check',
    });
    expect(negativeStock).toEqual({
      code: '23514',
      constraint: 'products_on_hand_check',
    });
    expect(duplicateSku).toEqual({
      code: '23505',
      constraint: 'products_pkey',
    });

    const created = await pool.query<{
      id: string;
      created_at: Date;
      recent: boolean;
    }>(
      `INSERT INTO erp_sim.invoices (reference, items, total_cents) VALUES ('fnd11-ref-1', '[]'::jsonb, 0)
       RETURNING id::text, created_at, created_at BETWEEN now() - interval '1 minute' AND now() AS recent`,
    );
    expect(created.rows[0]?.id).toMatch(/^\d+$/);
    expect(created.rows[0]?.recent).toBe(true);

    // Duas linhas com dedup_key nula e a mesma reference são aceitas: é o modo sem a H1b.
    await pool.query(
      `INSERT INTO erp_sim.invoices (reference, items, total_cents) VALUES ('fnd11-ref-1', '[]'::jsonb, 0)`,
    );
    const sameReference = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM erp_sim.invoices WHERE reference = 'fnd11-ref-1' AND dedup_key IS NULL`,
    );
    expect(sameReference.rows[0]?.total).toBe('2');

    // Duas com o mesmo dedup_key recebem 23505 na restrição dele. O nome vem do catálogo, pela definição.
    const uniqueConstraint = await pool.query<{ conname: string }>(
      `SELECT con.conname FROM pg_constraint con JOIN pg_class cls ON cls.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'erp_sim' AND cls.relname = 'invoices' AND pg_get_constraintdef(con.oid) = 'UNIQUE (dedup_key)'`,
    );
    await pool.query(
      `INSERT INTO erp_sim.invoices (reference, dedup_key, items, total_cents) VALUES ('fnd11-ref-4', 'fnd11-ref-4', '[]'::jsonb, 0)`,
    );
    const duplicateDedupKey = await violation(
      pool.query(
        `INSERT INTO erp_sim.invoices (reference, dedup_key, items, total_cents) VALUES ('fnd11-ref-4', 'fnd11-ref-4', '[]'::jsonb, 0)`,
      ),
    );
    const negativeTotal = await violation(
      pool.query(
        `INSERT INTO erp_sim.invoices (reference, items, total_cents) VALUES ('fnd11-ref-2', '[]'::jsonb, -1)`,
      ),
    );
    // GENERATED ALWAYS: informar o id à mão é recusado (428C9), sem restrição nomeada.
    const explicitId = await violation(
      pool.query(
        `INSERT INTO erp_sim.invoices (id, reference, items, total_cents) VALUES (999, 'fnd11-ref-3', '[]'::jsonb, 0)`,
      ),
    );
    expect(uniqueConstraint.rows).toHaveLength(1);
    expect(duplicateDedupKey).toEqual({
      code: '23505',
      constraint: uniqueConstraint.rows[0]?.conname,
    });
    expect(negativeTotal).toEqual({
      code: '23514',
      constraint: 'invoices_total_cents_check',
    });
    expect(explicitId?.code).toBe('428C9');
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

    const erpFolder = MIGRATION_FOLDERS.find(
      (folder) => folder.schema === 'erp_sim',
    );
    if (!erpFolder)
      throw new Error('a pasta erp_sim não está em MIGRATION_FOLDERS');
    const down = await runPlainMigrator(scratchUri, erpFolder, {
      rollbackAll: true,
    });

    expect(down.error).toBeUndefined();
    expect(await tableExists(scratch, 'erp_sim.products')).toBe(false);
    expect(await tableExists(scratch, 'erp_sim.invoices')).toBe(false);
    expect(await appliedMigrations(scratch, 'erp_sim')).toEqual([]);

    await migrate(scratch);

    expect(await tableExists(scratch, 'erp_sim.products')).toBe(true);
    expect(await tableExists(scratch, 'erp_sim.invoices')).toBe(true);
  });
});
