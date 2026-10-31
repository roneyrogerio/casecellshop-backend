import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settle } from '../../helpers/async.ts';
import { ERP_TIMEOUT_MS, countInvoices } from '../../helpers/erp.ts';
import {
  acceptOrder,
  buildWorker,
  cancelLeftoverMessages,
  createErpWorld,
  expectInvoiced,
  expireLeaseOnly,
  makeClaimable,
  readOrder,
  readOutbox,
  startPoll,
  startWorkerSuite,
  type ErpWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Fatura duplicada no envio ao ERP (ORD-01 a ORD-06): o worker chama o ERP simulado sobre o
// relógio manual, e o teste conta as faturas no erp_sim pela referência (o orderId), nunca as chamadas.

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

function newWorker(world: ErpWorld) {
  return buildWorker(world, { pool: suite.pool, telemetry: suite.telemetry });
}

function invoices(orderId: string): Promise<number> {
  return countInvoices(suite.database.pool, orderId);
}

describe('ORD-01 mensagem entregue duas vezes', () => {
  it('ORD-01 sem a H1b, a conclusão perdida e o lease vencido reprocessam a mensagem e deixam uma fatura', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool, { withoutH1b: true });
    // O ERP fatura e responde, mas a resposta nunca chega ao worker: a conclusão se perde.
    const lost = world.transport.stall({ op: 'createOrder', reference: order.orderId });
    const first = startPoll(newWorker(world));
    await first.until(lost.erpSettled);
    expect(await invoices(order.orderId)).toBe(1);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');

    // O lease vence e o atraso mínimo passa: a mesma mensagem é entregue de novo.
    await makeClaimable(suite.pool, order.orderId);
    const second = newWorker(world);
    expect(await second.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
    // A tentativa perdida segue pendurada: a segunda não pode depender dela.
    expect(first.settled).toBe(false);
  });
});

describe('ORD-02 worker que morre no meio da chamada', () => {
  it('ORD-02 sem a H1b, a nova reivindicação só acontece depois do atraso mínimo e termina com uma fatura', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool, { withoutH1b: true });
    // O ERP fatura 30 s depois do início da chamada (dentro da H4), com o worker já morto.
    world.sim.script.enqueue({ mode: 'invoice_after', delayMs: 30_000 }, { op: 'createOrder', reference: order.orderId });
    world.transport.stall({ op: 'createOrder', reference: order.orderId });
    const dying = startPoll(newWorker(world));
    await dying.until(world.transport.waitForSends(1, 'createOrder'));
    const claimed = await readOutbox(suite.pool, order.orderId);
    expect(claimed.attempts).toBe(1);
    expect(claimed.firstSentAt).not.toBeNull();
    expect(claimed.leased).toBe(true);

    // O lease vence, mas a última chamada é recente: ainda é cedo para reivindicar.
    await expireLeaseOnly(suite.pool, order.orderId);
    const replacement = newWorker(world);
    expect(await replacement.pollOnce()).toBe(0);
    expect(world.transport.sends).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(0);

    // O ERP termina a chamada do worker morto; só então o atraso mínimo passa e a mensagem volta.
    world.clock.advance(30_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(suite.pool, order.orderId);
    expect(await replacement.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });
});

describe('ORD-03 ERP que fatura e não responde', () => {
  it.each([
    ['sem a H1b', true],
    ['com a H1b', false],
  ])('ORD-03 %s, a segunda tentativa acha a fatura e o pedido fica invoiced com uma fatura', async (_label, withoutH1b) => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool, { withoutH1b });
    world.sim.script.enqueue({ mode: 'invoice_no_response' }, { op: 'createOrder', reference: order.orderId });
    const worker = newWorker(world);

    const first = startPoll(worker);
    await first.until(world.transport.waitForSends(1, 'createOrder'));
    world.clock.advance(ERP_TIMEOUT_MS);
    expect(await first.result).toBe(1);
    await world.sim.script.drain();
    // Sem resposta, o pedido segue pendente para outra tentativa, e a fatura já existe.
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect((await readOutbox(suite.pool, order.orderId)).status).toBe('pending');
    expect(await invoices(order.orderId)).toBe(1);

    await makeClaimable(suite.pool, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });
});

describe('ORD-04 ERP que fatura depois do timeout, dentro da H4', () => {
  it('ORD-04 sem a H1b, a fatura de 30 s é achada na tentativa seguinte e fica uma só', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool, { withoutH1b: true });
    world.sim.script.enqueue({ mode: 'invoice_after', delayMs: 30_000 }, { op: 'createOrder', reference: order.orderId });
    const worker = newWorker(world);

    const first = startPoll(worker);
    await first.until(world.transport.waitForSends(1, 'createOrder'));
    world.clock.advance(ERP_TIMEOUT_MS);
    expect(await first.result).toBe(1);
    expect(await invoices(order.orderId)).toBe(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');

    // Os 30 s da chamada se completam no ERP; o atraso mínimo de 45 s passa antes da nova tentativa.
    world.clock.advance(20_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(suite.pool, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });
});

describe('ORD-05 ERP que devolve 502 na hora e fatura em seguida', () => {
  it('ORD-05 sem a H1b, o 502 não falha o pedido e a tentativa seguinte acha a fatura: uma só', async () => {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool, { withoutH1b: true });
    world.sim.script.enqueue({ mode: 'fast_502_then_invoice', delayMs: 20_000 }, { op: 'createOrder', reference: order.orderId });
    const worker = newWorker(world);

    // O 502 volta na hora: a rodada termina sem avançar o relógio.
    expect(await worker.pollOnce()).toBe(1);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect(await invoices(order.orderId)).toBe(0);

    world.clock.advance(20_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(suite.pool, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });
});

describe('ORD-06 ERP acima do limite da H4', () => {
  // A fatura de 60 s sai depois da segunda tentativa (45 s): a consulta não a vê, e o worker cria.
  async function runLateInvoice(withoutH1b: boolean) {
    const order = await acceptOrder(suite);
    const world = createErpWorld(suite.database.erpPool, { withoutH1b });
    world.sim.script.enqueue({ mode: 'invoice_after', delayMs: 60_000 }, { op: 'createOrder', reference: order.orderId });
    const worker = newWorker(world);

    const first = startPoll(worker);
    await first.until(world.transport.waitForSends(1, 'createOrder'));
    world.clock.advance(ERP_TIMEOUT_MS);
    expect(await first.result).toBe(1);

    world.clock.advance(35_000);
    await settle();
    await makeClaimable(suite.pool, order.orderId);
    expect(await worker.pollOnce()).toBe(1);
    // A segunda tentativa não achou a fatura (ainda não existe) e criou a dela.
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);

    // Aos 60 s a criação atrasada da primeira chamada chega ao ERP.
    world.clock.advance(15_000);
    await settle();
    await world.sim.script.drain();
    return order;
  }

  it('ORD-06 com a H1b, a criação atrasada devolve a fatura existente: uma só', async () => {
    const order = await runLateInvoice(false);

    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-06 sem a H1b, a criação atrasada gera a segunda fatura: o limite declarado do README (o teste afirma 2)', async () => {
    const order = await runLateInvoice(true);

    expect(await invoices(order.orderId)).toBe(2);
    // O pedido da loja não muda: a duplicata é só do lado do ERP.
    await expectInvoiced(suite.pool, order);
  });
});
