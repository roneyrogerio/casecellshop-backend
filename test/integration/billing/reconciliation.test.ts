import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRedrive } from '../../../src/queue/sqs.ts';
import { resolveServiceIdentity } from '../../../src/shared/service-identity.ts';
import { createTelemetry, type Telemetry } from '../../../src/shared/telemetry.ts';
import { settle } from '../../helpers/async.ts';
import { readInventory } from '../../helpers/checkout.ts';
import {
  buildReconciler,
  countingSemaphore,
  driveClock,
  dlqTotal,
  moveToDlq,
  releaseFromDlq,
  type ReconcilerOptions,
  type ReconcilerRig,
} from '../../helpers/dlq.ts';
import { countInvoices } from '../../helpers/erp.ts';
import { captureLogs, type CapturedLogs } from '../../helpers/logs.ts';
import { scrapeMetrics, valueOf } from '../../helpers/metrics.ts';
import { countsOf } from '../../helpers/sqs.ts';
import {
  ageLastCall,
  buildWorker,
  createWorld,
  enqueueRaw,
  expectInvoiced,
  ledgerViolations,
  makeClaimable,
  markSentBefore,
  readOrder,
  readOutbox,
  startWorkerSuite,
  submitOrder,
  waitForDlq,
  createGate,
  type AcceptedOrder,
  type Gate,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Reconciliação periódica da DLQ do SQS (ORD-14, OBS-01 e OBS-02 do M3; design.md, "Worker: reconciliação e
// runbook"). As mensagens chegam à DLQ pelo limite de recebimentos do ElasticMQ, o ERP é o simulado e a
// reconciliação conta fatura no erp_sim, nunca chamada.

let suite: WorkerSuite;
const telemetries: Telemetry[] = [];

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await suite?.stop();
});

beforeEach(async () => {
  await suite.checkout.telemetry.forceFlush();
  suite.checkout.exporter.reset();
});

