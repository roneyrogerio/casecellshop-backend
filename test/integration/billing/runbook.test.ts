import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_CALL_DELAY_MS,
  SETTLE_WINDOW_MS,
  takeCallPermit,
} from '../../../src/billing/call-permit.ts';
import { createRelay } from '../../../src/billing/relay.ts';
import {
  cancelOrder,
  describeCancel,
  redriveDlq,
  type CancelOrderResult,
} from '../../../src/billing/runbook.ts';
import { createDb } from '../../../src/db/database.ts';
import type { ErpClient } from '../../../src/erp/erp-client.ts';
import type { ErpSimBehavior } from '../../../src/erp/sim/index.ts';
import { settle, WAIT_GUARD_MS } from '../../helpers/async.ts';
import {
  readInventory,
  type InventorySnapshot,
} from '../../helpers/checkout.ts';
import {
  buildReconciler,
  dlqTotal,
  driveClock,
  moveToDlq,
  recordCommands,
} from '../../helpers/dlq.ts';
import { countInvoices, ERP_TIMEOUT_MS } from '../../helpers/erp.ts';
import { erpHasInvoice } from '../../helpers/erp-invoice.ts';
import {
  PAST_WINDOW_SECONDS,
  readLateColumns,
  seedOutcome,
  seedSentState,
  SETTLE_WINDOW_SECONDS,
  WITHIN_WINDOW_SECONDS,
} from '../../helpers/late-check.ts';
import { captureLogs } from '../../helpers/logs.ts';
import { visibleCount } from '../../helpers/sqs.ts';
import {
  acceptOrder,
  ageLastCall,
  buildWorker,
  createWorld,
  expectInvoiced,
  expectQueuesEmpty,
  ledgerViolations,
  markSentBefore,
  readOrder,
  readOutbox,
  startPoll,
  submitOrder,
  useWorkerSuite,
  type AcceptedOrder,
  type OrderRow,
  type OutboxRow,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Runbook da DLQ (ORD-07 e ORD-15 do M3, o achado A12 e o ORD-26 da AD-031): redrive em lote e cancelamento
// seguro do pedido. O ERP é o simulado sem a H1b, a fila é o ElasticMQ e a fatura se conta no erp_sim.

const suiteOf = useWorkerSuite();
let suite: WorkerSuite;

// O banco é dividido entre os testes: uma linha não publicada que sobra de um seria lida pelo relay do seguinte.
beforeEach(async () => {
  suite = suiteOf();
  await suite.pool.query('delete from outbox');
});

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
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
  // A última chamada ao ERP passa da janela de assentamento (AD-031): sem isso o cancelamento é recusado.
  await ageLastCall(suite.pool, order.orderId, PAST_WINDOW_SECONDS);
  expect(await cancel(world, order.orderId)).toEqual({ kind: 'cancelled' });
  // O cancelamento consultou o ERP uma vez, pela referência, e não criou nada: o que a reconciliação ou o
  // worker fizerem depois não pode somar chamadas.
  expect(world.transport.sends).toHaveLength(1);
  expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
  return { world, logs, order, sendsAfterCancel: world.transport.sends.length };
}

// Um pedido de 2 unidades aceito pelo checkout, nunca enviado ao ERP, num mundo sem a H1b.
async function freshOrder() {
  const world = await createWorld(suite, { withoutH1b: true });
  return { world, order: await acceptOrder(suite, { quantity: 2 }) };
}

// O cancelamento sobre o pool da suíte e o ERP do mundo do teste (ACL sobre o simulado, no relógio manual).
function cancel(
  world: Pick<QueueWorld, 'erp'>,
  orderId: string,
  settleWindowMs?: number,
): Promise<CancelOrderResult> {
  return cancelOrder(
    {
      pool: suite.pool,
      erp: world.erp,
      ...(settleWindowMs === undefined ? {} : { settleWindowMs }),
    },
    orderId,
  );
}

