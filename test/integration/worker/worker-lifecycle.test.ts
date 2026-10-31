import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { settle } from '../../helpers/async.ts';
import { ERP_TIMEOUT_MS } from '../../helpers/erp.ts';
import {
  buildWorker,
  createGate,
  createWorld,
  expectInvoiced,
  expectOneInFlight,
  readOrder,
  startWorkerSuite,
  stopAdvancing,
  submitOrder,
  within,
  type Gate,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Ciclo de vida do worker (design.md, "Worker: envio"): um start() ou um pollOnce() depois do stop() voltam a
// receber, e em qualquer sequência de start() e stop() o stop() que resolve por último deixa o worker parado
// (um estado só: parado, rodando ou parando).

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

// O laço do start() usa o long polling de 1 s do design; sem ele giraria sem parar contra o ElasticMQ.
const LOOP_CONFIG = { receiveWaitSeconds: 1 };

describe('A14 o worker volta a receber depois do stop()', () => {
  it('ORD-20 um start() depois de um stop() recebe e fatura uma mensagem nova', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    await worker.start();
    await stopAdvancing(worker, world);

    const order = await submitOrder(suite, world);
    await worker.start();
    await vi.waitFor(
      async () => {
        world.clock.advance(500);
        expect((await readOrder(world.pool, order.orderId)).status).toBe('invoiced');
      },
      { timeout: 20_000, interval: 20 },
    );
    await stopAdvancing(worker, world);

    await expectInvoiced(world, order);
  });

  it('ORD-20 um start() chamado enquanto o stop() espera uma tentativa presa aguarda o stop() e depois volta a receber e faturar uma mensagem nova', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const stuck = await submitOrder(suite, world);
    // A chamada desta mensagem nunca recebe resposta: só o timeout do ERP, no relógio manual, a encerra.
    world.transport.stall({ op: 'createOrder', reference: stuck.orderId }, { callErp: false });
    await worker.start();
    await within(world.transport.waitForSends(1, 'createOrder'), 'a tentativa chamar o ERP');

    const sequence: string[] = [];
    const stopping = worker.stop().then(() => sequence.push('stop'));
    const restarting = worker.start().then(() => sequence.push('start'));
    const fresh = await submitOrder(suite, world);
    await settle();
    expect(sequence, 'o start() não resolve enquanto o stop() espera a tentativa em voo').toEqual([]);

    // O timeout da chamada presa, no relógio manual, solta o stop(); então o start() volta a receber.
    world.clock.advance(ERP_TIMEOUT_MS);
    await vi.waitFor(
      async () => {
        world.clock.advance(500);
        expect((await readOrder(world.pool, fresh.orderId)).status).toBe('invoiced');
      },
      { timeout: 20_000, interval: 20 },
    );
    await Promise.all([stopping, restarting]);
    expect(sequence).toEqual(['stop', 'start']);
    await stopAdvancing(worker, world);

    await expectInvoiced(world, fresh, { queueEmpty: false });
    // A mensagem da tentativa presa voltou ao SQS pelo retry (ambígua) e segue escondida; a da nova foi apagada.
    await expectOneInFlight(world);
  });

  it('ORD-20 um pollOnce() direto depois do stop() também recebe a mensagem', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    await worker.start();
    await stopAdvancing(worker, world);
    const order = await submitOrder(suite, world);

    expect(await worker.pollOnce()).toBe(1);

    await expectInvoiced(world, order);
  });
});

// Prende todo recebimento do laço no portão do teste: sem sleep, o teste decide quando cada `receive` volta.
function holdReceives(world: QueueWorld): Gate {
  const gate = createGate();
  world.queue.beforeReceive(() => gate.park(), Infinity);
  return gate;
}

// Depois do último stop(): nenhum `receive` novo. Solta o que estiver preso e confere que o laço não pede outro.
async function expectNoReceiveAfterStop(world: QueueWorld, gate: Gate): Promise<void> {
  const count = world.queue.receives.length;
  gate.releaseAll();
  await vi.waitFor(() => expect(world.queue.completedReceives).toBeGreaterThanOrEqual(count));
  await settle(30);
  expect(world.queue.receives, 'um laço que sobrou depois do último stop() pediria outro receive').toHaveLength(count);
}

describe('A28 em qualquer sequência de start() e stop(), o stop() que resolve por último deixa o worker parado', () => {
  it('ORD-20 stop(), start() e stop() em sequência: o segundo stop() espera o recebimento em voo e, depois dele, nenhum receive novo', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = holdReceives(world);

    const firstStart = worker.start();
    firstStart.catch(() => undefined);
    await within(gate.waitForParked(1), 'o laço do start() pedir o primeiro receive');
    const firstStop = stopAdvancing(worker, world);
    gate.releaseAll();
    await firstStop;
    await firstStart;

    const secondStart = worker.start();
    secondStart.catch(() => undefined);
    await within(gate.waitForParked(2), 'o start() depois do stop() voltar a pedir receive');
    expect(world.queue.receives, 'o start() depois do stop() voltou a receber').toHaveLength(2);
    const secondStop = stopAdvancing(worker, world);
    gate.releaseAll();
    await secondStop;
    await secondStart;

    await expectNoReceiveAfterStop(world, gate);
  });

  it('ORD-20 stop(), start() e stop() chamados sem esperar um ao outro terminam parados: nenhum laço sobra', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = holdReceives(world);
    const started = worker.start();
    started.catch(() => undefined);
    await within(gate.waitForParked(1), 'o laço do start() pedir o primeiro receive');

    const finished =Promise.all([worker.stop(), worker.start(), worker.stop()]).then(() => true);
    let done = false;
    void finished.then(() => {
      done = true;
    });
    await vi.waitFor(
      () => {
        gate.releaseAll();
        world.clock.advance(500);
        expect(done, 'as três chamadas ainda esperam').toBe(true);
      },
      { timeout: 20_000, interval: 20 },
    );

    await expectNoReceiveAfterStop(world, gate);
  });

  it('ORD-20 um start() com o worker já rodando não abre um segundo laço', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = holdReceives(world);
    const first = worker.start();
    first.catch(() => undefined);
    await within(gate.waitForParked(1), 'o laço do start() pedir o primeiro receive');

    const second =worker.start();
    second.catch(() => undefined);
    await settle(30);

    expect(world.queue.receives, 'um laço só: um receive em voo').toHaveLength(1);
    const stopping = stopAdvancing(worker, world);
    gate.releaseAll();
    await stopping;
    await expectNoReceiveAfterStop(world, gate);
  });
});
