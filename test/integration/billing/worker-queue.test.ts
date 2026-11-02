import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createSemaphore,
  type Semaphore,
} from '../../../src/shared/semaphore.ts';
import { settle, WAIT_GUARD_MS } from '../../helpers/async.ts';
import { createAppPool, readInventory } from '../../helpers/checkout.ts';
import {
  countInvoices,
  ERP_TIMEOUT_MS,
  MIN_RETRY_DELAY_MS,
} from '../../helpers/erp.ts';
import { captureLogs } from '../../helpers/logs.ts';
import {
  acceptOrder,
  buildWorker,
  CONCLUSION_STATEMENT,
  createGate,
  createWorld,
  enqueueRaw,
  expectInvoiced,
  expectOneInFlight,
  expectQueuesEmpty,
  interceptPool,
  ledgerViolations,
  makeClaimable,
  readOrder,
  retrySeconds,
  snapshotQueues,
  startPoll,
  startWorkerSuite,
  stopAdvancing,
  submitOrder,
  untilState,
  waitForDlq,
  within,
  type AcceptedOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Fila, DLQ, falha do banco e concorrência do envio sobre o SQS (ORD-12, ORD-13, ORD-16, ORD-17, ORD-20).

let suite: WorkerSuite;

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await suite?.stop();
});

afterEach(() => {
  suite.releaseWorlds();
});

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
}

// Chamadas de criação desta referência que chegaram ao transporte.
function createsFor(world: QueueWorld, reference: string): number {
  return world.transport.sends.filter(
    (request) =>
      request.op === 'createOrder' && request.body.reference === reference,
  ).length;
}

// A reserva do pedido segue de pé e nada foi vendido: o pedido ainda pode ser faturado.
async function expectReservationKept(order: AcceptedOrder): Promise<void> {
  const inventory = await readInventory(suite.pool, order.sku);
  expect(
    ledgerViolations(inventory, {
      onHand: order.onHand,
      reserved: order.quantity,
      soldTotal: 0,
    }),
  ).toEqual([]);
}

