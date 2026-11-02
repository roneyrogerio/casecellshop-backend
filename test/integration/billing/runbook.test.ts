import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRelay } from '../../../src/billing/relay.ts';
import { cancelOrder, redriveDlq } from '../../../src/billing/runbook.ts';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import { readInventory } from '../../helpers/checkout.ts';
import {
  buildReconciler,
  dlqTotal,
  driveClock,
  moveToDlq,
  recordCommands,
} from '../../helpers/dlq.ts';
import { countInvoices } from '../../helpers/erp.ts';
import { captureLogs } from '../../helpers/logs.ts';
import { visibleCount } from '../../helpers/sqs.ts';
import {
  acceptOrder,
  buildWorker,
  createWorld,
  expectInvoiced,
  expectQueuesEmpty,
  ledgerViolations,
  markSentBefore,
  readOrder,
  readOutbox,
  startWorkerSuite,
  submitOrder,
  type AcceptedOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Runbook da DLQ (ORD-07 e ORD-15 do M3, e o achado A12): redrive em lote e cancelamento do pedido. O ERP é o
// simulado sem a H1b, a fila é o ElasticMQ e a fatura se conta no erp_sim.

let suite: WorkerSuite;

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await suite?.stop();
});

// O banco é dividido entre os testes: uma linha não publicada que sobra de um seria lida pelo relay do seguinte.
beforeEach(async () => {
  await suite.pool.query('delete from outbox');
});

afterEach(() => {
  suite.releaseWorlds();
});

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
}

async function erpHasInvoice(
  world: QueueWorld,
  order: AcceptedOrder,
): Promise<void> {
  const created = await world.erp.createOrder({
    reference: order.orderId,
    items: [
      {
        sku: order.sku,
        quantity: order.quantity,
        unitPriceCents: order.priceCents,
      },
    ],
  });
  expect(created.kind).toBe('ok');
}

// O pedido foi enviado antes (first_sent_at) há mais que o atraso mínimo, e a mensagem está na DLQ.
async function deadOrders(
  world: QueueWorld,
  orders: AcceptedOrder[],
): Promise<void> {
  for (const order of orders) await markSentBefore(suite.pool, order.orderId);
  await moveToDlq(world, orders.length, 1);
}

// Um pedido de 2 unidades cancelado pelo runbook com a mensagem na DLQ, e o logger em memória do cenário.
async function cancelledDeadOrder() {
  const world = await createWorld(suite, {
    withoutH1b: true,
    maxReceiveCount: 1,
  });
  const logs = captureLogs();
  const order = await submitOrder(suite, world, { quantity: 2 });
  await deadOrders(world, [order]);
  expect(await cancelOrder(suite.pool, order.orderId)).toEqual({
    changed: true,
  });
  return { world, logs, order };
}

function redrive(world: QueueWorld): ReturnType<typeof redriveDlq> {
  return driveClock(
    redriveDlq({
      client: world.queues.client,
      dlqUrl: world.queues.dlqUrl,
      clock: world.clock,
    }),
    world,
  );
}

// A reserva do pedido foi devolvida ao estoque: nada reservado, nada vendido.
async function expectReservationReleased(order: AcceptedOrder): Promise<void> {
  const inventory = await readInventory(suite.pool, order.sku);
  expect(
    ledgerViolations(inventory, {
      onHand: order.onHand,
      reserved: 0,
      soldTotal: 0,
    }),
  ).toEqual([]);
}

async function expectCancelled(order: AcceptedOrder): Promise<void> {
  const row = await readOrder(suite.pool, order.orderId);
  expect(row.status).toBe('failed');
  expect(row.failureReason).toBe('cancelled');
  expect(row.outcomeAt).not.toBeNull();
}

