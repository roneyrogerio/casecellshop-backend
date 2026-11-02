import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  storeMigrator,
  useMigrationContainer,
} from '../../helpers/migration-database.ts';

// A migração que cria a marca de envio da outbox (AD-031; design.md, "Worker: envio"): `create_calls` conta as
// criações mandadas ao ERP, e as linhas anteriores à coluna recebem o menor valor que nunca conta a menos. O teste
// aplica as migrações até a anterior, semeia cada situação e aplica a que falta.

const container = useMigrationContainer();

// A última migração da loja antes da que cria `create_calls` (a ordem é a do nome do arquivo).
const BEFORE_LATE_CHECK = '20260105000000_create_sync_state';

// `firstAgo` e `lastAgo` são quantos segundos atrás, pelo relógio do banco, cada coluna foi gravada; null deixa nula.
async function seedRow(
  pool: pg.Pool,
  firstAgo: number | null,
  lastAgo: number | null,
): Promise<string> {
  const orderId = randomUUID();
  await pool.query('insert into orders (id) values ($1)', [orderId]);
  await pool.query(
    `insert into outbox (order_id, correlation_id, first_sent_at, last_call_at)
     values ($1, 'corr-1',
             now() - make_interval(secs => $2::float8),
             now() - make_interval(secs => $3::float8))`,
    [orderId, firstAgo, lastAgo],
  );
  return orderId;
}

async function createCallsOf(pool: pg.Pool, orderId: string): Promise<number> {
  const result = await pool.query<{ create_calls: number }>(
    'select create_calls from outbox where order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return row.create_calls;
}

describe('ORD-23 a migração da marca de envio não conta a menos nas linhas anteriores à coluna', () => {
  it('ORD-23 grava create_calls 2 quando first_sent_at é menor que last_call_at, 1 quando só houve a primeira chamada e 0 sem first_sent_at', async () => {
    const { pool } = await container().createDatabase();
    const migrator = storeMigrator(pool);
    const before = await migrator.migrateTo(BEFORE_LATE_CHECK);
    expect(before.error).toBeUndefined();
    const rows = {
      // Mais de uma chamada ao ERP: o `last_call_at` andou depois do primeiro envio.
      severalCalls: await seedRow(pool, 1200, 600),
      // Uma chamada só: as duas colunas valem o mesmo instante.
      oneCall: await seedRow(pool, 1200, 1200),
      // Só o primeiro envio gravado.
      onlyFirstSent: await seedRow(pool, 1200, null),
      // Nunca enviado.
      neverSent: await seedRow(pool, null, null),
    };

    const latest = await migrator.migrateToLatest();

    expect(latest.error).toBeUndefined();
    expect(latest.results?.every((result) => result.status === 'Success')).toBe(
      true,
    );
    expect(await createCallsOf(pool, rows.severalCalls)).toBe(2);
    expect(await createCallsOf(pool, rows.oneCall)).toBe(1);
    expect(await createCallsOf(pool, rows.onlyFirstSent)).toBe(1);
    expect(await createCallsOf(pool, rows.neverSent)).toBe(0);
  });
});