afterEach(async () => {
  suite.releaseWorlds();
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

interface Rig extends ReconcilerRig {
  world: QueueWorld;
  telemetry: Telemetry;
  logs: CapturedLogs;
  maxReceiveCount: number;
}

interface RigOptions extends Pick<ReconcilerOptions, 'config' | 'semaphore'> {
  maxReceiveCount?: number;
  // Telemetria do checkout, para ler os spans junto dos do checkout; sem ela, uma só do cenário.
  shared?: boolean;
}

// Sem a H1b, para o caso difícil: uma criação a mais seria uma segunda fatura. Limite de recebimentos
// pequeno, para a mensagem chegar logo à DLQ.
async function createRig(options: RigOptions = {}): Promise<Rig> {
  let telemetry = suite.checkout.telemetry;
  if (!options.shared) {
    telemetry = createTelemetry({ spanExporter: new InMemorySpanExporter() });
    telemetries.push(telemetry);
  }
  const maxReceiveCount = options.maxReceiveCount ?? 1;
  const world = await createWorld(suite, { withoutH1b: true, maxReceiveCount, telemetry });
  const logs = captureLogs();
  const built = buildReconciler(world, {
    logger: logs.logger,
    telemetry,
    ...(options.config ? { config: options.config } : {}),
    ...(options.semaphore ? { semaphore: options.semaphore } : {}),
  });
  return { ...built, world, telemetry, logs, maxReceiveCount };
}

// O ERP já faturou o pedido numa chamada cuja resposta se perdeu.
async function erpHasInvoice(world: QueueWorld, order: AcceptedOrder): Promise<void> {
  const created = await world.erp.createOrder({
    reference: order.orderId,
    items: [{ sku: order.sku, quantity: order.quantity, unitPriceCents: order.priceCents }],
  });
  expect(created.kind).toBe('ok');
}

interface DeadSpec {
  erpHas?: boolean;
  quantity?: number;
}

// Pedidos aceitos, com a mensagem na DLQ: `first_sent_at` e `last_call_at` de 5 min atrás (o atraso mínimo
// já passou) e, para os que o ERP "já tem", a fatura criada antes. Corpos crus entram na mesma fila.
async function seedDead(rig: Rig, specs: DeadSpec[], rawBodies: string[] = []): Promise<AcceptedOrder[]> {
  const orders: AcceptedOrder[] = [];
  for (const spec of specs) {
    const order = await submitOrder(suite, rig.world, { quantity: spec.quantity ?? 2 });
    if (spec.erpHas) await erpHasInvoice(rig.world, order);
    await markSentBefore(suite.pool, order.orderId);
    orders.push(order);
  }
  for (const body of rawBodies) await enqueueRaw(rig.world, body);
  await moveToDlq(rig.world, orders.length + rawBodies.length, rig.maxReceiveCount);
  return orders;
}

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
}

async function expectReservationKept(order: AcceptedOrder): Promise<void> {
  const inventory = await readInventory(suite.pool, order.sku);
  expect(ledgerViolations(inventory, { onHand: order.onHand, reserved: order.quantity, soldTotal: 0 })).toEqual([]);
}

async function expectStillPending(rig: Rig, order: AcceptedOrder): Promise<void> {
  expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
  await expectReservationKept(order);
  expect(rig.dlq.deletesOf(order.orderId)).toEqual([]);
}

async function outcomeCount(rig: Rig, outcome: string): Promise<number> {
  return valueOf(await scrapeMetrics(rig.telemetry), 'outbox_attempt_outcome_total', { outcome }) ?? 0;
}

describe('ORD-14 ERP fora por mais que a janela de retry', () => {
  it('ORD-14 os pedidos ficam na DLQ com a reserva; quando o ERP volta, a reconciliação fatura os que ele já tem, apaga a mensagem deles e deixa na DLQ os que ele não tem', async () => {
    const rig = await createRig({ maxReceiveCount: 2 });
    const { world } = rig;
    const has = await submitOrder(suite, world, { quantity: 2 });
    const lacks = await submitOrder(suite, world, { quantity: 3 });
    // A fatura do primeiro saiu antes da queda (a resposta se perdeu); depois, o ERP some.
    await erpHasInvoice(world, has);
    world.sim.script.setDefault({ mode: 'unavailable' });
    const worker = buildWorker(world);

    // Os dois recebimentos do limite falham; o seguinte leva as mensagens à DLQ sem o worker vê-las.
    for (let receive = 1; receive <= 2; receive += 1) {
      expect(await worker.pollOnce(), `recebimento ${receive}`).toBe(2);
      await makeClaimable(world, has.orderId);
      await makeClaimable(world, lacks.orderId);
    }
    expect(await worker.pollOnce()).toBe(0);
    await waitForDlq(world, 2);
    for (const order of [has, lacks]) {
      expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
      await expectReservationKept(order);
    }
    expect(await invoices(has.orderId)).toBe(1);
    expect(await invoices(lacks.orderId)).toBe(0);

    // O ERP volta, e o atraso mínimo da última chamada já passou.
    world.sim.script.setDefault({ mode: 'normal' });
    await ageLastCall(suite.pool, has.orderId);
    await ageLastCall(suite.pool, lacks.orderId);
    const createsBefore = world.transport.sendsOf('createOrder').length;

    const result = await rig.reconciler.reconcileOnce();

    expect(result).toEqual({ seen: 2, invoiced: 1, closed: 0 });
    // O que o ERP tem vira faturado, uma fatura só, com o estoque baixado uma vez, e sai da DLQ.
    expect(await invoices(has.orderId)).toBe(1);
    await expectInvoiced(world, has, { queueEmpty: false });
    expect(rig.dlq.deletesOf(has.orderId).map((call) => call.result)).toEqual(['ok']);
    // O que ele não tem fica como estava: pedido pending, reserva, nenhuma fatura e a mensagem na DLQ.
    expect(await invoices(lacks.orderId)).toBe(0);
    await expectStillPending(rig, lacks);
    expect(await dlqTotal(world)).toBe(1);
    // A reconciliação só consulta: quem cria é o worker.
    expect(world.transport.sendsOf('createOrder')).toHaveLength(createsBefore);
    expect(world.transport.sendsOf('findOrder').some((request) => request.op === 'findOrder' && request.reference === lacks.orderId)).toBe(true);
  });

  it('ORD-14 com o ERP ainda fora, a consulta falha: a mensagem fica na DLQ com o pedido pending e a reserva; na rodada seguinte, com o ERP de volta, o pedido é faturado', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{ erpHas: true }]);
    if (!order) throw new Error('pedido não semeado');
    world.sim.script.setDefault({ mode: 'unavailable' });

    const first = await rig.reconciler.reconcileOnce();

    expect(first).toEqual({ seen: 1, invoiced: 0, closed: 0 });
    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectStillPending(rig, order);
    expect(await dlqTotal(world)).toBe(1);

    // O ERP volta e a mensagem fica visível de novo; a permissão da rodada anterior precisa vencer o atraso mínimo.
    world.sim.script.setDefault({ mode: 'normal' });
    await releaseFromDlq(world, rig.dlq, order.orderId);
    await ageLastCall(suite.pool, order.orderId);

    expect(await rig.reconciler.reconcileOnce()).toEqual({ seen: 1, invoiced: 1, closed: 0 });
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order, { queueEmpty: false });
    expect(await dlqTotal(world)).toBe(0);
  });

  it('ORD-14 sem a permissão de chamada (outra chamada há menos que o atraso mínimo), a reconciliação não consulta o ERP e a mensagem fica na DLQ', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{ erpHas: true }]);
    if (!order) throw new Error('pedido não semeado');
    await ageLastCall(suite.pool, order.orderId, 10);
    const sendsBefore = world.transport.sends.length;
    const callBefore = await readOutbox(suite.pool, order.orderId);

    const result = await rig.reconciler.reconcileOnce();

    expect(result).toEqual({ seen: 1, invoiced: 0, closed: 0 });
    expect(world.transport.sends).toHaveLength(sendsBefore);
    await expectStillPending(rig, order);
    expect(await dlqTotal(world)).toBe(1);
    // A permissão negada não regrava o início da última chamada.
    const callAfter = await readOutbox(suite.pool, order.orderId);
    expect(callAfter.callToken).toBe(callBefore.callToken);
  });

  it('ORD-14 o faturamento pela reconciliação toma a permissão de chamada sem zerar o dead_at, usa uma permissão do semáforo, loga order.invoiced e soma invoiced e o aceite ao faturamento', async () => {
    const semaphore = countingSemaphore(30);
    const rig = await createRig({ semaphore });
    const { world } = rig;
    const [order] = await seedDead(rig, [{ erpHas: true }]);
    if (!order) throw new Error('pedido não semeado');
    let heldDuringCall: number | undefined;
    world.transport.afterErp({ op: 'findOrder', reference: order.orderId }, () => {
      heldDuringCall = semaphore.held;
      return Promise.resolve();
    });

    await rig.reconciler.reconcileOnce();

    expect(heldDuringCall, 'uma só permissão do semáforo durante a consulta').toBe(1);
    expect(semaphore.held, 'a permissão volta ao semáforo').toBe(0);
    const outbox = await readOutbox(suite.pool, order.orderId);
    expect(outbox.callToken, 'a permissão de chamada foi tomada').not.toBeNull();
    expect(outbox.sinceLastCallMs ?? Infinity).toBeLessThan(30_000);
    expect(outbox.deadAt, 'a permissão da reconciliação não zera o dead_at').not.toBeNull();
    const invoiced = rig.logs.eventsOf('order.invoiced', order.orderId);
    expect(invoiced).toHaveLength(1);
    expect(invoiced[0]?.['level']).toBe('info');
    expect(await outcomeCount(rig, 'invoiced')).toBe(1);
    const families = await scrapeMetrics(rig.telemetry);
    expect(valueOf(families, 'order_accept_to_invoice_seconds', {}, 'order_accept_to_invoice_seconds_count')).toBe(1);
    await expectInvoiced(world, order, { queueEmpty: false });
  });

  it('ORD-14 a mensagem de um pedido que já não está pending é apagada da DLQ com outbox.closed, sem consultar o ERP', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{}]);
    if (!order) throw new Error('pedido não semeado');
    await suite.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);
    const sendsBefore = world.transport.sends.length;

    const result = await rig.reconciler.reconcileOnce();

    expect(result).toEqual({ seen: 1, invoiced: 0, closed: 1 });
    expect(world.transport.sends).toHaveLength(sendsBefore);
    expect(rig.dlq.deletesOf(order.orderId).map((call) => call.result)).toEqual(['ok']);
    expect(await dlqTotal(world)).toBe(0);
    const closed = rig.logs.eventsOf('outbox.closed', order.orderId);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.['level']).toBe('info');
    expect(await outcomeCount(rig, 'closed')).toBe(1);
    expect(await invoices(order.orderId)).toBe(0);
  });

  it('ORD-14 o corpo fora do schema fica na DLQ para o runbook, sem ser apagado nem consultado, e não impede as outras mensagens da rodada', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{ erpHas: true }], ['isto nao e json']);
    if (!order) throw new Error('pedido não semeado');

    const result = await rig.reconciler.reconcileOnce();

    expect(result.invoiced).toBe(1);
    await expectInvoiced(world, order, { queueEmpty: false });
    // Só a mensagem inválida segue na DLQ, e nenhuma resposta ao SQS foi dada a ela.
    expect(await dlqTotal(world)).toBe(1);
    expect(rig.dlq.deletes).toHaveLength(1);
    expect(await outcomeCount(rig, 'dead')).toBe(1);
  });

  it('ORD-14 recebe da DLQ até maxMessages em lotes de no máximo 10, com a visibilidade configurada, e deixa o resto para a rodada seguinte', async () => {
    const rig = await createRig({ config: { maxMessages: 12 } });
    const { world } = rig;
    await seedDead(rig, Array.from({ length: 15 }, () => ({ quantity: 1 })));

    const first = await rig.reconciler.reconcileOnce();

    expect(first.seen).toBe(12);
    expect(rig.dlq.received).toHaveLength(12);
    for (const options of rig.dlq.receives) {
      expect(options.max).toBeLessThanOrEqual(10);
      // 5 min: a mensagem não é vista duas vezes na rodada, e a seguinte lê outras.
      expect(options.visibilitySeconds).toBe(300);
    }
    // Nenhuma das 12 voltou: as 3 que sobraram são as visíveis.
    expect(await countsOf(world.emq, world.queues.dlqUrl)).toEqual({ visible: 3, notVisible: 12 });

    const second = await rig.reconciler.reconcileOnce();

    expect(second.seen).toBe(3);
    expect(await outcomeCount(rig, 'dead')).toBe(15);
  });

  it('ORD-14 a rodada padrão pede até 100 mensagens, em lotes de 10, escondidas por 5 min', async () => {
    const rig = await createRig();
    await seedDead(rig, [{}]);

    await rig.reconciler.reconcileOnce();

    expect(rig.dlq.receives.length).toBeGreaterThanOrEqual(1);
    expect(rig.dlq.receives[0]).toMatchObject({ max: 10, visibilitySeconds: 300 });
    expect(rig.dlq.receives.every((options) => options.max <= 10)).toBe(true);
  });
});