describe('ORD-07 redrive em lote da DLQ', () => {
  it('ORD-07 o redrive de mensagens já enviadas, sem a H1b, deixa uma fatura por pedido: o que o ERP já tem é consultado, nunca criado de novo', async () => {
    const world = await createWorld(suite, {
      withoutH1b: true,
      maxReceiveCount: 1,
    });
    const has = [
      await submitOrder(suite, world, { quantity: 2 }),
      await submitOrder(suite, world, { quantity: 1 }),
    ];
    const lacks = [
      await submitOrder(suite, world, { quantity: 2 }),
      await submitOrder(suite, world, { quantity: 3 }),
    ];
    for (const order of has) await erpHasInvoice(world, order);
    await deadOrders(world, [...has, ...lacks]);
    const commands = recordCommands(world.queues.client);
    const createsBefore = world.transport.sendsOf('createOrder').length;

    const result = await redrive(world);

    expect(result).toEqual({ before: 4, remaining: 0 });
    expect(
      commands.filter((name) => name.includes('StartMessageMoveTask')),
    ).toHaveLength(1);
    // O ElasticMQ nativo cai com o ListMessageMoveTasks (R12): o runbook acompanha pela contagem da DLQ.
    expect(
      commands.filter((name) => name.includes('ListMessageMoveTasks')),
    ).toEqual([]);
    await vi.waitFor(
      async () => expect(await world.queues.queue.approximateCount()).toBe(4),
      { timeout: WAIT_GUARD_MS, interval: 50 },
    );

    // A contagem de recebimentos recomeça: o worker vê a primeira tentativa, e não a seguinte ao limite.
    expect(await buildWorker(world).pollOnce()).toBe(4);
    expect(world.queue.received.map((message) => message.receiveCount)).toEqual(
      [1, 1, 1, 1],
    );
    for (const order of [...has, ...lacks]) {
      expect(await invoices(order.orderId), `faturas de ${order.orderId}`).toBe(
        1,
      );
      await expectInvoiced(world, order, { queueEmpty: false });
    }
    // Só os pedidos que o ERP não tinha foram criados; os outros foram consultados antes.
    expect(world.transport.sendsOf('createOrder')).toHaveLength(
      createsBefore + lacks.length,
    );
    for (const order of has) {
      const found = world.transport
        .sendsOf('findOrder')
        .filter(
          (request) =>
            request.op === 'findOrder' && request.reference === order.orderId,
        );
      expect(
        found.length,
        `consultas de ${order.orderId}`,
      ).toBeGreaterThanOrEqual(1);
    }
    await expectQueuesEmpty(world);
  });

  it('ORD-07 a mensagem devolvida à fila de origem tem a contagem de recebimentos zerada', async () => {
    const world = await createWorld(suite, {
      withoutH1b: true,
      maxReceiveCount: 1,
    });
    const order = await submitOrder(suite, world);
    await deadOrders(world, [order]);

    const result = await redrive(world);

    expect(result).toEqual({ before: 1, remaining: 0 });
    await vi.waitFor(
      async () => expect(await world.queues.queue.approximateCount()).toBe(1),
      { timeout: WAIT_GUARD_MS, interval: 50 },
    );
    const [back] = await world.queues.queue.receive({ max: 1, waitSeconds: 0 });
    expect(back?.body).toContain(order.orderId);
    expect(back?.receiveCount).toBe(1);
    expect(await dlqTotal(world)).toBe(0);
  });

  it('ORD-07 com a DLQ vazia, o redrive devolve before 0 e remaining 0, sem erro', async () => {
    const world = await createWorld(suite, { maxReceiveCount: 1 });

    await expect(redrive(world)).resolves.toEqual({ before: 0, remaining: 0 });
  });
});

