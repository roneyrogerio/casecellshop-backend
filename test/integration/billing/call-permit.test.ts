import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../src/db/database.ts';
import { type CallPermit, renewCallPermit, takeCallPermit } from '../../../src/billing/call-permit.ts';
import { createAppPool } from '../../helpers/checkout.ts';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';
import { MIN_RETRY_DELAY_MS } from '../../helpers/erp.ts';

// Permissão de chamada por pedido (AD-024; design.md, "Worker: envio"): uma chamada ao ERP por pedido a
// cada atraso mínimo, decidida num UPDATE só pelo relógio do banco. É o que cumpre a H4 e impede duas
// chamadas simultâneas do mesmo pedido quando o relay entrega a mensagem duas vezes (ORD-11, ORD-22).

let database: TestDatabase;
let pool: pg.Pool;
const options = { minDelayMs: MIN_RETRY_DELAY_MS, clearDead: true };

beforeAll(async () => {
  database = await startMigratedDatabase();
  // Pool do worker de produção: 10 conexões, para as tomadas simultâneas serem de fato simultâneas.
  pool = createAppPool(database.uri, 10);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

const db = () => createDb(pool);

// Pedido e linha da outbox já publicada, do jeito que o checkout e o relay os deixam.
async function seedOutbox(): Promise<string> {
  const orderId = randomUUID();
  await database.pool.query('insert into orders (id) values ($1)', [orderId]);
  await database.pool.query("insert into outbox (order_id, correlation_id, published_at) values ($1, 'corr-1', now())", [orderId]);
  return orderId;
}

interface PermitRow {
  callToken: string | null;
  firstSentAt: Date | null;
  lastCallAt: Date | null;
  deadAt: Date | null;
  sinceCallMs: number | null;
}

async function readPermit(orderId: string): Promise<PermitRow> {
  const result = await database.pool.query<{
    call_token: string | null;
    first_sent_at: Date | null;
    last_call_at: Date | null;
    dead_at: Date | null;
    since_call_ms: number | null;
  }>(
    `select call_token, first_sent_at, last_call_at, dead_at,
            (extract(epoch from (now() - last_call_at)) * 1000)::float8 as since_call_ms
       from outbox where order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return { callToken: row.call_token, firstSentAt: row.first_sent_at, lastCallAt: row.last_call_at, deadAt: row.dead_at, sinceCallMs: row.since_call_ms };
}

function granted(permit: CallPermit): Extract<CallPermit, { granted: true }> {
  if (!permit.granted) throw new Error('a permissão devia ter sido concedida');
  return permit;
}

describe('ORD-02 a permissão de chamada respeita o atraso mínimo desde o início da última chamada', () => {
  it('ORD-02 a primeira tomada concede, grava last_call_at, call_token e first_sent_at pelo relógio do banco e informa que nada foi enviado antes', async () => {
    const orderId = await seedOutbox();

    const permit = granted(await takeCallPermit(db(), orderId, options));

    expect(permit.sentBefore).toBe(false);
    expect(permit.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const row = await readPermit(orderId);
    expect(row.callToken).toBe(permit.token);
    expect(row.firstSentAt).not.toBeNull();
    expect(row.sinceCallMs ?? Infinity).toBeLessThan(5_000);
  });

  it('ORD-02 uma segunda tomada antes do atraso mínimo é recusada, diz quanto falta e não muda a linha', async () => {
    const orderId = await seedOutbox();
    const first = granted(await takeCallPermit(db(), orderId, options));
    const before = await readPermit(orderId);

    const second = await takeCallPermit(db(), orderId, options);

    expect(second.granted).toBe(false);
    if (second.granted) throw new Error('a segunda tomada devia ser recusada');
    // Falta quase o atraso mínimo inteiro: a primeira chamada acabou de começar.
    expect(second.retryInMs).toBeGreaterThan(MIN_RETRY_DELAY_MS - 5_000);
    expect(second.retryInMs).toBeLessThanOrEqual(MIN_RETRY_DELAY_MS);
    const after = await readPermit(orderId);
    expect(after.callToken).toBe(first.token);
    expect(after.lastCallAt).toEqual(before.lastCallAt);
    expect(after.firstSentAt).toEqual(before.firstSentAt);
  });

  it('ORD-02 a falta informada acompanha o relógio do banco: com a última chamada há 30 s, faltam uns 15 s', async () => {
    const orderId = await seedOutbox();
    await takeCallPermit(db(), orderId, options);
    await database.pool.query("update outbox set last_call_at = now() - interval '30 seconds' where order_id = $1", [orderId]);

    const refused = await takeCallPermit(db(), orderId, options);

    expect(refused.granted).toBe(false);
    if (refused.granted) throw new Error('devia ser recusada');
    expect(refused.retryInMs).toBeGreaterThan(MIN_RETRY_DELAY_MS - 30_000 - 3_000);
    expect(refused.retryInMs).toBeLessThanOrEqual(MIN_RETRY_DELAY_MS - 30_000);
  });

  it('ORD-02 passado o atraso mínimo, a tomada é concedida de novo com token novo, sentBefore verdadeiro e first_sent_at preservado', async () => {
    const orderId = await seedOutbox();
    const first = granted(await takeCallPermit(db(), orderId, options));
    const original = await readPermit(orderId);
    await database.pool.query("update outbox set last_call_at = now() - interval '46 seconds' where order_id = $1", [orderId]);

    const again = granted(await takeCallPermit(db(), orderId, options));

    expect(again.sentBefore).toBe(true);
    expect(again.token).not.toBe(first.token);
    const row = await readPermit(orderId);
    expect(row.callToken).toBe(again.token);
    expect(row.firstSentAt).toEqual(original.firstSentAt);
    expect(row.sinceCallMs ?? Infinity).toBeLessThan(5_000);
  });

  it('ORD-02 a permissão de um pedido não depende da de outro', async () => {
    const [one, other] = [await seedOutbox(), await seedOutbox()];
    granted(await takeCallPermit(db(), one, options));

    const permit = await takeCallPermit(db(), other, options);

    expect(permit.granted).toBe(true);
  });
});

describe('ORD-11 a permissão de chamada exclui duas chamadas simultâneas do mesmo pedido', () => {
  it('ORD-11 o worker zera o dead_at ao tomar a permissão, e a reconciliação (clearDead falso) não', async () => {
    const forWorker = await seedOutbox();
    const forReconciliation = await seedOutbox();
    await database.pool.query("update outbox set dead_at = now() where order_id = any($1::uuid[])", [[forWorker, forReconciliation]]);

    granted(await takeCallPermit(db(), forWorker, { minDelayMs: MIN_RETRY_DELAY_MS, clearDead: true }));
    granted(await takeCallPermit(db(), forReconciliation, { minDelayMs: MIN_RETRY_DELAY_MS, clearDead: false }));

    expect((await readPermit(forWorker)).deadAt).toBeNull();
    expect((await readPermit(forReconciliation)).deadAt).not.toBeNull();
  });

  const ROUNDS = 5;
  const CONTENDERS = 20;

  it(`ORD-11 ${CONTENDERS} tomadas simultâneas do mesmo pedido concedem exatamente uma, em ${ROUNDS} rodadas, e o token gravado é o dela`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const orderId = await seedOutbox();

      const permits = await Promise.all(Array.from({ length: CONTENDERS }, () => takeCallPermit(db(), orderId, options)));

      const winners = permits.filter((permit): permit is Extract<CallPermit, { granted: true }> => permit.granted);
      expect(winners, `rodada ${round}`).toHaveLength(1);
      expect((await readPermit(orderId)).callToken, `rodada ${round}`).toBe(winners[0]?.token);
    }
  });

  // A versão ingênua lê o último início e grava depois, sem a condição no mesmo UPDATE, com a janela
  // forçada entre ler e gravar: o mesmo cenário acusa duas permissões para o mesmo pedido.
  it('ORD-11 controle negativo: duas tomadas ingênuas (ler e depois gravar, sem a condição no UPDATE) concedem a permissão duas vezes', async () => {
    const orderId = await seedOutbox();
    let arrived = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });

    async function naiveTake(): Promise<boolean> {
      const read = await database.pool.query<{ free: boolean }>(
        "select (last_call_at is null or last_call_at + interval '45 seconds' <= now()) as free from outbox where order_id = $1",
        [orderId],
      );
      arrived += 1;
      if (arrived === 2) open();
      await opened;
      if (!read.rows[0]?.free) return false;
      await database.pool.query('update outbox set last_call_at = now(), call_token = gen_random_uuid() where order_id = $1', [orderId]);
      return true;
    }

    const results = await Promise.all([naiveTake(), naiveTake()]);

    expect(results.filter(Boolean)).toHaveLength(2);
  });
});

describe('ORD-04 a criação depois da consulta renova a permissão pelo token', () => {
  it('ORD-04 com o token vigente, renewCallPermit regrava last_call_at para agora e devolve true', async () => {
    const orderId = await seedOutbox();
    const permit = granted(await takeCallPermit(db(), orderId, options));
    await database.pool.query("update outbox set last_call_at = now() - interval '30 seconds' where order_id = $1", [orderId]);

    const renewed = await renewCallPermit(db(), orderId, permit.token);

    expect(renewed).toBe(true);
    const row = await readPermit(orderId);
    expect(row.sinceCallMs ?? Infinity).toBeLessThan(5_000);
    expect(row.callToken).toBe(permit.token);
  });

  it('ORD-04 com um token que já não vale (outra tentativa tomou a permissão), devolve false e não muda a linha', async () => {
    const orderId = await seedOutbox();
    const old = granted(await takeCallPermit(db(), orderId, options));
    await database.pool.query("update outbox set last_call_at = now() - interval '46 seconds' where order_id = $1", [orderId]);
    const current = granted(await takeCallPermit(db(), orderId, options));
    await database.pool.query("update outbox set last_call_at = now() - interval '20 seconds' where order_id = $1", [orderId]);
    const before = await readPermit(orderId);

    const renewed = await renewCallPermit(db(), orderId, old.token);

    expect(renewed).toBe(false);
    const after = await readPermit(orderId);
    expect(after.callToken).toBe(current.token);
    expect(after.lastCallAt).toEqual(before.lastCallAt);
  });
});