describe('ORD-14 o laço da reconciliação', () => {
  it('ORD-14 start() reconcilia a cada intervalMs no relógio injetável e loga outbox.reconciled com seen, invoiced e closed; stop() termina o laço', async () => {
    const rig = await createRig({ config: { intervalMs: 1_000 } });
    const { world } = rig;
    const [order] = await seedDead(rig, [{ erpHas: true }]);
    if (!order) throw new Error('pedido não semeado');

    void rig.reconciler.start();
    try {
      await vi.waitFor(
        async () => {
          world.clock.advance(1_000);
          expect((await readOrder(suite.pool, order.orderId)).status).toBe('invoiced');
          const summaries = rig.logs.eventsOf('outbox.reconciled').filter((line) => line['invoiced'] === 1);
          expect(summaries).toHaveLength(1);
          expect(summaries[0]).toMatchObject({ level: 'info', seen: 1, invoiced: 1, closed: 0 });
        },
        { timeout: 20_000, interval: 25 },
      );
    } finally {
      await driveClock(rig.reconciler.stop(), world.clock);
    }

    expect(rig.sleeps).toContain(1_000);
    await expectInvoiced(world, order, { queueEmpty: false });
  });

  it('ORD-14 o intervalo padrão entre as rodadas é de 5 min no relógio injetável', async () => {
    const rig = await createRig();
    const { world } = rig;

    void rig.reconciler.start();
    try {
      await vi.waitFor(() => expect(rig.sleeps.length).toBeGreaterThanOrEqual(1), { timeout: 20_000, interval: 25 });
    } finally {
      await driveClock(rig.reconciler.stop(), world.clock, 60_000);
    }

    expect(rig.sleeps).toContain(300_000);
  });

  it('ORD-14 uma rodada que falha loga outbox.reconcile_error (warn) e o laço continua: a rodada seguinte fatura o pedido', async () => {
    const rig = await createRig({ config: { intervalMs: 1_000 } });
    const { world } = rig;
    const [order] = await seedDead(rig, [{ erpHas: true }]);
    if (!order) throw new Error('pedido não semeado');
    const injection = rig.dlq.inject('receive');

    void rig.reconciler.start();
    try {
      await vi.waitFor(
        async () => {
          world.clock.advance(1_000);
          expect((await readOrder(suite.pool, order.orderId)).status).toBe('invoiced');
        },
        { timeout: 20_000, interval: 25 },
      );
    } finally {
      await driveClock(rig.reconciler.stop(), world.clock);
    }

    expect(injection.fired, 'a falha do SQS foi injetada').toBe(1);
    const errors = rig.logs.eventsOf('outbox.reconcile_error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.['level']).toBe('warn');
    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-14 depois do stop() resolver, o relógio avançar não dispara nenhuma rodada nova', async () => {
    const rig = await createRig({ config: { intervalMs: 1_000 } });
    const { world } = rig;
    await seedDead(rig, [{}]);

    void rig.reconciler.start();
    await vi.waitFor(
      () => {
        world.clock.advance(1_000);
        expect(rig.dlq.receives.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 20_000, interval: 25 },
    );
    await driveClock(rig.reconciler.stop(), world.clock);
    const receivesAtStop = rig.dlq.receives.length;

    for (let tick = 0; tick < 5; tick += 1) {
      world.clock.advance(1_000);
      await settle();
    }

    expect(rig.dlq.receives).toHaveLength(receivesAtStop);
  });
});

interface InterruptedRound {
  inFlight: AcceptedOrder;
  untouched: AcceptedOrder[];
}

// Prende, na fronteira do transporte, só a primeira resposta de consulta ao ERP; as seguintes passam.
function holdFirstFindOrder(world: QueueWorld): Gate {
  const gate = createGate();
  let held = false;
  world.transport.afterErp(
    { op: 'findOrder' },
    async () => {
      if (held) return;
      held = true;
      await gate.park();
    },
    1_000,
  );
  return gate;
}

// Várias mensagens na DLQ, todas de pedidos que o ERP já tem; o stop() chega com a primeira consulta em voo.
// Devolve o pedido da consulta em voo e os que a rodada não deveria ter tocado.
async function stopWhileQueryInFlight(rig: Rig, messages: number): Promise<InterruptedRound> {
  const { world } = rig;
  const orders = await seedDead(
    rig,
    Array.from({ length: messages }, () => ({ erpHas: true, quantity: 1 })),
  );
  const gate = holdFirstFindOrder(world);
  let stopped = false;
  let stopping: Promise<void> | undefined;

  void rig.reconciler.start();
  try {
    await gate.waitForParked(1);
    stopping = rig.reconciler.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped, 'o stop() espera a consulta que já estava em voo').toBe(false);
  } finally {
    gate.releaseAll();
  }
  await stopping;

  const first = world.transport.sendsOf('findOrder')[0];
  const inFlightId = first?.op === 'findOrder' ? first.reference : undefined;
  const inFlight = orders.find((order) => order.orderId === inFlightId);
  if (!inFlight) throw new Error('a consulta em voo não é de um pedido semeado');
  return { inFlight, untouched: orders.filter((order) => order.orderId !== inFlight.orderId) };
}

describe('ORD-14 o stop() no meio de uma rodada', () => {
  it('ORD-14 o stop() espera só a consulta ao ERP em voo: nenhuma consulta nova sai depois dele, e as mensagens que sobram seguem na DLQ com o pedido pending e a reserva', async () => {
    const rig = await createRig();
    const { world } = rig;

    const { inFlight, untouched } = await stopWhileQueryInFlight(rig, 3);

    // A consulta em voo termina o que começou: o pedido é faturado e a mensagem, apagada.
    expect(world.transport.sendsOf('findOrder'), 'consultas ao ERP').toHaveLength(1);
    await expectInvoiced(world, inFlight, { queueEmpty: false });
    expect(rig.dlq.deletesOf(inFlight.orderId).map((call) => call.result)).toEqual(['ok']);
    // As outras ficam como estavam; a visibilidade de 5 min as devolve à DLQ para a rodada seguinte.
    for (const order of untouched) {
      expect(await invoices(order.orderId)).toBe(1);
      await expectStillPending(rig, order);
    }
    expect(await dlqTotal(world)).toBe(untouched.length);
  });

  it('ORD-14 o stop() também interrompe a rodada entre lotes: a DLQ não é lida de novo depois dele', async () => {
    const rig = await createRig();
    const { world } = rig;

    const { untouched } = await stopWhileQueryInFlight(rig, 11);

    // O primeiro lote tem 10 mensagens; a 11ª fica visível, sem ninguém a receber depois do stop().
    expect(rig.dlq.receives, 'leituras da DLQ').toHaveLength(1);
    expect(world.transport.sendsOf('findOrder'), 'consultas ao ERP').toHaveLength(1);
    expect(await countsOf(world.emq, world.queues.dlqUrl)).toEqual({ visible: 1, notVisible: untouched.length - 1 });
  });
});

describe('OBS-01 outbox.dead, uma vez por chegada da mensagem à DLQ', () => {
  it('OBS-01 outbox.dead sai em error, com orderId, correlationId e os campos obrigatórios, dentro do span outbox.settle; o dead_at fica gravado', async () => {
    const rig = await createRig({ shared: true });
    const [order] = await seedDead(rig, [{}]);
    if (!order) throw new Error('pedido não semeado');
    expect((await readOutbox(suite.pool, order.orderId)).deadAt).toBeNull();

    await rig.reconciler.reconcileOnce();
    await rig.telemetry.forceFlush();

    const dead = rig.logs.eventsOf('outbox.dead', order.orderId);
    expect(dead).toHaveLength(1);
    const line = dead[0] ?? {};
    for (const field of ['time', 'level', 'service', 'msg', 'event', 'correlationId', 'trace_id', 'span_id']) {
      expect(line[field], `falta ${field}`).toBeDefined();
    }
    expect(line['level']).toBe('error');
    expect(line['service']).toBe(resolveServiceIdentity('casecellshop-worker').service);
    expect(line['orderId']).toBe(order.orderId);
    expect(line['correlationId']).toBe(order.requestId);
    expect(line['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(line['span_id']).toMatch(/^[0-9a-f]{16}$/);
    expect((await readOutbox(suite.pool, order.orderId)).deadAt).not.toBeNull();
    const settleSpans = suite.checkout.exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'outbox.settle' && span.attributes['orderId'] === order.orderId);
    expect(settleSpans.map((span) => span.spanContext().spanId)).toContain(line['span_id']);
  });

  it('OBS-01 a mensagem que aparece outra vez na DLQ, sem o worker tomar a permissão, não loga outbox.dead de novo; a nova chegada depois de um redrive e de nova tentativa loga', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{}]);
    if (!order) throw new Error('pedido não semeado');
    const id = order.orderId;

    await rig.reconciler.reconcileOnce();
    await releaseFromDlq(world, rig.dlq, id);
    await ageLastCall(suite.pool, id);
    const again = await rig.reconciler.reconcileOnce();

    expect(again.seen, 'a mesma mensagem foi vista na segunda rodada').toBe(1);
    expect(rig.logs.eventsOf('outbox.dead', id)).toHaveLength(1);

    // Redrive; o worker toma a permissão (o que zera o dead_at) e o ERP segue fora, até a DLQ de novo.
    await releaseFromDlq(world, rig.dlq, id);
    await startRedrive(world.queues.client, world.queues.dlqUrl);
    await vi.waitFor(async () => expect(await world.queues.queue.approximateCount()).toBe(1), { timeout: 20_000, interval: 50 });
    world.sim.script.setDefault({ mode: 'unavailable' });
    await ageLastCall(suite.pool, id);
    const worker = buildWorker(world);
    expect(await worker.pollOnce()).toBe(1);
    expect((await readOutbox(suite.pool, id)).deadAt, 'a permissão do worker zera o dead_at').toBeNull();
    await makeClaimable(world, id);
    expect(await worker.pollOnce()).toBe(0);
    await waitForDlq(world, 1);
    await ageLastCall(suite.pool, id);

    await rig.reconciler.reconcileOnce();

    expect(rig.logs.eventsOf('outbox.dead', id)).toHaveLength(2);
    expect((await readOutbox(suite.pool, id)).deadAt).not.toBeNull();
  });
});