describe('ORD-15 cancelamento pelo runbook', () => {
  it('ORD-15 cancelar um pedido pending o deixa failed com o motivo cancelled, libera a reserva, devolve changed true e marca a linha da outbox como publicada', async () => {
    // Sem o relay: a linha da outbox nasce não publicada.
    const order = await acceptOrder(suite, { quantity: 2 });
    expect(
      (await readOutbox(suite.pool, order.orderId)).publishedAt,
    ).toBeNull();

    const result = await cancelOrder(suite.pool, order.orderId);

    expect(result).toEqual({ changed: true });
    await expectCancelled(order);
    await expectReservationReleased(order);
    expect(
      (await readOutbox(suite.pool, order.orderId)).publishedAt,
    ).not.toBeNull();
  });

  it('ORD-15 a linha da outbox que já estava publicada mantém o horário de publicação', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const before = (await readOutbox(suite.pool, order.orderId)).publishedAt;
    expect(before).not.toBeNull();

    await cancelOrder(suite.pool, order.orderId);

    expect(
      (await readOutbox(suite.pool, order.orderId)).publishedAt?.getTime(),
    ).toBe(before?.getTime());
  });

  it('ORD-15 cancelar um pedido já faturado devolve changed false e não muda o pedido nem o estoque', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, { quantity: 2 });
    expect(await buildWorker(world).pollOnce()).toBe(1);
    await expectInvoiced(world, order);

    const result = await cancelOrder(suite.pool, order.orderId);

    expect(result).toEqual({ changed: false });
    await expectInvoiced(world, order);
    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-15 cancelar duas vezes só muda na primeira: a segunda devolve changed false e a reserva não é liberada de novo', async () => {
    const order = await acceptOrder(suite, { quantity: 2 });

    expect(await cancelOrder(suite.pool, order.orderId)).toEqual({
      changed: true,
    });
    expect(await cancelOrder(suite.pool, order.orderId)).toEqual({
      changed: false,
    });

    await expectCancelled(order);
    await expectReservationReleased(order);
  });

  it('ORD-15 a mensagem que ficou na DLQ do pedido cancelado é apagada pela reconciliação, com casecellshop.outbox.closed, sem chamar o ERP nem criar fatura', async () => {
    const { world, logs, order } = await cancelledDeadOrder();
    const rig = buildReconciler(world, { logger: logs.logger });

    const result = await rig.reconciler.reconcileOnce();

    expect(result).toEqual({ seen: 1, invoiced: 0, closed: 1 });
    expect(world.transport.sends).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect(await dlqTotal(world)).toBe(0);
    expect(
      logs.eventsOf('casecellshop.outbox.closed', order.orderId),
    ).toHaveLength(1);
    await expectCancelled(order);
    await expectReservationReleased(order);
  });

  it('ORD-15 depois de um redrive, o worker apaga a mensagem do pedido cancelado sem chamar o ERP e sem criar fatura', async () => {
    const { world, logs, order } = await cancelledDeadOrder();
    await redrive(world);
    await vi.waitFor(
      async () => expect(await world.queues.queue.approximateCount()).toBe(1),
      { timeout: WAIT_GUARD_MS, interval: 50 },
    );

    expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(
      1,
    );

    expect(world.transport.sends).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect(
      world.queue.deletesOf(order.orderId).map((call) => call.result),
    ).toEqual(['ok']);
    expect(
      logs.eventsOf('casecellshop.outbox.closed', order.orderId),
    ).toHaveLength(1);
    await expectQueuesEmpty(world);
    await expectCancelled(order);
    await expectReservationReleased(order);
  });
});

describe('ORD-15 A12: a linha da outbox que não passa no schema da mensagem', () => {
  it('ORD-15 o relay segue ignorando a linha inválida (casecellshop.outbox.row.rejected a cada rodada) e, depois do cancelamento do pedido, não a lê mais', async () => {
    const world = await createWorld(suite);
    const logs = captureLogs();
    const relay = createRelay({
      pool: suite.pool,
      queue: world.queues.queue,
      logger: logs.logger,
      telemetry: world.telemetry,
      clock: world.clock,
    });
    // Escrita direto no SQL, fora da API: a única forma de uma linha que o BillingMessage recusa chegar à outbox.
    const inserted = await suite.pool.query<{ id: string }>(
      'insert into orders default values returning id',
    );
    const orderId = inserted.rows[0]?.id ?? '';
    await suite.pool.query(
      "insert into outbox (order_id, correlation_id, created_at) values ($1, 'req com espaço', now())",
      [orderId],
    );

    expect(await relay.publishOnce()).toBe(0);
    expect(await relay.publishOnce()).toBe(0);
    expect(
      logs.eventsOf('casecellshop.outbox.row.rejected', orderId),
      'uma linha inválida por rodada, enquanto o pedido não é cancelado',
    ).toHaveLength(2);

    expect(await cancelOrder(suite.pool, orderId)).toEqual({ changed: true });

    expect(
      (await readOutbox(suite.pool, orderId)).publishedAt,
      'o cancelamento marca a linha como publicada',
    ).not.toBeNull();
    expect(await relay.publishOnce()).toBe(0);
    expect(
      logs.eventsOf('casecellshop.outbox.row.rejected', orderId),
    ).toHaveLength(2);
    expect(logs.eventsOf('casecellshop.outbox.relay.failed')).toEqual([]);
    // Nada foi publicado no SQS por causa dela.
    expect(await visibleCount(world.emq, world.queues.queueUrl)).toBe(0);
  });
});