// O que uma recusa não pode mudar: o pedido, o estoque e a marca de publicação da outbox.
interface Footprint {
  order: OrderRow;
  inventory: InventorySnapshot;
  publishedAt: Date | null;
}

async function footprintOf(order: AcceptedOrder): Promise<Footprint> {
  return {
    order: await readOrder(suite.pool, order.orderId),
    inventory: await readInventory(suite.pool, order.sku),
    publishedAt: (await readOutbox(suite.pool, order.orderId)).publishedAt,
  };
}

// A linha da outbox sem a idade da última chamada, que anda com o relógio do banco.
function stableOutbox(row: OutboxRow) {
  return {
    publishedAt: row.publishedAt,
    firstSentAt: row.firstSentAt,
    lastCallAt: row.lastCallAt,
    callToken: row.callToken,
    deadAt: row.deadAt,
  };
}

// O cancelamento de um pedido que já não está pending (AD-031): devolve unchanged sem consultar o ERP (nenhuma
// requisição nova) nem tomar a permissão de chamada (last_call_at, call_token, first_sent_at e published_at
// ficam como estavam, para a verificação tardia não atrasar), e sem mexer no pedido nem no estoque.
async function expectUnchangedWithoutTouchingErp(
  world: Pick<QueueWorld, 'erp' | 'transport'>,
  order: AcceptedOrder,
): Promise<void> {
  const footprint = await footprintOf(order);
  const outbox = stableOutbox(await readOutbox(suite.pool, order.orderId));
  const sendsBefore = world.transport.sends.length;

  const result = await cancel(world, order.orderId);

  expect(result).toEqual({ kind: 'unchanged' });
  expect(world.transport.sends).toHaveLength(sendsBefore);
  expect(await footprintOf(order)).toEqual(footprint);
  expect(stableOutbox(await readOutbox(suite.pool, order.orderId))).toEqual(
    outbox,
  );
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
  it('ORD-15 cancelar um pedido pending que o ERP não tem o deixa failed com o motivo cancelled, libera a reserva, devolve cancelled e marca a linha da outbox como publicada', async () => {
    // Sem o relay: a linha da outbox nasce não publicada.
    const { world, order } = await freshOrder();
    expect(
      (await readOutbox(suite.pool, order.orderId)).publishedAt,
    ).toBeNull();

    const result = await cancel(world, order.orderId);

    expect(result).toEqual({ kind: 'cancelled' });
    await expectCancelled(order);
    await expectReservationReleased(order);
    expect(
      (await readOutbox(suite.pool, order.orderId)).publishedAt,
    ).not.toBeNull();
    expect(await invoices(order.orderId)).toBe(0);
  });

  it('ORD-15 a linha da outbox que já estava publicada mantém o horário de publicação', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const before = (await readOutbox(suite.pool, order.orderId)).publishedAt;
    expect(before).not.toBeNull();

    expect(await cancel(world, order.orderId)).toEqual({ kind: 'cancelled' });

    expect(
      (await readOutbox(suite.pool, order.orderId)).publishedAt?.getTime(),
    ).toBe(before?.getTime());
  });

  it('ORD-15 cancelar um pedido já faturado, mesmo fora da janela de assentamento e com a fatura no ERP, devolve unchanged na hora: não consulta o ERP, não toma a permissão e não muda o pedido, o estoque nem a outbox', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, { quantity: 2 });
    expect(await buildWorker(world).pollOnce()).toBe(1);
    await expectInvoiced(world, order);
    await ageLastCall(suite.pool, order.orderId, PAST_WINDOW_SECONDS);

    await expectUnchangedWithoutTouchingErp(world, order);

    await expectInvoiced(world, order);
    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-15 o pedido que já tem desfecho e que o ERP não tem devolve unchanged: o motivo e o estoque ficam como estavam', async () => {
    const { world, order } = await freshOrder();
    await seedOutcome(suite.pool, order, {
      status: 'failed',
      reason: 'erp_rejected',
    });

    await expectUnchangedWithoutTouchingErp(world, order);

    expect((await readOrder(suite.pool, order.orderId)).failureReason).toBe(
      'erp_rejected',
    );
  });

  it('ORD-15 cancelar duas vezes só muda na primeira: a segunda devolve unchanged e a reserva não é liberada de novo', async () => {
    const { world, order } = await freshOrder();

    expect(await cancel(world, order.orderId)).toEqual({ kind: 'cancelled' });
    // A segunda não espera a janela de assentamento: o pedido já não está pending.
    expect(await cancel(world, order.orderId)).toEqual({ kind: 'unchanged' });

    await expectCancelled(order);
    await expectReservationReleased(order);
  });

  it('ORD-15 a mensagem que ficou na DLQ do pedido cancelado é apagada pela reconciliação, com casecellshop.outbox.closed, sem chamar o ERP nem criar fatura', async () => {
    const { world, logs, order, sendsAfterCancel } = await cancelledDeadOrder();
    const rig = buildReconciler(world, { logger: logs.logger });

    const result = await rig.reconciler.reconcileOnce();

    expect(result).toEqual({ seen: 1, invoiced: 0, closed: 1 });
    expect(world.transport.sends).toHaveLength(sendsAfterCancel);
    expect(await invoices(order.orderId)).toBe(0);
    expect(await dlqTotal(world)).toBe(0);
    expect(
      logs.eventsOf('casecellshop.outbox.closed', order.orderId),
    ).toHaveLength(1);
    await expectCancelled(order);
    await expectReservationReleased(order);
  });

  it('ORD-15 depois de um redrive, o worker apaga a mensagem do pedido cancelado sem chamar o ERP e sem criar fatura', async () => {
    const { world, logs, order, sendsAfterCancel } = await cancelledDeadOrder();
    await redrive(world);
    await vi.waitFor(
      async () => expect(await world.queues.queue.approximateCount()).toBe(1),
      { timeout: WAIT_GUARD_MS, interval: 50 },
    );

    expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(
      1,
    );

    expect(world.transport.sends).toHaveLength(sendsAfterCancel);
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

    expect(await cancel(world, orderId)).toEqual({ kind: 'cancelled' });

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

// ---------------------------------------------------------------- ORD-26: cancelamento seguro (AD-031)

// Um pedido aceito pelo checkout cuja última chamada ao ERP começou há `lastCallAgoSeconds`, pelo relógio do banco,
// Com `createCalls`, também semeia as criações contadas (coluna da migração da verificação tardia); sem ele o teste
// não depende dela.
async function sentOrder(
  lastCallAgoSeconds: number,
  createCalls?: number,
): Promise<AcceptedOrder> {
  const order = await acceptOrder(suite, { quantity: 2 });
  if (createCalls === undefined) {
    await suite.pool.query(
      `update outbox
          set first_sent_at = now() - make_interval(secs => $2),
              last_call_at = now() - make_interval(secs => $2)
        where order_id = $1`,
      [order.orderId, lastCallAgoSeconds],
    );
  } else {
    await seedSentState(suite.pool, order.orderId, {
      createCalls,
      lastCallAgoSeconds,
    });
  }
  return order;
}

async function createCallsOf(order: AcceptedOrder): Promise<number> {
  return (await readLateColumns(suite.pool, order.orderId)).createCalls;
}

// O cancelamento com o relógio manual andando até o timeout do ERP, para a consulta que não responde (`hang`) também
// terminar: a chamada em voo não deixa o `advanceIdle` andar, então o salto é explícito, depois que a consulta saiu.
async function cancelAdvancing(
  world: QueueWorld,
  orderId: string,
): Promise<CancelOrderResult> {
  const run = cancel(world, orderId);
  await Promise.race([
    world.transport.waitForSends(1, 'findOrder'),
    run.then(() => undefined),
  ]);
  world.clock.advance(ERP_TIMEOUT_MS);
  return run;
}

function retryInMsOf(result: CancelOrderResult): number {
  return result.kind === 'too_recent' ? result.retryInMs : Number.NaN;
}

interface DoubtfulCreation {
  name: string;
  behavior: ErpSimBehavior;
  // Quanto o relógio ainda anda, depois do timeout do worker, para a fatura da criação em dúvida chegar ao ERP.
  landsAfterMs: number;
}

// Sem a H1b, uma criação cuja resposta se perdeu: a fatura sai no ERP, mas o worker não a viu.
const DOUBTFUL_CREATIONS: DoubtfulCreation[] = [
  {
    name: 'invoice_after acima da H4',
    behavior: { mode: 'invoice_after', delayMs: 60_000 },
    landsAfterMs: 50_000,
  },
  {
    name: 'invoice_no_response',
    behavior: { mode: 'invoice_no_response' },
    landsAfterMs: 0,
  },
];

// O worker manda a criação em dúvida e desiste dela no timeout: o pedido segue pending, e a última chamada ao ERP
// começou agora, pelo relógio do banco.
async function sendInDoubt(
  world: QueueWorld,
  order: AcceptedOrder,
  doubtful: DoubtfulCreation,
): Promise<void> {
  world.sim.script.enqueue(doubtful.behavior, {
    op: 'createOrder',
    reference: order.orderId,
  });
  const poll = startPoll(buildWorker(world));
  await poll.until(world.transport.waitForSends(1, 'createOrder'));
  world.clock.advance(ERP_TIMEOUT_MS);
  expect(await poll.result).toBe(1);
  expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
}

async function landInvoice(
  world: QueueWorld,
  doubtful: DoubtfulCreation,
): Promise<void> {
  world.clock.advance(doubtful.landsAfterMs);
  await settle();
  await world.sim.script.drain();
}

// Um ERP que, ao responder a consulta, deixa outra tentativa ficar com a permissão de chamada (grava outro token na
// linha) e só então devolve a resposta do simulado.
function erpLosingThePermit(
  inner: ErpClient,
  orderId: string,
  otherToken: string,
): ErpClient {
  return {
    ...inner,
    async findOrderByReference(reference) {
      const answer = await inner.findOrderByReference(reference);
      await suite.pool.query(
        'update outbox set call_token = $2 where order_id = $1',
        [orderId, otherToken],
      );
      return answer;
    },
  };
}

describe('ORD-26 cancelamento seguro pelo runbook', () => {
  it('ORD-26 com a última chamada ao ERP dentro da janela de assentamento, recusa com too_recent e o tempo que falta, e não muda o pedido, o estoque, a outbox nem chama o ERP', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await sentOrder(300, 1);
    const before = await footprintOf(order);
    const outboxBefore = stableOutbox(
      await readOutbox(suite.pool, order.orderId),
    );

    const result = await cancel(world, order.orderId);

    expect(result.kind).toBe('too_recent');
    // 15 min de janela menos os 5 min desde a última chamada, descontado o tempo do teste.
    expect(retryInMsOf(result)).toBeGreaterThan(580_000);
    expect(retryInMsOf(result)).toBeLessThanOrEqual(600_000);
    expect(await footprintOf(order)).toEqual(before);
    expect(stableOutbox(await readOutbox(suite.pool, order.orderId))).toEqual(
      outboxBefore,
    );
    expect(await createCallsOf(order)).toBe(1);
    expect(world.transport.sends).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
  });

  it('ORD-26 a janela de assentamento vale no lugar do atraso mínimo: 50 s depois da última chamada (passou dos 45 s) ainda recusa, faltando perto de 14 min', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await sentOrder(50);
    const before = await footprintOf(order);

    const result = await cancel(world, order.orderId);

    expect(result.kind).toBe('too_recent');
    expect(retryInMsOf(result)).toBeGreaterThan(
      (SETTLE_WINDOW_SECONDS - 50) * 1000 - 20_000,
    );
    expect(retryInMsOf(result)).toBeLessThanOrEqual(
      (SETTLE_WINDOW_SECONDS - 50) * 1000,
    );
    expect(await footprintOf(order)).toEqual(before);
    expect(world.transport.sends).toHaveLength(0);
  });

  it('ORD-26 o settleWindowMs das dependências muda a janela: 5 min depois da última chamada cancela com a janela de 2 min e recusa com a de 10 min', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const refused = await sentOrder(300);
    const allowed = await sentOrder(300);

    const refusal = await cancel(world, refused.orderId, 600_000);
    const cancelled = await cancel(world, allowed.orderId, 120_000);

    expect(refusal.kind).toBe('too_recent');
    expect(retryInMsOf(refusal)).toBeGreaterThan(280_000);
    expect(retryInMsOf(refusal)).toBeLessThanOrEqual(300_000);
    expect(cancelled).toEqual({ kind: 'cancelled' });
    expect((await readOrder(suite.pool, refused.orderId)).status).toBe(
      'pending',
    );
    await expectCancelled(allowed);
  });

  it('ORD-26 fora da janela e com o not_found do ERP, cancela como no ORD-15: consulta o ERP uma vez pela referência, não cria nada, toma a permissão e não soma create_calls', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await sentOrder(PAST_WINDOW_SECONDS, 1);
    const tokenBefore = (await readOutbox(suite.pool, order.orderId)).callToken;

    const result = await cancel(world, order.orderId);

    expect(result).toEqual({ kind: 'cancelled' });
    await expectCancelled(order);
    await expectReservationReleased(order);
    expect(world.transport.sends).toHaveLength(1);
    expect(
      world.transport
        .sendsOf('findOrder')
        .map((request) =>
          request.op === 'findOrder' ? request.reference : undefined,
        ),
    ).toEqual([order.orderId]);
    expect(await invoices(order.orderId)).toBe(0);
    expect(await createCallsOf(order)).toBe(1);
    const outbox = await readOutbox(suite.pool, order.orderId);
    expect(outbox.publishedAt).not.toBeNull();
    // A permissão foi tomada: a última chamada recomeça agora e o token é novo.
    expect(outbox.callToken).not.toBeNull();
    expect(outbox.callToken).not.toBe(tokenBefore);
    expect(outbox.sinceLastCallMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
      60_000,
    );
  });

  it('ORD-26 o pedido nunca enviado (sem última chamada) cancela depois do not_found, com uma consulta e nenhuma criação', async () => {
    const { world, order } = await freshOrder();
    expect((await readOutbox(suite.pool, order.orderId)).lastCallAt).toBeNull();

    const result = await cancel(world, order.orderId);

    expect(result).toEqual({ kind: 'cancelled' });
    await expectCancelled(order);
    await expectReservationReleased(order);
    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
  });

  it('ORD-26 cancelar duas vezes seguidas, sem a janela correr, devolve unchanged na segunda: o pedido já não está pending, então não toma a permissão nem consulta o ERP de novo', async () => {
    const { world, order } = await freshOrder();
    expect(await cancel(world, order.orderId)).toEqual({ kind: 'cancelled' });
    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);

    await expectUnchangedWithoutTouchingErp(world, order);

    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
    await expectCancelled(order);
  });

  // Um pedido que já não está pending não tem o que cancelar: a tomada da permissão regravaria last_call_at e
  // call_token e reiniciaria a janela da verificação tardia dele. Vale dentro da janela (onde a tomada daria
  // too_recent) e fora dela (onde a consulta ao ERP daria erp_has_order).
  const SETTLED_ORDERS: ReadonlyArray<{
    name: string;
    seed: (world: QueueWorld) => Promise<AcceptedOrder>;
  }> = [
    {
      name: 'faturado, com a última chamada dentro da janela',
      seed: async (world) => {
        const order = await submitOrder(suite, world, { quantity: 2 });
        expect(await buildWorker(world).pollOnce()).toBe(1);
        await expectInvoiced(world, order);
        return order;
      },
    },
    {
      name: 'falho, com a última chamada dentro da janela',
      seed: async () => {
        const order = await sentOrder(WITHIN_WINDOW_SECONDS, 1);
        await seedOutcome(suite.pool, order, {
          status: 'failed',
          reason: 'erp_rejected',
        });
        return order;
      },
    },
    {
      name: 'faturado hoje (o ERP tem a fatura), com a última chamada fora da janela',
      seed: async (world) => {
        const order = await sentOrder(PAST_WINDOW_SECONDS, 1);
        await erpHasInvoice(world, order);
        await seedOutcome(suite.pool, order, { status: 'invoiced' });
        return order;
      },
    },
    {
      name: 'falho, com a última chamada fora da janela e a fatura no ERP',
      seed: async (world) => {
        const order = await sentOrder(PAST_WINDOW_SECONDS, 1);
        await erpHasInvoice(world, order);
        await seedOutcome(suite.pool, order, {
          status: 'failed',
          reason: 'erp_out_of_stock',
        });
        return order;
      },
    },
  ];

  for (const { name, seed } of SETTLED_ORDERS) {
    it(`ORD-26 pedido ${name}: devolve unchanged na hora, sem consultar o ERP nem tomar a permissão (last_call_at, call_token, first_sent_at e published_at ficam como estavam)`, async () => {
      const world = await createWorld(suite, { withoutH1b: true });
      const order = await seed(world);
      const status = (await readOrder(suite.pool, order.orderId)).status;
      expect(status).not.toBe('pending');

      await expectUnchangedWithoutTouchingErp(world, order);

      expect((await readOrder(suite.pool, order.orderId)).status).toBe(status);
    });
  }

  it('ORD-26 enquanto o cancelamento consulta o ERP, outra tentativa de chamada não consegue a permissão (o mesmo UPDATE a segura)', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await sentOrder(PAST_WINDOW_SECONDS);
    let competing: Awaited<ReturnType<typeof takeCallPermit>> | undefined;
    world.transport.afterErp(
      { op: 'findOrder', reference: order.orderId },
      async () => {
        competing = await takeCallPermit(createDb(suite.pool), order.orderId, {
          minDelayMs: MIN_CALL_DELAY_MS,
          clearDead: false,
        });
      },
    );

    const result = await cancel(world, order.orderId);

    expect(competing, 'a outra tentativa rodou durante a consulta').toEqual(
      expect.objectContaining({ granted: false }),
    );
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('ORD-26 quando o ERP já tem o pedido, recusa com erp_has_order sem mudar o pedido nem o estoque, e não cria fatura', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await sentOrder(PAST_WINDOW_SECONDS);
    await erpHasInvoice(world, order);
    const before = await footprintOf(order);
    const sendsBefore = world.transport.sends.length;

    const result = await cancel(world, order.orderId);

    expect(result).toEqual({ kind: 'erp_has_order' });
    expect(await footprintOf(order)).toEqual(before);
    expect(world.transport.sends).toHaveLength(sendsBefore + 1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(1);
  });

  for (const failing of [
    { name: 'unavailable', behavior: { mode: 'unavailable' } },
    { name: 'status 503', behavior: { mode: 'status', status: 503 } },
    {
      name: 'status 401 (config_error)',
      behavior: { mode: 'status', status: 401 },
    },
    { name: 'hang até o timeout do ERP', behavior: { mode: 'hang' } },
  ] satisfies { name: string; behavior: ErpSimBehavior }[]) {
    it(`ORD-26 quando a consulta ao ERP falha (${failing.name}), recusa com erp_unavailable sem mudar o pedido nem o estoque`, async () => {
      const world = await createWorld(suite, { withoutH1b: true });
      const order = await sentOrder(PAST_WINDOW_SECONDS);
      const before = await footprintOf(order);
      world.sim.script.enqueue(failing.behavior, {
        op: 'findOrder',
        reference: order.orderId,
      });

      const result = await cancelAdvancing(world, order.orderId);

      expect(result).toEqual({ kind: 'erp_unavailable' });
      expect(await footprintOf(order)).toEqual(before);
      expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
      expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
      expect(await invoices(order.orderId)).toBe(0);
    });
  }

  it('ORD-26 se outra tentativa tomou a permissão entre a consulta e o cancelamento, recusa com permit_lost sem mudar o pedido nem o estoque e sem apagar o token dela', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await sentOrder(PAST_WINDOW_SECONDS);
    const before = await footprintOf(order);
    const otherToken = randomUUID();

    const result = await cancel(
      { erp: erpLosingThePermit(world.erp, order.orderId, otherToken) },
      order.orderId,
    );

    expect(result).toEqual({ kind: 'permit_lost' });
    expect(await footprintOf(order)).toEqual(before);
    expect((await readOutbox(suite.pool, order.orderId)).callToken).toBe(
      otherToken,
    );
    expect(await invoices(order.orderId)).toBe(0);
  });

  for (const doubtful of DOUBTFUL_CREATIONS) {
    it(`ORD-26 sem a H1b, criação em dúvida (${doubtful.name}) seguida de cancelamento dentro da janela é recusada com too_recent, mesmo com a fatura chegando ao ERP depois`, async () => {
      const world = await createWorld(suite, { withoutH1b: true });
      const order = await submitOrder(suite, world, { quantity: 2 });
      await sendInDoubt(world, order, doubtful);
      const before = await footprintOf(order);
      const sendsBefore = world.transport.sends.length;

      const result = await cancel(world, order.orderId);

      expect(result.kind).toBe('too_recent');
      expect(await footprintOf(order)).toEqual(before);
      expect(world.transport.sends).toHaveLength(sendsBefore);
      await landInvoice(world, doubtful);
      expect(await invoices(order.orderId)).toBe(1);
      expect((await readOrder(suite.pool, order.orderId)).status).toBe(
        'pending',
      );
    });

    it(`ORD-26 sem a H1b, criação em dúvida (${doubtful.name}) cuja fatura já está no ERP: depois da janela o cancelamento é recusado com erp_has_order`, async () => {
      const world = await createWorld(suite, { withoutH1b: true });
      const order = await submitOrder(suite, world, { quantity: 2 });
      await sendInDoubt(world, order, doubtful);
      await landInvoice(world, doubtful);
      expect(await invoices(order.orderId)).toBe(1);
      await ageLastCall(suite.pool, order.orderId, PAST_WINDOW_SECONDS);
      const before = await footprintOf(order);

      const result = await cancel(world, order.orderId);

      expect(result).toEqual({ kind: 'erp_has_order' });
      expect(await footprintOf(order)).toEqual(before);
      expect(await invoices(order.orderId)).toBe(1);
    });
  }

  it('ORD-26 logo antes de a janela fechar ainda recusa (14 min) e logo depois cancela (16 min)', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const inside = await sentOrder(WITHIN_WINDOW_SECONDS);
    const outside = await sentOrder(PAST_WINDOW_SECONDS);

    const refused = await cancel(world, inside.orderId);
    const accepted = await cancel(world, outside.orderId);

    expect(refused.kind).toBe('too_recent');
    expect(retryInMsOf(refused)).toBeGreaterThan(40_000);
    expect(retryInMsOf(refused)).toBeLessThanOrEqual(60_000);
    expect(accepted).toEqual({ kind: 'cancelled' });
  });
});