describe('OBS-01 outbox.reconcile_error de uma mensagem da rodada', () => {
  it('OBS-01 a falha numa mensagem loga outbox.reconcile_error (warn) com os campos obrigatórios, o orderId e o correlationId da mensagem, e a rodada segue com as outras', async () => {
    const rig = await createRig();
    const { world } = rig;
    const orders = await seedDead(rig, [{}, {}]);
    // Os dois já têm desfecho: cada mensagem só precisa do DeleteMessage, e a falha injetada cai em uma.
    for (const order of orders) {
      await suite.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);
    }
    const injection = rig.dlq.inject('delete');

    const result = await rig.reconciler.reconcileOnce();

    expect(injection.fired, 'a falha do SQS foi injetada').toBe(1);
    expect(result, 'a rodada segue com a outra mensagem').toEqual({ seen: 2, invoiced: 0, closed: 1 });
    const rejected = rig.dlq.deletes.filter((call) => call.result === 'rejected');
    expect(rejected).toHaveLength(1);
    const failedId = rig.dlq.orderIdOf(rejected[0]?.receiptHandle ?? '');
    const failed = orders.find((order) => order.orderId === failedId);
    const other = orders.find((order) => order.orderId !== failedId);
    if (!failed || !other) throw new Error('a mensagem que falhou não é de um pedido semeado');
    expect(rig.dlq.deletesOf(other.orderId).map((call) => call.result)).toEqual(['ok']);
    expect(await dlqTotal(world)).toBe(1);

    const errors = rig.logs.eventsOf('outbox.reconcile_error');
    expect(errors).toHaveLength(1);
    const line = errors[0] ?? {};
    expect(line['level']).toBe('warn');
    expect(line['orderId']).toBe(failed.orderId);
    expect(line['correlationId']).toBe(failed.requestId);
    for (const field of ['time', 'level', 'service', 'msg', 'event', 'correlationId', 'trace_id', 'span_id']) {
      expect(line[field], `falta ${field}`).toBeDefined();
    }
    expect(line['service']).toBe(resolveServiceIdentity('casecellshop-worker').service);
    expect(line['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(line['span_id']).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('OBS-02 dead em outbox_attempt_outcome_total', () => {
  it('OBS-02 dead soma 1 na primeira vez que a reconciliação vê a mensagem, e uma segunda rodada sobre a mesma mensagem não soma de novo', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{}, {}]);
    if (!order) throw new Error('pedido não semeado');

    await rig.reconciler.reconcileOnce();

    expect(await outcomeCount(rig, 'dead')).toBe(2);
    await releaseFromDlq(world, rig.dlq, order.orderId);
    await rig.reconciler.reconcileOnce();
    expect(await outcomeCount(rig, 'dead')).toBe(2);
    // O dead é a chegada à DLQ: a consulta que não achou o pedido não soma retry nem outro desfecho.
    expect(await outcomeCount(rig, 'invoiced')).toBe(0);
    expect(await outcomeCount(rig, 'retry')).toBe(0);
  });

  it('OBS-02 depois de um redrive e de a permissão do worker zerar o dead_at, a nova chegada à DLQ soma dead de novo', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{}]);
    if (!order) throw new Error('pedido não semeado');
    const id = order.orderId;
    await rig.reconciler.reconcileOnce();
    expect(await outcomeCount(rig, 'dead')).toBe(1);

    await releaseFromDlq(world, rig.dlq, id);
    await startRedrive(world.queues.client, world.queues.dlqUrl);
    await vi.waitFor(async () => expect(await world.queues.queue.approximateCount()).toBe(1), { timeout: 20_000, interval: 50 });
    world.sim.script.setDefault({ mode: 'unavailable' });
    await ageLastCall(suite.pool, id);
    const worker = buildWorker(world);
    expect(await worker.pollOnce()).toBe(1);
    await makeClaimable(world, id);
    expect(await worker.pollOnce()).toBe(0);
    await waitForDlq(world, 1);
    await ageLastCall(suite.pool, id);

    await rig.reconciler.reconcileOnce();

    expect(await outcomeCount(rig, 'dead')).toBe(2);
  });

  it('OBS-02 closed da reconciliação só soma quando o DeleteMessage da DLQ sai ok', async () => {
    const rig = await createRig();
    const { world } = rig;
    const [order] = await seedDead(rig, [{}]);
    if (!order) throw new Error('pedido não semeado');
    await suite.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);
    const injection = rig.dlq.inject('delete');

    // O SQS falha ao apagar: a mensagem fica, e a rodada não conta o encerramento que não aconteceu. O spec não
    // diz se a rodada rejeita ou só loga; o teste aceita os dois.
    await rig.reconciler.reconcileOnce().catch(() => undefined);

    expect(injection.fired, 'a falha do SQS foi injetada').toBe(1);
    expect(await outcomeCount(rig, 'closed')).toBe(0);
    expect(await dlqTotal(world)).toBe(1);
  });
});