describe('ORD-12 mensagem que derruba o processo', () => {
  it('ORD-12 chega à DLQ do SQS sozinha pelo limite de recebimentos, sem nova chamada ao ERP depois dele, e as outras do lote são faturadas', async () => {
    const maxReceiveCount = 3;
    const world = await createWorld(suite, { maxReceiveCount });
    const poison = await submitOrder(suite, world, { quantity: 2 });
    const healthy = [
      await submitOrder(suite, world),
      await submitOrder(suite, world),
    ];
    // A chamada desta mensagem derruba o processo: o worker nunca volta dela, a cada recebimento.
    world.transport.stall(
      { op: 'createOrder', reference: poison.orderId },
      { callErp: false, times: Infinity },
    );

    // Primeiro recebimento: as três mensagens no mesmo lote; as saudáveis são faturadas ao lado da que trava.
    const batch = startPoll(buildWorker(world));
    await untilState(batch, async () => {
      for (const order of healthy)
        expect((await readOrder(suite.pool, order.orderId)).status).toBe(
          'invoiced',
        );
    });
    await batch.until(world.transport.waitForSends(3, 'createOrder'));
    expect(
      world.queue.received.filter((message) => message.receiveCount === 1),
    ).toHaveLength(3);

    // A visibilidade vence e o atraso mínimo passa; um processo novo recebe de novo e trava de novo.
    for (let receive = 2; receive <= maxReceiveCount; receive += 1) {
      await makeClaimable(world, poison.orderId);
      const next = startPoll(buildWorker(world));
      await next.until(
        world.transport.waitForSends(2 + receive, 'createOrder'),
      );
      expect(world.queue.received.at(-1)?.receiveCount).toBe(receive);
    }
    expect(createsFor(world, poison.orderId)).toBe(maxReceiveCount);

    // Limite gasto: o recebimento seguinte não devolve a mensagem, o SQS a move para a DLQ, e o ERP não é chamado.
    await makeClaimable(world, poison.orderId);
    expect(await buildWorker(world).pollOnce()).toBe(0);
    await waitForDlq(world, 1);

    const [dead] = await world.queues.dlq.receive({ max: 1, waitSeconds: 0 });
    expect(dead?.body).toContain(poison.orderId);
    expect(createsFor(world, poison.orderId)).toBe(maxReceiveCount);
    expect((await readOrder(suite.pool, poison.orderId)).status).toBe(
      'pending',
    );
    await expectReservationKept(poison);
    expect(await invoices(poison.orderId)).toBe(0);
    for (const order of healthy) {
      expect(await invoices(order.orderId)).toBe(1);
      await expectInvoiced(world, order, { queueEmpty: false });
    }
    expect((await snapshotQueues(world)).queue).toEqual({
      visible: 0,
      notVisible: 0,
    });
  });

  it.each([
    [
      'JSON fora do schema da mensagem',
      '{"orderId":"nao-e-um-uuid","correlationId":"req-1"}',
    ],
    ['texto que não é JSON', 'isto nao e json'],
  ])(
    'ORD-12 corpo com %s: o worker não chama o ERP, loga casecellshop.outbox.message.rejected, não responde ao SQS e a mensagem chega à DLQ pelo limite',
    async (_label, body) => {
      const maxReceiveCount = 2;
      const world = await createWorld(suite, { maxReceiveCount });
      const logs = captureLogs();
      // Uma mensagem boa na mesma fila: o corpo inválido não a segura.
      const good = await submitOrder(suite, world);
      await enqueueRaw(world, body);
      const worker = buildWorker(world, { logger: logs.logger });

      expect(await worker.pollOnce()).toBe(2);
      expect(await invoices(good.orderId)).toBe(1);
      for (let receive = 2; receive <= maxReceiveCount; receive += 1) {
        expect(
          await world.queues.queue.changeVisibility(
            world.queue.latestHandle(),
            0,
          ),
        ).toBe('ok');
        expect(await worker.pollOnce()).toBe(1);
      }
      expect(
        await world.queues.queue.changeVisibility(
          world.queue.latestHandle(),
          0,
        ),
      ).toBe('ok');
      expect(await worker.pollOnce()).toBe(0);
      await waitForDlq(world, 1);

      // Nenhuma chamada ao ERP por causa dela, e nenhuma resposta ao SQS: só a do pedido bom.
      expect(world.transport.sends).toHaveLength(1);
      expect(world.queue.deletes).toHaveLength(1);
      expect(world.queue.visibilityChanges).toEqual([]);
      const invalid = logs.eventsOf('casecellshop.outbox.message.rejected');
      expect(invalid).toHaveLength(maxReceiveCount);
      expect(invalid[0]).toMatchObject({ level: 'error' });
      const [dead] = await world.queues.dlq.receive({ max: 1, waitSeconds: 0 });
      expect(dead?.body).toBe(body);
      await expectInvoiced(world, good, { queueEmpty: false });
    },
  );
});

describe('ORD-13 limite de recebimentos com falha transitória', () => {
  const BASE_MS = 5_000;
  const CAP_MS = 20_000;
  const MAX_RECEIVE_COUNT = 5;

  it.each([0, 0.5, 0.999])(
    'ORD-13 com o sorteio fixo em %d, cada retry esconde a mensagem pelo atraso mínimo mais o jitter sobre o exponencial com teto, e depois do limite ela está na DLQ com o pedido pending e a reserva mantida',
    async (random) => {
      const world = await createWorld(suite, {
        maxReceiveCount: MAX_RECEIVE_COUNT,
      });
      const order = await submitOrder(suite, world, { quantity: 2 });
      world.sim.script.setDefault({ mode: 'unavailable' });
      const worker = buildWorker(world, {
        random: () => random,
        config: { backoffBaseMs: BASE_MS, backoffCapMs: CAP_MS },
      });

      for (let attempt = 1; attempt <= MAX_RECEIVE_COUNT; attempt += 1) {
        expect(await worker.pollOnce(), `recebimento ${attempt}`).toBe(1);
        expect(world.queue.received.at(-1)?.receiveCount).toBe(attempt);
        const changes = world.queue.changesOf(order.orderId);
        expect(changes, `retry depois do recebimento ${attempt}`).toHaveLength(
          attempt,
        );
        // Full jitter: o sorteio escala um teto que dobra a cada tentativa até o limite de 20 s.
        const shape = {
          minDelayMs: MIN_RETRY_DELAY_MS,
          baseMs: BASE_MS,
          capMs: CAP_MS,
          random,
        };
        expect(changes[attempt - 1]?.result).toBe('ok');
        expect(
          changes[attempt - 1]?.seconds ?? 0,
          `retry depois do recebimento ${attempt}`,
        ).toBeGreaterThanOrEqual(retrySeconds({ ...shape, attempt }));
        expect(
          changes[attempt - 1]?.seconds ?? 0,
          `retry depois do recebimento ${attempt}`,
        ).toBeLessThanOrEqual(retrySeconds({ ...shape, attempt: attempt + 1 }));
        await makeClaimable(world, order.orderId);
      }

      // O recebimento seguinte ao limite: o SQS move a mensagem para a DLQ, e o worker não a vê.
      expect(await worker.pollOnce()).toBe(0);
      await waitForDlq(world, 1);
      // Uma chamada por recebimento (a primeira cria; as outras consultam, e a consulta que falha nunca cria),
      // nenhuma além do limite, e a DLQ não mexe no pedido nem na reserva.
      expect(world.transport.sends).toHaveLength(MAX_RECEIVE_COUNT);
      expect((await readOrder(suite.pool, order.orderId)).status).toBe(
        'pending',
      );
      await expectReservationKept(order);
      expect(await invoices(order.orderId)).toBe(0);
      expect(world.queue.deletes).toEqual([]);
      expect((await snapshotQueues(world)).queue).toEqual({
        visible: 0,
        notVisible: 0,
      });
    },
  );
});

