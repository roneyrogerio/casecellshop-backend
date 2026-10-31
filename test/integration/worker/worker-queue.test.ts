import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAppPool, readInventory } from '../../helpers/checkout.ts';
import { countInvoices, MIN_RETRY_DELAY_MS } from '../../helpers/erp.ts';
import {
  acceptOrder,
  buildWorker,
  cancelLeftoverMessages,
  countActiveLeases,
  createErpWorld,
  createGate,
  expectInvoiced,
  ledgerViolations,
  makeClaimable,
  readOrder,
  readOutbox,
  retryDelayMs,
  startPoll,
  startWorkerSuite,
  untilState,
  type AcceptedOrder,
  type ErpWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';
import type { Worker, WorkerConfig } from '../../../src/worker.ts';

// Fila, DLQ, falha do banco e concorrência do envio (ORD-12, ORD-13, ORD-16, ORD-17, ORD-20).

let suite: WorkerSuite;

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 120_000);

afterAll(async () => {
  await suite?.stop();
});

afterEach(async () => {
  await cancelLeftoverMessages(suite.pool);
});

function newWorker(world: ErpWorld, config?: Partial<WorkerConfig>): Worker {
  return buildWorker(world, { pool: suite.pool, telemetry: suite.telemetry, ...(config ? { config } : {}) });
}

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
}

// Chamadas de criação desta referência que chegaram ao transporte.
function createsFor(world: ErpWorld, reference: string): number {
  return world.transport.sends.filter((request) => request.op === 'createOrder' && request.body.reference === reference).length;
}

// A reserva do pedido segue de pé e nada foi vendido: o pedido ainda pode ser faturado.
async function expectReservationKept(order: AcceptedOrder): Promise<void> {
  const inventory = await readInventory(suite.pool, order.sku);
  expect(ledgerViolations(inventory, { onHand: order.onHand, reserved: order.quantity, soldTotal: 0 })).toEqual([]);
}

describe('ORD-12 mensagem que derruba o processo', () => {
  it('ORD-12 chega à DLQ sozinha depois do limite de tentativas, sem chamar o ERP na última reivindicação, e as outras do lote são faturadas', async () => {
    const maxAttempts = 3;
    const poison = await acceptOrder(suite, { quantity: 2 });
    const healthy = [await acceptOrder(suite), await acceptOrder(suite)];
    const world = createErpWorld(suite.database.erpPool);
    // A chamada desta mensagem derruba o processo: o worker nunca volta dela, a cada reivindicação.
    world.transport.stall({ op: 'createOrder', reference: poison.orderId }, { callErp: false, times: Infinity });

    // Primeira reivindicação: as três mensagens no mesmo lote; as saudáveis são faturadas ao lado da que trava.
    const batch = startPoll(newWorker(world, { maxAttempts }));
    await untilState(batch, async () => {
      for (const order of healthy) expect((await readOrder(suite.pool, order.orderId)).status).toBe('invoiced');
    });
    // A chamada da primeira reivindicação já saiu (o last_call_at dela já foi gravado) antes de o teste mexer nos prazos.
    await batch.until(world.transport.waitForSends(3, 'createOrder'));
    expect((await readOutbox(suite.pool, poison.orderId)).attempts).toBe(1);

    // O lease vence e o atraso mínimo passa; um processo novo reivindica de novo e trava de novo.
    for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
      await makeClaimable(suite.pool, poison.orderId);
      const next = startPoll(newWorker(world, { maxAttempts }));
      await next.until(world.transport.waitForSends(2 + attempt, 'createOrder'));
      expect((await readOutbox(suite.pool, poison.orderId)).attempts).toBe(attempt);
    }
    expect(createsFor(world, poison.orderId)).toBe(maxAttempts);

    // Limite gasto: a reivindicação seguinte manda a mensagem para a DLQ sem chamar o ERP.
    await makeClaimable(suite.pool, poison.orderId);
    await newWorker(world, { maxAttempts }).pollOnce();

    expect((await readOutbox(suite.pool, poison.orderId)).status).toBe('dead');
    expect(createsFor(world, poison.orderId)).toBe(maxAttempts);
    expect((await readOrder(suite.pool, poison.orderId)).status).toBe('pending');
    await expectReservationKept(poison);
    expect(await invoices(poison.orderId)).toBe(0);
    for (const order of healthy) {
      expect(await invoices(order.orderId)).toBe(1);
      await expectInvoiced(suite.pool, order);
    }
  });
});