describe('ORD-26 mensagem do comando para cada resultado', () => {
  const ORDER_ID = '0b9f5a4e-7c1d-4c55-9a43-2f1d8c7e6a10';
  const CASES: {
    name: string;
    result: CancelOrderResult;
    failed: boolean;
  }[] = [
    { name: 'cancelled', result: { kind: 'cancelled' }, failed: false },
    { name: 'unchanged', result: { kind: 'unchanged' }, failed: false },
    {
      name: 'too_recent',
      result: { kind: 'too_recent', retryInMs: 600_000 },
      failed: true,
    },
    { name: 'erp_has_order', result: { kind: 'erp_has_order' }, failed: true },
    {
      name: 'erp_unavailable',
      result: { kind: 'erp_unavailable' },
      failed: true,
    },
    { name: 'permit_lost', result: { kind: 'permit_lost' }, failed: true },
  ];

  for (const { name, result, failed } of CASES) {
    it(`ORD-26 ${name}: uma linha com o orderId, e o comando ${failed ? 'sai com erro' : 'sai com sucesso'}`, () => {
      const described = describeCancel(ORDER_ID, result);

      expect(described.failed).toBe(failed);
      expect(described.message).toContain(ORDER_ID);
      expect(described.message.trim()).not.toBe('');
      expect(described.message.trim()).not.toContain('\n');
    });
  }

  it('ORD-26 too_recent diz quanto falta em minutos (600000 ms são 10 minutos)', () => {
    const { message } = describeCancel(ORDER_ID, {
      kind: 'too_recent',
      retryInMs: 600_000,
    });

    expect(message).toMatch(/\b10\b/);
    expect(message).toMatch(/min/i);
  });

  it('ORD-26 too_recent com retryInMs 0 diz 1 min, o piso: "0 min" levaria o operador a repetir de imediato', () => {
    const { message } = describeCancel(ORDER_ID, {
      kind: 'too_recent',
      retryInMs: 0,
    });

    expect(message).toContain('cerca de 1 min');
    expect(message).not.toMatch(/\b0 min/);
  });

  it('ORD-26 erp_has_order e erp_unavailable falam do ERP, e cada resultado tem uma mensagem própria', () => {
    const messages = CASES.map(
      ({ result }) => describeCancel(ORDER_ID, result).message,
    );

    expect(describeCancel(ORDER_ID, { kind: 'erp_has_order' }).message).toMatch(
      /ERP/,
    );
    expect(
      describeCancel(ORDER_ID, { kind: 'erp_unavailable' }).message,
    ).toMatch(/ERP/);
    expect(new Set(messages).size).toBe(CASES.length);
  });

  // Os minutos saem da janela de assentamento usada, não de um texto fixo.
  const WINDOW_RESULTS: ReadonlyArray<CancelOrderResult> = [
    { kind: 'erp_unavailable' },
    { kind: 'permit_lost' },
  ];
  const WINDOW_CASES: ReadonlyArray<{
    windowMs: number | undefined;
    minutes: number;
    why: string;
  }> = [
    {
      windowMs: undefined,
      minutes: SETTLE_WINDOW_MS / 60_000,
      why: 'o padrão é SETTLE_WINDOW_MS',
    },
    { windowMs: 120_000, minutes: 2, why: '120000 ms são 2 minutos' },
    { windowMs: 90_000, minutes: 2, why: '90000 ms arredondam para cima' },
    { windowMs: 30_000, minutes: 1, why: 'menos de 1 minuto vira 1 minuto' },
  ];

  for (const result of WINDOW_RESULTS) {
    for (const { windowMs, minutes, why } of WINDOW_CASES) {
      it(`ORD-26 ${result.kind} cita ${minutes} min da janela de assentamento (${why})`, () => {
        const { message } = describeCancel(ORDER_ID, result, windowMs);

        expect(message).toContain(`(${minutes} min)`);
      });
    }
  }
});
