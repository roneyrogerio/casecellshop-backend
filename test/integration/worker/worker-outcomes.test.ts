import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readInventory } from '../../helpers/checkout.ts';
import { expectMatchesContract, findRoute } from '../../helpers/contract.ts';
import { countInvoices, invoiceTotals, MIN_RETRY_DELAY_MS } from '../../helpers/erp.ts';
import {
  acceptOrder,
  buildWorker,
  cancelLeftoverMessages,
  createErpWorld,
  expectInvoiced,
  ledgerViolations,
  makeClaimable,
  markSentBefore,
  readOrder,
  readOutbox,
  retryDelayMs,
  startWorkerSuite,
  type AcceptedOrder,
  type ErpWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';
import type { WorkerConfig } from '../../../src/worker.ts';

// Desfechos do envio (ORD-08 a ORD-11) e o status do pedido depois do worker (ORD-19).

let suite: WorkerSuite;
const statusRoute = findRoute('get', '/orders/{orderId}/status');

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 120_000);

afterAll(async () => {
  await suite?.stop();
});

afterEach(async () => {
  await cancelLeftoverMessages(suite.pool);
});

function newWorker(world: ErpWorld, config?: Partial<WorkerConfig>) {
  return buildWorker(world, { pool: suite.pool, telemetry: suite.telemetry, ...(config ? { config } : {}) });
}

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
}

async function getStatus(orderId: string): Promise<unknown> {
  const res = await request(suite.checkout.app).get(`/orders/${orderId}/status`);
  expect(res.status).toBe(200);
  expectMatchesContract(statusRoute, res);
  return res.body;
}

// Quanto o pedido pode ter mudado no estoque quando nada foi faturado: a reserva segue ou volta.
async function expectNothingSold(order: AcceptedOrder, reserved: number): Promise<void> {
  const inventory = await readInventory(suite.pool, order.sku);
  expect(ledgerViolations(inventory, { onHand: order.onHand, reserved, soldTotal: 0 })).toEqual([]);
}

describe('ORD-08 rejeição permanente libera a reserva', () => {
  it.each([
    ['rejeição do ERP', 'erp_rejected'],
    ['falta de estoque no ERP (H2)', 'erp_out_of_stock'],
  ] as const)('ORD-08 %s: pedido failed com o motivo %s, reserva liberada, mensagem encerrada e nenhuma fatura', async (label, reason) => {
    // A falta de estoque vem do estado do erp_sim, não do roteiro: o ERP tem 0 e a loja reservou 2.
    const order = await acceptOrder(suite, { quantity: 2, onHand: 10, ...(reason === 'erp_out_of_stock' ? { erpOnHand: 0 } : {}) });
    const world = createErpWorld(suite.database.erpPool);
    if (reason === 'erp_rejected') world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: order.orderId });
    expect(await readInventory(suite.pool, order.sku), `${label}: a reserva nasce no checkout`).toMatchObject({ reserved: 2 });

    expect(await newWorker(world).pollOnce()).toBe(1);

    const row = await readOrder(suite.pool, order.orderId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe(reason);
    expect(row.outcomeAt).not.toBeNull();
    // A mensagem é encerrada: nem pendente (nova tentativa) nem na DLQ.
    expect(['done', 'cancelled']).toContain((await readOutbox(suite.pool, order.orderId)).status);
    await expectNothingSold(order, 0);
    expect(await invoices(order.orderId)).toBe(0);
  });
});

describe('ORD-09 404 na consulta', () => {
  it('ORD-09 o 404 com o corpo de pedido inexistente leva à criação: uma fatura e o pedido invoiced', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool);
    await markSentBefore(suite.pool, order.orderId);

    expect(await newWorker(world).pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });

  it.each([
    ['sem corpo', undefined],
    ['com outro corpo', { code: 'route_not_found' }],
  ])('ORD-09 o 404 %s é erro de configuração: não cria, o pedido segue pending para nova tentativa', async (_label, body) => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.enqueue({ mode: 'status', status: 404, ...(body === undefined ? {} : { body }) }, { op: 'findOrder', reference: order.orderId });
    await markSentBefore(suite.pool, order.orderId);

    expect(await newWorker(world).pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(0);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    const outbox = await readOutbox(suite.pool, order.orderId);
    expect(outbox.status).toBe('pending');
    expect(outbox.scheduledInFuture).toBe(true);
    await expectNothingSold(order, order.quantity);
  });
});