describe('ORD-13 limite de tentativas com falha transitória', () => {
  const BASE_MS = 5_000;
  const CAP_MS = 20_000;
  const MAX_ATTEMPTS = 5;
  // O atraso gravado é medido do início da chamada ao next_attempt_at; a folga cobre os milissegundos entre os dois.
  const TOLERANCE_MS = 2_000;

  it.each([0, 0.5, 0.999])(
    'ORD-13 com o sorteio fixo em %d, cada retry espera o atraso mínimo mais o jitter sobre o exponencial com teto, e a mensagem acaba dead com a reserva mantida',
    async (random) => {
      const order = await acceptOrder(suite, { quantity: 2 });
      const world = createErpWorld(suite.database.erpPool);
      world.sim.script.setDefault({ mode: 'unavailable' });
      const worker = buildWorker(world, {
        pool: suite.pool,
        telemetry: suite.telemetry,
        random: () => random,
        config: { maxAttempts: MAX_ATTEMPTS, backoffBaseMs: BASE_MS, backoffCapMs: CAP_MS },
      });

      let retriesChecked = 0;
      for (let round = 0; round <= MAX_ATTEMPTS; round += 1) {
        await makeClaimable(suite.pool, order.orderId);
        await worker.pollOnce();
        const outbox = await readOutbox(suite.pool, order.orderId);
        if (outbox.status === 'dead') break;
        expect(outbox.status).toBe('pending');
        // Full jitter: o sorteio escala um teto que dobra a cada tentativa até o limite de 20 s.
        const n = outbox.attempts;
        const lowest = random * Math.min(CAP_MS, BASE_MS * 2 ** (n - 1));
        const highest = random * Math.min(CAP_MS, BASE_MS * 2 ** n);
        const delay = await retryDelayMs(suite.pool, order.orderId);
        expect(delay, `retry depois da tentativa ${n}`).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS + lowest - TOLERANCE_MS);
        expect(delay, `retry depois da tentativa ${n}`).toBeLessThanOrEqual(MIN_RETRY_DELAY_MS + highest + TOLERANCE_MS);
        retriesChecked += 1;
      }

      expect(retriesChecked).toBeGreaterThanOrEqual(MAX_ATTEMPTS - 1);
      expect((await readOutbox(suite.pool, order.orderId)).status).toBe('dead');
      // Uma chamada por tentativa (a primeira cria; as outras consultam, e a consulta que falha nunca cria),
      // nenhuma além do limite, e a DLQ não mexe no pedido nem na reserva.
      expect(world.transport.sends).toHaveLength(MAX_ATTEMPTS);
      expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
      await expectReservationKept(order);
      expect(await invoices(order.orderId)).toBe(0);
    },
  );
});

