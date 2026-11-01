import { describe, expect, it } from 'vitest';
import { settle } from '../../helpers/async.ts';
import { countInvoices, ERP_TIMEOUT_MS } from '../../helpers/erp.ts';
import {
  buildWorker,
  createGate,
  createWorld,
  expectInvoiced,
  readOrder,
  startPoll,
  submitOrder,
  useWorkerSuite,
} from '../../helpers/worker.ts';

// FND-13: o relógio do mundo do worker só avança quando nenhuma chamada ao ERP está em andamento. O cenário é o
// mesmo nos dois sentidos: a chamada ao ERP fica parada no transporte (a fatura já nasceu no ERP simulado, a
// resposta ainda não voltou ao worker) enquanto o tempo simulado corre.

const suite = useWorkerSuite();

const FIXED_STEP_MS = 500;
// Passos suficientes para o relógio passar do timeout de 10 s do ERP.
const STEPS_PAST_TIMEOUT = ERP_TIMEOUT_MS / FIXED_STEP_MS + 5;

// Uma rodada do worker com a chamada do pedido parada no transporte, depois de o ERP simulado responder.
async function holdCall() {
  const world = await createWorld(suite());
  const order = await submitOrder(suite(), world);
  const gate = createGate();
  world.transport.afterErp(
    { op: 'createOrder', reference: order.orderId },
    () => gate.park(),
  );
  const poll = startPoll(buildWorker(world));
  await poll.until(world.transport.waitForSends(1, 'createOrder'));
  await poll.until(gate.waitForParked(1));
  return { world, order, gate, poll };
}

describe('FND-13 controle negativo do relógio: passo fixo contra avanço até a próxima espera', () => {
  it('FND-13 controle negativo: com o relógio avançado por passo fixo enquanto a chamada ao ERP está parada, a chamada se perde por timeout e a fatura não sai a tempo', async () => {
    const { world, order, gate, poll } = await holdCall();

    for (let step = 0; step < STEPS_PAST_TIMEOUT; step += 1) {
      world.clock.advance(FIXED_STEP_MS);
      await settle();
    }
    gate.releaseAll();

    expect(await poll.result).toBe(1);
    // A fatura nasceu no ERP, mas a resposta chegou depois do timeout: o worker a perdeu, o pedido segue
    // pendente e a mensagem volta ao SQS pelo retry.
    expect(await countInvoices(suite().database.pool, order.orderId)).toBe(1);
    expect((await readOrder(world.pool, order.orderId)).status).toBe('pending');
    expect(world.queue.visibilityChanges).toHaveLength(1);
    expect(world.transport.inFlight, 'a chamada abandonada não conta').toBe(0);
  });

  it('FND-13 com o avanço até a próxima espera, o relógio não anda enquanto a chamada ao ERP está em andamento, e a fatura sai quando ela volta', async () => {
    const { world, order, gate, poll } = await holdCall();
    const before = world.clock.now();
    expect(
      world.clock.pendingWaits().length,
      'o timeout da chamada está armado no relógio',
    ).toBeGreaterThan(0);

    for (let step = 0; step < STEPS_PAST_TIMEOUT; step += 1) {
      expect(world.advanceIdle()).toBe(false);
      await settle();
    }
    expect(world.clock.now()).toBe(before);
    gate.releaseAll();

    expect(await poll.result).toBe(1);
    expect(await countInvoices(suite().database.pool, order.orderId)).toBe(1);
    await expectInvoiced(world, order);
    expect(world.queue.visibilityChanges).toEqual([]);
  });

  it('FND-13 sem chamada em andamento, o avanço do mundo leva o relógio até a próxima espera e não passa dela', async () => {
    const world = await createWorld(suite());
    const start = world.clock.now();
    void world.clock.sleep(2_000);
    void world.clock.sleep(9_000);

    expect(world.advanceIdle()).toBe(true);

    expect(world.clock.now()).toBe(start + 2_000);
    expect(world.clock.pendingWaits()).toEqual([start + 9_000]);
  });

  it('FND-13 uma chamada cortada sem resposta deixa de contar como em andamento, e o avanço volta a andar', async () => {
    const world = await createWorld(suite());
    const order = await submitOrder(suite(), world);
    const held = world.transport.stall(
      { op: 'createOrder', reference: order.orderId },
      { callErp: false },
    );
    const poll = startPoll(buildWorker(world));
    await poll.until(world.transport.waitForSends(1, 'createOrder'));
    void world.clock.sleep(1_000);
    expect(world.transport.inFlight).toBe(1);
    expect(world.advanceIdle()).toBe(false);

    held.fail();
    await poll.until(poll.result);

    expect(world.transport.inFlight).toBe(0);
    expect(world.advanceIdle()).toBe(true);
  });
});
