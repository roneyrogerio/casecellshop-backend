import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { settle } from '../../helpers/async.ts';
import {
  acceptOrder,
  buildWorker,
  cancelLeftoverMessages,
  createErpWorld,
  expectInvoiced,
  readOrder,
  startWorkerSuite,
  type ErpWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';
import type { Worker } from '../../../src/worker.ts';

// Ciclo de vida do worker: um start() ou um pollOnce() depois do stop() voltam a reivindicar.

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

// O laço do start() espera o intervalo de polling pelo relógio manual: o teste o avança até o stop() resolver.
async function stopWorker(worker: Worker, world: ErpWorld): Promise<void> {
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await vi.waitFor(
    () => {
      world.clock.advance(500);
      expect(stopped, 'o stop() ainda espera o laço').toBe(true);
    },
    { timeout: 10_000, interval: 20 },
  );
  await stopping;
}

describe('A14 o worker volta a reivindicar depois do stop()', () => {
  it('ORD-20 um start() depois de um stop() reivindica e fatura uma mensagem nova', async () => {
    const world = createErpWorld(suite.database.erpPool);
    const worker = buildWorker(world, { pool: suite.pool, telemetry: suite.telemetry });
    await worker.start();
    await stopWorker(worker, world);

    const order = await acceptOrder(suite);
    await worker.start();
    await vi.waitFor(
      async () => {
        world.clock.advance(500);
        expect((await readOrder(suite.pool, order.orderId)).status).toBe('invoiced');
      },
      { timeout: 10_000, interval: 20 },
    );
    await stopWorker(worker, world);

    await expectInvoiced(suite.pool, order);
  });

  it('ORD-20 um start() chamado enquanto o stop() espera uma tentativa presa aguarda o stop() e depois volta a reivindicar e faturar uma mensagem nova', async () => {
    const world = createErpWorld(suite.database.erpPool);
    const worker = buildWorker(world, { pool: suite.pool, telemetry: suite.telemetry });
    const stuck = await acceptOrder(suite);
    // A chamada desta mensagem nunca recebe resposta: só o timeout do ERP, no relógio manual, a encerra.
    world.transport.stall({ op: 'createOrder', reference: stuck.orderId }, { callErp: false });
    await worker.start();
    await world.transport.waitForSends(1, 'createOrder');

    const sequence: string[] = [];
    const stopping = worker.stop().then(() => sequence.push('stop'));
    const restarting = worker.start().then(() => sequence.push('start'));
    const fresh = await acceptOrder(suite);
    await settle();
    expect(sequence, 'o start() não resolve enquanto o stop() espera a tentativa em voo').toEqual([]);

    // Avança o relógio: o timeout da chamada presa e o intervalo de polling do laço.
    await vi.waitFor(
      async () => {
        world.clock.advance(500);
        expect((await readOrder(suite.pool, fresh.orderId)).status).toBe('invoiced');
      },
      { timeout: 10_000, interval: 20 },
    );
    await Promise.all([stopping, restarting]);
    expect(sequence).toEqual(['stop', 'start']);
    await stopWorker(worker, world);

    await expectInvoiced(suite.pool, fresh);
  });

  it('ORD-20 um pollOnce() direto depois do stop() também reivindica a mensagem', async () => {
    const world = createErpWorld(suite.database.erpPool);
    const worker = buildWorker(world, { pool: suite.pool, telemetry: suite.telemetry });
    await worker.start();
    await stopWorker(worker, world);
    const order = await acceptOrder(suite);

    expect(await worker.pollOnce()).toBe(1);

    await expectInvoiced(suite.pool, order);
  });
});