describe('ORD-10 400 e 401 do ERP não falham o pedido', () => {
  it.each([400, 401])('ORD-10 o %i na criação é transitório: pedido pending, nova tentativa agendada e reserva mantida', async (status) => {
    const order = await acceptOrder(suite, { quantity: 2 });
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.enqueue({ mode: 'status', status }, { op: 'createOrder', reference: order.orderId });

    expect(await newWorker(world).pollOnce()).toBe(1);

    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    const outbox = await readOutbox(suite.pool, order.orderId);
    expect(outbox.status).toBe('pending');
    expect(outbox.attempts).toBe(1);
    expect(outbox.scheduledInFuture).toBe(true);
    // A nova tentativa respeita o atraso mínimo contado do início da chamada.
    expect(await retryDelayMs(suite.pool, order.orderId)).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS - 1_000);
    await expectNothingSold(order, 2);
    expect(await invoices(order.orderId)).toBe(0);
  });

  it('ORD-10 o 401 na consulta também é transitório: não cria, pedido pending e reserva mantida', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.enqueue({ mode: 'status', status: 401 }, { op: 'findOrder', reference: order.orderId });
    await markSentBefore(suite.pool, order.orderId);

    expect(await newWorker(world).pollOnce()).toBe(1);

    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect((await readOutbox(suite.pool, order.orderId)).scheduledInFuture).toBe(true);
    await expectNothingSold(order, order.quantity);
  });
});

describe('ORD-11 lease prestes a vencer', () => {
  // timeout (10 s) + folga (2 s) = 12 s: com menos lease que isso, a tentativa desiste antes de chamar.
  it.each([5_000, 11_000])('ORD-11 com o lease de %i ms, menor que timeout + folga, o worker não chama o ERP e a mensagem volta depois', async (leaseMs) => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool);

    await newWorker(world, { leaseMs }).pollOnce();

    expect(world.transport.sends).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect((await readOutbox(suite.pool, order.orderId)).status).toBe('pending');

    // Vencido o lease, outro worker, com a configuração normal, termina o envio.
    await makeClaimable(suite.pool, order.orderId);
    expect(await newWorker(world).pollOnce()).toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });
});

describe('ORD-19 status do pedido depois do worker', () => {
  it('ORD-19 depois de faturar, o status devolve invoiced; antes, pending', async () => {
    const order = await acceptOrder(suite, { quantity: 2, priceCents: 1990 });
    const world = createErpWorld(suite.database.erpPool);
    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'pending' });

    expect(await newWorker(world).pollOnce()).toBe(1);

    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'invoiced' });
    // A fatura sai pelo preço aceito no checkout (H3).
    expect(await invoiceTotals(suite.database.pool, order.orderId)).toEqual([2 * 1990]);
  });

  it.each([
    ['erp_rejected', false],
    ['erp_out_of_stock', true],
  ] as const)('ORD-19 depois da rejeição permanente (%s), o status devolve failed com o motivo', async (reason, outOfStock) => {
    const order = await acceptOrder(suite, outOfStock ? { erpOnHand: 0 } : {});
    const world = createErpWorld(suite.database.erpPool);
    if (!outOfStock) world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: order.orderId });

    expect(await newWorker(world).pollOnce()).toBe(1);

    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'failed', reason });
  });

  it('ORD-19 com a mensagem em dead, o status continua pending', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.setDefault({ mode: 'unavailable' });
    const maxAttempts = 2;
    const worker = newWorker(world, { maxAttempts });

    // A DLQ vem do limite de tentativas: cada rodada falha, e o atraso mínimo é semeado entre elas.
    for (let round = 0; round <= maxAttempts; round += 1) {
      await makeClaimable(suite.pool, order.orderId);
      await worker.pollOnce();
      if ((await readOutbox(suite.pool, order.orderId)).status === 'dead') break;
    }

    expect((await readOutbox(suite.pool, order.orderId)).status).toBe('dead');
    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'pending' });
  });
});