describe('ORD-16 falha do banco ao gravar o desfecho', () => {
  // O lock é tomado depois de o ERP faturar e antes de o worker gravar o desfecho: a gravação estoura o
  // lock_timeout (500 ms neste pool), e a mensagem não pode ir para a DLQ por isso nem ser apagada.
  it.each(['outbox', 'orders', 'inventory'] as const)(
    'ORD-16 um lock na linha de %s que estoura o lock_timeout da gravação não manda a mensagem para a DLQ nem a apaga: termina invoiced com uma fatura',
    async (table) => {
      const world = await createWorld(suite);
      const order = await submitOrder(suite, world);
      const workerPool = createAppPool(suite.database.uri, 10, {
        lockTimeoutMs: 500,
      });
      const holder = await suite.database.pool.connect();
      const lockSql = {
        outbox: [
          'select 1 from outbox where order_id = $1 for update',
          order.orderId,
        ],
        orders: [
          'select 1 from orders where id = $1 for update',
          order.orderId,
        ],
        inventory: [
          'select 1 from inventory where sku = $1 for update',
          order.sku,
        ],
      } as const;
      try {
        const holderPid = (
          await holder.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]?.pid;
        world.transport.afterErp(
          { op: 'createOrder', reference: order.orderId },
          async () => {
            await holder.query('begin');
            await holder.query(lockSql[table][0], [lockSql[table][1]]);
          },
        );
        const poll = startPoll(buildWorker(world, { pool: workerPool }));

        // Espera a gravação estourar o lock_timeout pelo menos uma vez: duas esperas distintas no lock
        // (a segunda é a nova tentativa de gravar), ou a rodada terminar sem ter gravado.
        const waits = new Set<string>();
        await untilState(poll, async () => {
          const waiting = await suite.database.pool.query<{ wait: string }>(
            "select pid::text || ':' || query_start::text as wait from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database() and pid <> $1",
            [holderPid],
          );
          for (const row of waiting.rows) waits.add(row.wait);
          if (waits.size < 2 && !poll.settled)
            throw new Error('a gravação ainda não estourou o lock_timeout');
        });
        expect(
          world.queue.deletes,
          'a mensagem não é apagada antes do desfecho gravado',
        ).toEqual([]);
        expect((await snapshotQueues(world)).dlq).toEqual({
          visible: 0,
          notVisible: 0,
        });

        await holder.query('rollback');
        await poll.result;
        // Se a rodada desistiu em vez de repetir, a mensagem volta quando a visibilidade vencer.
        if ((await readOrder(suite.pool, order.orderId)).status === 'pending') {
          await makeClaimable(world, order.orderId);
          await buildWorker(world, { pool: workerPool }).pollOnce();
        }

        expect(await invoices(order.orderId)).toBe(1);
        await expectInvoiced(world, order);
      } finally {
        await holder.query('rollback');
        holder.release();
        await workerPool.end();
      }
    },
  );

  it('ORD-16 com a gravação do desfecho falhando sempre, o worker tenta no máximo 5 vezes por tentativa, desiste sem responder ao SQS e a mensagem volta à fila e conclui depois', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const logs = captureLogs();
    const probe = interceptPool(suite.pool, {
      match: CONCLUSION_STATEMENT,
      fail: () =>
        Object.assign(new Error('falha injetada ao gravar o desfecho'), {
          code: '40001',
        }),
    });

    expect(
      await buildWorker(world, {
        pool: probe.pool,
        logger: logs.logger,
      }).pollOnce(),
    ).toBe(1);

    // A injeção disparou, e cada transação de conclusão tentada foi contada: o teto é 5.
    expect(probe.fired, 'transações de conclusão tentadas').toBe(5);
    expect(
      logs.eventsOf('casecellshop.outbox.conclusion.failed', order.orderId)
        .length,
    ).toBeGreaterThanOrEqual(1);
    // Esgotadas as repetições, a mensagem não é apagada, nem devolvida, nem vai para a DLQ.
    expect(world.queue.deletes).toEqual([]);
    expect(world.queue.visibilityChanges).toEqual([]);
    await expectOneInFlight(world);
    // O ERP já tinha faturado; o pedido segue pending, com a reserva, até a mensagem voltar.
    expect(await invoices(order.orderId)).toBe(1);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    await expectReservationKept(order);

    // A visibilidade vence: a mensagem volta, a consulta acha a fatura e o desfecho é gravado.
    probe.armed = false;
    await makeClaimable(world, order.orderId);
    expect(await buildWorker(world, { pool: probe.pool }).pollOnce()).toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it('ORD-16 com o prazo da mensagem vencido, o worker não repete a gravação: uma tentativa só e a mensagem fica para voltar', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    // A primeira gravação que falha leva o relógio injetável além da visibilidade da mensagem (60 s).
    const probe = interceptPool(suite.pool, {
      match: CONCLUSION_STATEMENT,
      before: () => world.clock.advance(61_000),
      fail: () =>
        Object.assign(new Error('falha injetada ao gravar o desfecho'), {
          code: '40001',
        }),
    });

    expect(await buildWorker(world, { pool: probe.pool }).pollOnce()).toBe(1);

    expect(probe.fired, 'transações de conclusão tentadas').toBe(1);
    expect(world.queue.deletes).toEqual([]);
    expect(world.queue.visibilityChanges).toEqual([]);
    await expectOneInFlight(world);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
  });
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

  // Um worker atrasado (receipt handle antigo) e outro que recebeu a mensagem de novo seguram a resposta do
  // ERP até o teste liberar, e os dois concluem o mesmo pedido.
  async function startTwoWorkers() {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, {
      quantity: QUANTITY,
      onHand: ON_HAND,
    });
    const gate = createGate();
    world.transport.afterErp(
      { reference: order.orderId },
      () => gate.park(),
      2,
    );

    const late = startPoll(buildWorker(world));
    await late.until(gate.waitForParked(1));
    const lateHandle = world.queue.latestHandle(order.orderId);
    // A visibilidade do atrasado vence e o atraso mínimo passa: o segundo worker recebe a mensagem de novo.
    await makeClaimable(world, order.orderId);
    const fresh = startPoll(buildWorker(world));
    await fresh.until(gate.waitForParked(2));
    expect(
      world.queue.latestHandle(order.orderId),
      'o segundo worker tem um receipt handle novo',
    ).not.toBe(lateHandle);
    return { world, order, gate, late, fresh };
  }

  it(`ORD-17 as conclusões liberadas ao mesmo tempo, em ${ROUNDS} rodadas, baixam o estoque uma vez só`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const { world, order, gate, late, fresh } = await startTwoWorkers();

      gate.releaseAll();
      await Promise.all([late.result, fresh.result]);

      const inventory = await readInventory(suite.pool, order.sku);
      expect(
        ledgerViolations(inventory, {
          onHand: ON_HAND - QUANTITY,
          reserved: 0,
          soldTotal: QUANTITY,
        }),
        `rodada ${round}`,
      ).toEqual([]);
      expect(await invoices(order.orderId), `rodada ${round}`).toBe(1);
      await expectInvoiced(world, order);
    }
  });

  it('ORD-17 a conclusão do atrasado grava o desfecho por compare-and-set e o SQS recusa o receipt handle dele; a do segundo encontra o pedido já concluído e apaga a mensagem', async () => {
    const { world, order, gate, late, fresh } = await startTwoWorkers();

    gate.release(0);
    await late.result;

    // O ERP faturou, então o desfecho do atrasado vale (o compare-and-set decide, não o handle); só o SQS o recusa.
    expect((await readOrder(suite.pool, order.orderId)).status).toBe(
      'invoiced',
    );
    expect(world.queue.deletes.map((call) => call.result)).toEqual(['stale']);
    expect(
      world.queue.visibilityChanges.filter((call) => call.result !== 'ok'),
    ).toEqual([]);

    gate.release(1);
    await fresh.result;
    expect(world.queue.deletes.map((call) => call.result)).toEqual([
      'stale',
      'ok',
    ]);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  // A versão ingênua confere o status e grava sem a transição condicional, com a janela forçada entre
  // ler e gravar: o mesmo cenário, com a mesma conferência, acusa a baixa dupla.
  it('ORD-17 controle negativo: duas conclusões ingênuas (sem compare-and-set) baixam o estoque duas vezes', async () => {
    const order = await acceptOrder(suite, {
      quantity: QUANTITY,
      onHand: ON_HAND,
    });
    const barrier = createBarrier(2);

    async function naiveConclusion(): Promise<void> {
      const client = await suite.database.pool.connect();
      try {
        await client.query('begin');
        const read = await client.query<{ status: string }>(
          'select status from orders where id = $1',
          [order.orderId],
        );
        await barrier.arrive();
        if (read.rows[0]?.status === 'pending') {
          await client.query(
            "update orders set status = 'invoiced', outcome_at = now() where id = $1",
            [order.orderId],
          );
          await client.query(
            // O GREATEST só deixa a segunda baixa passar pelo CHECK reserved >= 0, que também a acusaria.
            'update inventory set on_hand = on_hand - $2, reserved = greatest(reserved - $2, 0), sold_total = sold_total + $2 where sku = $1',
            [order.sku, QUANTITY],
          );
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
    expect(
      ledgerViolations(inventory, {
        onHand: ON_HAND - QUANTITY,
        reserved: 0,
        soldTotal: QUANTITY,
      }),
    ).not.toEqual([]);
  });
});

describe('ORD-20 chamadas simultâneas ao ERP', () => {
  const SLOW_MS = 5_000;

  it('ORD-20 com o limite em 3 e 8 mensagens lentas, nunca há mais de 3 chamadas em voo, e só se recebem do SQS as mensagens que têm permissão', async () => {
    const limit = 3;
    const total = 8;
    const world = await createWorld(suite);
    const orders: AcceptedOrder[] = [];
    for (let index = 0; index < total; index += 1)
      orders.push(await submitOrder(suite, world));
    world.sim.script.setDefault({ mode: 'slow', delayMs: SLOW_MS });
    const worker = buildWorker(world, { config: { erpConcurrency: limit } });

    let handled = 0;
    while (handled < total) {
      const expected = Math.min(limit, total - handled);
      const poll = startPoll(worker);
      await poll.until(
        world.transport.waitForSends(handled + expected, 'createOrder'),
      );
      // No meio da rodada, só as tentativas que têm permissão foram recebidas: as outras seguem visíveis no SQS,
      // com a visibilidade sem correr.
      await vi.waitFor(
        async () => {
          expect((await snapshotQueues(world)).queue).toEqual({
            visible: total - handled - expected,
            notVisible: expected,
          });
        },
        { timeout: WAIT_GUARD_MS },
      );
      world.clock.advance(SLOW_MS);
      expect(await within(poll.result, 'a rodada terminar')).toBe(expected);
      handled += expected;
    }

    expect(world.queue.receives[0]).toMatchObject({
      max: limit,
      visibilitySeconds: 60,
    });
    expect(world.transport.maxInFlight).toBe(limit);
    for (const order of orders) {
      expect(await invoices(order.orderId)).toBe(1);
      await expectInvoiced(world, order, { queueEmpty: false });
    }
    await expectQueuesEmpty(world);
  });

  // Um semáforo que o teste inspeciona: quem adquire espera ao menos uma permissão livre e toma todas.
  async function freePermits(semaphore: Semaphore): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(-1), 2_000);
    });
    const got = await Promise.race([semaphore.acquireFree(), timeout]);
    clearTimeout(timer);
    return got;
  }

  it('ORD-20 a rodada que recebeu menos mensagens que permissões, ou nenhuma, devolve as permissões que sobraram ao semáforo', async () => {
    const world = await createWorld(suite);
    await submitOrder(suite, world);
    const semaphore = createSemaphore(3);
    const worker = buildWorker(world, {
      semaphore,
      config: { erpConcurrency: 3 },
    });

    // Uma mensagem para três permissões: o receive pede até 3, recebe 1 e devolve 2; a tentativa devolve a dela.
    expect(await worker.pollOnce()).toBe(1);
    expect(world.queue.receives[0]).toMatchObject({ max: 3 });
    expect(await freePermits(semaphore)).toBe(3);
    semaphore.release(3);

    // Fila vazia: nenhuma mensagem, as três permissões voltam.
    expect(await worker.pollOnce()).toBe(0);
    expect(world.queue.receives).toHaveLength(2);
    expect(await freePermits(semaphore)).toBe(3);
  });

  it('ORD-20 sem permissão livre o worker não recebe do SQS: a mensagem continua visível, e só é recebida quando uma permissão volta', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const semaphore = createSemaphore(2);
    const held = await semaphore.acquireFree();
    expect(held).toBe(2);
    const poll = startPoll(
      buildWorker(world, { semaphore, config: { erpConcurrency: 2 } }),
    );

    await settle(20);
    expect(world.queue.receives, 'nenhum recebimento sem permissão').toEqual(
      [],
    );
    expect((await snapshotQueues(world)).queue).toEqual({
      visible: 1,
      notVisible: 0,
    });

    semaphore.release(held);
    expect(await poll.result).toBe(1);
    expect(world.queue.receives).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it('ORD-20 com start(), uma chamada presa em voo não impede o worker de receber e faturar as outras assim que há permissão livre', async () => {
    const world = await createWorld(suite);
    const stuck = await submitOrder(suite, world);
    const others: AcceptedOrder[] = [];
    for (let index = 0; index < 4; index += 1)
      others.push(await submitOrder(suite, world));
    world.sim.script.enqueue(
      { mode: 'hang' },
      { op: 'createOrder', reference: stuck.orderId },
    );
    const worker = buildWorker(world, {
      config: { erpConcurrency: 3, receiveWaitSeconds: 1 },
    });
    const started = worker.start();
    started.catch(() => undefined);

    // As 4 normais passam por 2 permissões: as duas últimas só saem se o recebimento não esperar a presa.
    // O relógio não anda: nada aqui depende dele.
    await vi.waitFor(
      async () => {
        for (const order of others)
          expect((await readOrder(suite.pool, order.orderId)).status).toBe(
            'invoiced',
          );
      },
      { timeout: WAIT_GUARD_MS, interval: 25 },
    );

    // Enquanto isso a presa seguiu em voo, com a mensagem escondida e sem fatura.
    expect(createsFor(world, stuck.orderId)).toBe(1);
    expect((await readOrder(suite.pool, stuck.orderId)).status).toBe('pending');
    expect(await invoices(stuck.orderId)).toBe(0);
    expect(world.transport.maxInFlight).toBeLessThanOrEqual(3);
    await vi.waitFor(
      async () =>
        expect((await snapshotQueues(world)).queue).toEqual({
          visible: 0,
          notVisible: 1,
        }),
      { timeout: WAIT_GUARD_MS },
    );
    for (const order of others) {
      expect(await invoices(order.orderId)).toBe(1);
      await expectInvoiced(world, order, { queueEmpty: false });
    }

    // O timeout no relógio manual solta a presa (ambígua); o stop() espera as tentativas e para.
    world.clock.advance(ERP_TIMEOUT_MS);
    await stopAdvancing(worker, world);
    // A presa terminou como ambígua: nenhuma fatura, o pedido segue pendente e a mensagem volta ao SQS pelo retry.
    expect(await invoices(stuck.orderId)).toBe(0);
    expect((await readOrder(suite.pool, stuck.orderId)).status).toBe('pending');
    expect(world.queue.changesOf(stuck.orderId)).toHaveLength(1);
  });

  it('ORD-20 controle do medidor: sem o limite apertado, as mesmas chamadas lentas ficam em voo juntas e o transporte medido as vê', async () => {
    const world = await createWorld(suite);
    const orders: AcceptedOrder[] = [];
    for (let index = 0; index < 4; index += 1)
      orders.push(await submitOrder(suite, world));
    world.sim.script.setDefault({ mode: 'slow', delayMs: SLOW_MS });

    const poll = startPoll(
      buildWorker(world, { config: { erpConcurrency: 30 } }),
    );
    await poll.until(world.transport.waitForSends(4, 'createOrder'));
    expect(world.transport.maxInFlight).toBe(4);
    world.clock.advance(SLOW_MS);

    expect(await poll.result).toBe(4);
    for (const order of orders) expect(await invoices(order.orderId)).toBe(1);
    // O recebimento pediu até 10 mensagens (o máximo do SQS), porque havia 30 permissões.
    expect(world.queue.receives[0]).toMatchObject({ max: 10 });
  });
});
