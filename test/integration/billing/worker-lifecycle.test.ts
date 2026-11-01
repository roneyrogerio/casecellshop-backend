import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { settle, WAIT_GUARD_MS, waitAdvancing } from '../../helpers/async.ts';
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
  untilInvoiced,
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
    await untilInvoiced(world, order.orderId);
    await stopAdvancing(worker, world);

    await expectInvoiced(world, order);
  });

  it('ORD-20 um start() chamado enquanto o stop() espera uma tentativa presa aguarda o stop() e depois volta a receber e faturar uma mensagem nova', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const stuck = await submitOrder(suite, world);
    // A chamada desta mensagem fica presa no portão do transporte, sem resposta, até o teste cortá-la.
    const held = world.transport.stall(
      { op: 'createOrder', reference: stuck.orderId },
      { callErp: false },
    );
    await worker.start();
    await within(
      world.transport.waitForSends(1, 'createOrder'),
      'a tentativa chamar o ERP',
    );

    const sequence: string[] = [];
    const stopping = worker.stop().then(() => sequence.push('stop'));
    const restarting = worker.start().then(() => sequence.push('start'));
    const fresh = await submitOrder(suite, world);
    await settle();
    expect(
      sequence,
      'o start() não resolve enquanto o stop() espera a tentativa em voo',
    ).toEqual([]);

    // Cortar a chamada presa no portão do transporte solta o stop(); então o start() volta a receber. O relógio
    // manual não avança em nenhum ponto até aqui: a mensagem nova pode ser recebida e chamar o ERP a qualquer
    // momento (um recebimento em voo do laço antigo, ou o laço novo), e um avanço nessa hora estouraria o timeout
    // (10 s) da chamada dela, deixando-a ambígua. O ERP simulado fatura sem esperar o relógio.
    held.fail();
    await vi.waitFor(
      async () => {
        expect((await readOrder(world.pool, fresh.orderId)).status).toBe(
          'invoiced',
        );
      },
      { timeout: WAIT_GUARD_MS, interval: 20 },
    );
    await Promise.all([stopping, restarting]);
    expect(sequence).toEqual(['stop', 'start']);
    await stopAdvancing(worker, world);

    await expectInvoiced(world, fresh, { queueEmpty: false });
    // A tentativa presa terminou sem resposta (ambígua): o ERP não faturou o pedido dela, e a mensagem voltou ao
    // SQS pelo retry e segue escondida; a da nova foi apagada.
    expect((await readOrder(world.pool, stuck.orderId)).status).toBe('pending');
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
async function expectNoReceiveAfterStop(
  world: QueueWorld,
  gate: Gate,
): Promise<void> {
  const count = world.queue.receives.length;
  gate.releaseAll();
  await vi.waitFor(
    () => expect(world.queue.completedReceives).toBeGreaterThanOrEqual(count),
    { timeout: WAIT_GUARD_MS },
  );
  await settle(30);
  expect(
    world.queue.receives,
    'um laço que sobrou depois do último stop() pediria outro receive',
  ).toHaveLength(count);
}

describe('A28 em qualquer sequência de start() e stop(), o stop() que resolve por último deixa o worker parado', () => {
  it('ORD-20 stop(), start() e stop() em sequência: o segundo stop() espera o recebimento em voo e, depois dele, nenhum receive novo', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = holdReceives(world);

    const firstStart = worker.start();
    firstStart.catch(() => undefined);
    await within(
      gate.waitForParked(1),
      'o laço do start() pedir o primeiro receive',
    );
    const firstStop = stopAdvancing(worker, world);
    gate.releaseAll();
    await firstStop;
    await firstStart;

    const secondStart = worker.start();
    secondStart.catch(() => undefined);
    await within(
      gate.waitForParked(2),
      'o start() depois do stop() voltar a pedir receive',
    );
    expect(
      world.queue.receives,
      'o start() depois do stop() voltou a receber',
    ).toHaveLength(2);
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
    await within(
      gate.waitForParked(1),
      'o laço do start() pedir o primeiro receive',
    );

    const finished = Promise.all([
      worker.stop(),
      worker.start(),
      worker.stop(),
    ]).then(() => true);
    let done = false;
    void finished.then(() => {
      done = true;
    });
    await waitAdvancing(world.advanceIdle, () => {
      gate.releaseAll();
      expect(done, 'as três chamadas ainda esperam').toBe(true);
    });

    await expectNoReceiveAfterStop(world, gate);
  });

  it('ORD-20 um start() com o worker já rodando não abre um segundo laço', async () => {
    const world = await createWorld(suite);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = holdReceives(world);
    const first = worker.start();
    first.catch(() => undefined);
    await within(
      gate.waitForParked(1),
      'o laço do start() pedir o primeiro receive',
    );

    const second = worker.start();
    second.catch(() => undefined);
    await settle(30);

    expect(world.queue.receives, 'um laço só: um receive em voo').toHaveLength(
      1,
    );
    const stopping = stopAdvancing(worker, world);
    gate.releaseAll();
    await stopping;
    await expectNoReceiveAfterStop(world, gate);
  });
});
