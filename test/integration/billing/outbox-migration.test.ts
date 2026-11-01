import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_FOLDERS } from '../../../src/db/migrate.ts';
import {
  type MigrationContainer,
  startMigrationContainer,
} from '../../helpers/migration-database.ts';

// A migração que tira da outbox as colunas da fila na tabela (design.md, "Dados"; AD-021): antes de tirá-las,
// ela marca `published_at = now()` nas linhas com `status <> 'pending'`, para o relay não publicar no SQS
// mensagens já encerradas, mortas ou canceladas. O teste aplica as migrações até a anterior, semeia linhas em
// cada status e aplica as que faltam.

let container: MigrationContainer;

beforeAll(async () => {
  container = await startMigrationContainer();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

// A última migração da loja antes da que tira as colunas da fila.
const BEFORE_DROP = '20260103000000_add_outbox_relay_columns';
const DROPPED_COLUMNS = [
  'status',
  'attempts',
  'lease_until',
  'claim_token',
  'next_attempt_at',
  'reconciled_at',
];
const KEPT_COLUMNS = [
  'order_id',
  'published_at',
  'first_sent_at',
  'last_call_at',
  'call_token',
  'dead_at',
  'traceparent',
  'correlation_id',
  'created_at',
];

function storeMigrator(pool: pg.Pool): Migrator {
  const folder = MIGRATION_FOLDERS.find(
    (candidate) => candidate.schema === 'public',
  );
  if (!folder)
    throw new Error('a pasta de migrações da loja não está na lista');
  const db = new Kysely<object>({ dialect: new PostgresDialect({ pool }) });
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: folder.dir,
    }),
    migrationTableSchema: folder.schema,
  });
}

async function seedRow(
  pool: pg.Pool,
  status: string,
  traceparent: string | null,
): Promise<string> {
  const orderId = randomUUID();
  await pool.query('insert into orders (id) values ($1)', [orderId]);
  await pool.query(
    `insert into outbox (order_id, status, correlation_id, traceparent, first_sent_at, last_call_at)
     values ($1, $2, 'corr-1', $3, now() - interval '10 minutes', now() - interval '9 minutes')`,
    [orderId, status, traceparent],
  );
  return orderId;
}

async function columnsOfOutbox(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'outbox' order by column_name",
  );
  return result.rows.map((row) => row.column_name);
}

describe('ORD-22 a migração que tira as colunas da fila na tabela não deixa o relay publicar o que já foi encerrado', () => {
  it('ORD-22 marca published_at nas linhas com status diferente de pending, deixa as pending sem a marca e preserva o estado por pedido', async () => {
    const { pool } = await container.createDatabase();
    const migrator = storeMigrator(pool);
    const before = await migrator.migrateTo(BEFORE_DROP);
    expect(before.error).toBeUndefined();
    const traceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const rows = {
      pending: await seedRow(pool, 'pending', traceparent),
      done: await seedRow(pool, 'done', traceparent),
      dead: await seedRow(pool, 'dead', traceparent),
      cancelled: await seedRow(pool, 'cancelled', null),
    };
    expect(await columnsOfOutbox(pool)).toEqual(
      expect.arrayContaining(DROPPED_COLUMNS),
    );

    const latest = await migrator.migrateToLatest();

    expect(latest.error).toBeUndefined();
    expect(latest.results?.every((result) => result.status === 'Success')).toBe(
      true,
    );
    const published = await pool.query<{
      order_id: string;
      published: boolean;
    }>(
      'select order_id, published_at is not null as published from outbox where order_id = any($1::uuid[])',
      [Object.values(rows)],
    );
    const byOrder = new Map(
      published.rows.map((row) => [row.order_id, row.published]),
    );
    // As encerradas, mortas e canceladas já não são mensagens a publicar; a pendente continua para o relay.
    expect(byOrder.get(rows.pending)).toBe(false);
    expect(byOrder.get(rows.done)).toBe(true);
    expect(byOrder.get(rows.dead)).toBe(true);
    expect(byOrder.get(rows.cancelled)).toBe(true);
    // O estado por pedido que o SQS não guarda segue na linha.
    const kept = await pool.query<{
      first_sent_at: Date | null;
      last_call_at: Date | null;
      traceparent: string | null;
      correlation_id: string;
    }>(
      'select first_sent_at, last_call_at, traceparent, correlation_id from outbox where order_id = $1',
      [rows.dead],
    );
    expect(kept.rows[0]?.first_sent_at).not.toBeNull();
    expect(kept.rows[0]?.last_call_at).not.toBeNull();
    expect(kept.rows[0]?.traceparent).toBe(traceparent);
    expect(kept.rows[0]?.correlation_id).toBe('corr-1');
  });

  it('ORD-22 tira da outbox status, attempts, lease_until, claim_token, next_attempt_at e reconciled_at, e mantém as colunas do relay e da permissão de chamada', async () => {
    const { pool } = await container.createDatabase();

    const latest = await storeMigrator(pool).migrateToLatest();

    expect(latest.error).toBeUndefined();
    const columns = await columnsOfOutbox(pool);
    for (const dropped of DROPPED_COLUMNS)
      expect(columns, `a coluna ${dropped} sai`).not.toContain(dropped);
    expect(columns).toEqual(expect.arrayContaining(KEPT_COLUMNS));
    // O índice parcial do relay (as não publicadas) continua; o da fila na tabela sai junto com as colunas.
    const indexes = await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'outbox'",
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('outbox_unpublished_idx');
    expect(names).not.toContain('outbox_status_next_attempt_idx');
  });
});