describe('ORD-16 falha do banco ao gravar o desfecho', () => {
  // O lock é tomado depois de o ERP faturar e antes de o worker gravar o desfecho: a gravação estoura o
  // lock_timeout (500 ms neste pool), e a mensagem não pode ir para a DLQ por isso.
  it.each(['outbox', 'orders', 'inventory'] as const)(
    'ORD-16 um lock na linha de %s que estoura o lock_timeout da gravação não manda a mensagem para a DLQ: termina invoiced com uma fatura',
    async (table) => {
      const order = await acceptOrder(suite);
      const world = createErpWorld(suite.database.erpPool);
      const workerPool = createAppPool(suite.database.uri, 10, { lockTimeoutMs: 500 });
      const holder = await suite.database.pool.connect();
      const lockSql = {
        outbox: ['select 1 from outbox where order_id = $1 for update', order.orderId],
        orders: ['select 1 from orders where id = $1 for update', order.orderId],
        inventory: ['select 1 from inventory where sku = $1 for update', order.sku],
      } as const;
      try {
        const holderPid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
        world.transport.afterErp({ op: 'createOrder', reference: order.orderId }, async () => {
          await holder.query('begin');
          await holder.query(lockSql[table][0], [lockSql[table][1]]);
        });
        const poll = startPoll(buildWorker(world, { pool: workerPool, telemetry: suite.telemetry }));

        // Espera a gravação estourar o lock_timeout pelo menos uma vez: duas esperas distintas no lock
        // (a segunda é a nova tentativa de gravar), ou a rodada terminar sem ter gravado.
        const waits = new Set<string>();
        await untilState(poll, async () => {
          const waiting = await suite.database.pool.query<{ wait: string }>(
            "select pid::text || ':' || query_start::text as wait from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database() and pid <> $1",
            [holderPid],
          );
          for (const row of waiting.rows) waits.add(row.wait);
          if (waits.size < 2 && !poll.settled) throw new Error('a gravação ainda não estourou o lock_timeout');
        });
        expect((await readOutbox(suite.pool, order.orderId)).status).not.toBe('dead');

        await holder.query('rollback');
        await poll.result;
        // Se a rodada desistiu em vez de repetir, a mensagem volta quando o lease vencer.
        if ((await readOutbox(suite.pool, order.orderId)).status === 'pending') {
          await makeClaimable(suite.pool, order.orderId);
          await buildWorker(world, { pool: workerPool, telemetry: suite.telemetry }).pollOnce();
        }

        expect(await invoices(order.orderId)).toBe(1);
        expect((await readOutbox(suite.pool, order.orderId)).status).toBe('done');
        await expectInvoiced(suite.pool, order);
      } finally {
        await holder.query('rollback');
        holder.release();
        await workerPool.end();
      }
    },
  );
});

// Barreira sem sleep: a promessa abre quando o último participante chega.
function createBarrier(parties: number): { arrive(): Promise<void> } {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async arrive() {
      arrived += 1;
      if (arrived === parties) open();
      await opened;
    },
  };
}

describe('ORD-17 duas conclusões simultâneas do mesmo pedido', () => {
  const ROUNDS = 5;
  const QUANTITY = 2;
  const ON_HAND = 10;

  // Um worker atrasado (token antigo) e outro que reivindicou depois (token novo) seguram a resposta do
  // ERP até o teste liberar, e os dois concluem o mesmo pedido.
  async function startTwoWorkers() {
    const order = await acceptOrder(suite, { quantity: QUANTITY, onHand: ON_HAND });
    const world = createErpWorld(suite.database.erpPool);
    const gate = createGate();
    world.transport.afterErp({ reference: order.orderId }, () => gate.park(), 2);

    const late = startPoll(newWorker(world));
    await late.until(gate.waitForParked(1));
    const oldToken = (await readOutbox(suite.pool, order.orderId)).claimToken;
    // O lease do atrasado vence e o atraso mínimo passa: o segundo worker reivindica com um token novo.
    await makeClaimable(suite.pool, order.orderId);
    const fresh = startPoll(newWorker(world));
    await fresh.until(gate.waitForParked(2));
    const newToken = (await readOutbox(suite.pool, order.orderId)).claimToken;
    expect(oldToken).not.toBeNull();
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(oldToken);
    return { order, gate, late, fresh };
  }

  it(`ORD-17 as conclusões liberadas ao mesmo tempo, em ${ROUNDS} rodadas, baixam o estoque uma vez só`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const { order, gate, late, fresh } = await startTwoWorkers();

      gate.releaseAll();
      await Promise.all([late.result, fresh.result]);

      const inventory = await readInventory(suite.pool, order.sku);
      expect(ledgerViolations(inventory, { onHand: ON_HAND - QUANTITY, reserved: 0, soldTotal: QUANTITY }), `rodada ${round}`).toEqual([]);
      expect(await invoices(order.orderId), `rodada ${round}`).toBe(1);
      await expectInvoiced(suite.pool, order);
    }
  });

  it('ORD-17 a conclusão com o token velho não muda nada; a do token novo conclui o pedido', async () => {
    const { order, gate, late, fresh } = await startTwoWorkers();
    const before = await readOutbox(suite.pool, order.orderId);

    gate.release(0);
    await late.result;

    // O atrasado terminou, e nem o pedido, nem o estoque, nem a mensagem mudaram.
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    const afterLate = await readOutbox(suite.pool, order.orderId);
    expect(afterLate.status).toBe('pending');
    expect(afterLate.claimToken).toBe(before.claimToken);
    expect(afterLate.attempts).toBe(before.attempts);
    await expectReservationKept(order);

    gate.release(1);
    await fresh.result;
    await expectInvoiced(suite.pool, order);
    expect(await invoices(order.orderId)).toBe(1);
  });

  // A versão ingênua confere o status e grava sem a transição condicional nem o token, com a janela
  // forçada entre ler e gravar: o mesmo cenário, com a mesma conferência, acusa a baixa dupla.
  it('ORD-17 controle negativo: duas conclusões ingênuas (sem WHERE claim_token nem compare-and-set) baixam o estoque duas vezes', async () => {
    const order = await acceptOrder(suite, { quantity: QUANTITY, onHand: ON_HAND });
    const barrier = createBarrier(2);

    async function naiveConclusion(): Promise<void> {
      const client = await suite.database.pool.connect();
      try {
        await client.query('begin');
        const read = await client.query<{ status: string }>('select status from orders where id = $1', [order.orderId]);
        await barrier.arrive();
        if (read.rows[0]?.status === 'pending') {
          await client.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);
          await client.query(
            // O GREATEST só deixa a segunda baixa passar pelo CHECK reserved >= 0, que também a acusaria.
            'update inventory set on_hand = on_hand - $2, reserved = greatest(reserved - $2, 0), sold_total = sold_total + $2 where sku = $1',
            [order.sku, QUANTITY],
          );
          await client.query("update outbox set status = 'done' where order_id = $1", [order.orderId]);
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    await Promise.all([naiveConclusion(), naiveConclusion()]);

    const inventory = await readInventory(suite.pool, order.sku);
    expect(inventory.soldTotal).toBe(2 * QUANTITY);
    expect(ledgerViolations(inventory, { onHand: ON_HAND - QUANTITY, reserved: 0, soldTotal: QUANTITY })).not.toEqual([]);
  });
});

describe('ORD-20 chamadas simultâneas ao ERP', () => {
  const SLOW_MS = 5_000;

  it('ORD-20 com o limite em 3 e 8 mensagens lentas, nunca há mais de 3 chamadas em voo nem mais de 3 mensagens com lease ativo', async () => {
    const limit = 3;
    const total = 8;
    const orders: AcceptedOrder[] = [];
    for (let index = 0; index < total; index += 1) orders.push(await acceptOrder(suite));
    const ids = orders.map((order) => order.orderId);
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.setDefault({ mode: 'slow', delayMs: SLOW_MS });
    const worker = newWorker(world, { erpConcurrency: limit });

    let claimed = 0;
    while (claimed < total) {
      const expected = Math.min(limit, total - claimed);
      const poll = startPoll(worker);
      await poll.until(world.transport.waitForSends(claimed + expected, 'createOrder'));
      // No meio da rodada, só as tentativas que têm permissão seguram lease.
      expect(await countActiveLeases(suite.pool, ids)).toBe(expected);
      world.clock.advance(SLOW_MS);
      expect(await poll.result).toBe(expected);
      claimed += expected;
    }

    expect(world.transport.maxInFlight).toBe(limit);
    for (const order of orders) {
      expect(await invoices(order.orderId)).toBe(1);
      await expectInvoiced(suite.pool, order);
    }
  });

  it('ORD-20 controle do medidor: sem o limite apertado, as mesmas chamadas lentas ficam em voo juntas e o transporte medido as vê', async () => {
    const orders: AcceptedOrder[] = [];
    for (let index = 0; index < 4; index += 1) orders.push(await acceptOrder(suite));
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.setDefault({ mode: 'slow', delayMs: SLOW_MS });

    const poll = startPoll(newWorker(world, { erpConcurrency: 30 }));
    await poll.until(world.transport.waitForSends(4, 'createOrder'));
    expect(world.transport.maxInFlight).toBe(4);
    world.clock.advance(SLOW_MS);

    expect(await poll.result).toBe(4);
    for (const order of orders) expect(await invoices(order.orderId)).toBe(1);
  });
});
