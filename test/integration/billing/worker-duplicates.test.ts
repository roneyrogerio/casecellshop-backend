import { pino } from 'pino';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRelay } from '../../../src/billing/relay.ts';
import { settle, WAIT_GUARD_MS } from '../../helpers/async.ts';
import {
  ERP_TIMEOUT_MS,
  MIN_RETRY_DELAY_MS,
  countInvoices,
} from '../../helpers/erp.ts';
import { countsOf } from '../../helpers/sqs.ts';
import {
  acceptOrder,
  ageLastCall,
  buildWorker,
  createWorld,
  expectInvoiced,
  expectQueuesEmpty,
  makeClaimable,
  markSentBefore,
  readOrder,
  readOutbox,
  releaseMessage,
  startPoll,
  startWorkerSuite,
  submitOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Fatura duplicada no envio ao ERP (ORD-01 a ORD-06, ORD-22): o worker consome o SQS e chama o ERP simulado
// sobre o relógio manual, e o teste conta as faturas no erp_sim pela referência (o orderId), nunca as chamadas.
// A mensagem volta à fila com `ChangeMessageVisibility` e `VisibilityTimeout = 0`, e o atraso mínimo é
// cumprido semeando o `last_call_at` no banco (AD-021): nenhum teste espera o relógio do emulador.

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

describe('ORD-01 mensagem entregue duas vezes', () => {
  it('ORD-01 sem a H1b, a conclusão perdida e a mensagem devolvida ao SQS reprocessam e deixam uma fatura', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world);
    // O ERP fatura e responde, mas a resposta nunca chega ao worker: a conclusão se perde.
    const lost = world.transport.stall({
      op: 'createOrder',
      reference: order.orderId,
    });
    const first = startPoll(buildWorker(world));
    await first.until(lost.erpSettled);
    expect(await invoices(order.orderId)).toBe(1);
    expect((await readOrder(world.pool, order.orderId)).status).toBe('pending');

    // A visibilidade vence e o atraso mínimo passa: a mesma mensagem é entregue de novo.
    await makeClaimable(world, order.orderId);
    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
    // A tentativa perdida segue pendurada: a segunda não pode depender dela.
    expect(first.settled).toBe(false);
  });

  it('ORD-01 sem a H1b, a mesma mensagem duas vezes na fila, uma depois da outra: a repetida acha o pedido já faturado, é apagada sem chamar o ERP e fica uma fatura', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world, { times: 2 });
    // Uma permissão: cada rodada recebe uma mensagem só.
    const worker = buildWorker(world, { config: { erpConcurrency: 1 } });

    expect(await worker.pollOnce()).toBe(1);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(1);
    expect(world.transport.sendsOf('findOrder')).toHaveLength(0);
    expect(
      world.queue.deletesOf(order.orderId).map((call) => call.result),
    ).toEqual(['ok', 'ok']);
    await expectInvoiced(world, order);
  });
});

describe('ORD-02 worker que morre no meio da chamada', () => {
  it('ORD-02 sem a H1b, a mensagem que volta ao SQS antes do atraso mínimo é adiada, a nova chamada só sai depois dele, contado da chamada abandonada, e termina com uma fatura', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world);
    // O ERP fatura 30 s depois do início da chamada (dentro da H4), com o worker já morto.
    world.sim.script.enqueue(
      { mode: 'invoice_after', delayMs: 30_000 },
      { op: 'createOrder', reference: order.orderId },
    );
    world.transport.stall({ op: 'createOrder', reference: order.orderId });
    const dying = startPoll(buildWorker(world));
    await dying.until(world.transport.waitForSends(1, 'createOrder'));
    const abandoned = await readOutbox(world.pool, order.orderId);
    expect(abandoned.firstSentAt).not.toBeNull();
    expect(abandoned.callToken).not.toBeNull();
    expect(abandoned.sinceLastCallMs ?? Infinity).toBeLessThan(10_000);

    // A visibilidade vence (a mensagem do worker morto volta), mas a última chamada é recente.
    await releaseMessage(world, order.orderId);
    const replacement = buildWorker(world);
    expect(await replacement.pollOnce()).toBe(1);
    expect(
      world.transport.sends,
      'nenhuma chamada nova antes do atraso mínimo',
    ).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(0);
    // A mensagem adiada segue no SQS, escondida pelo tempo que falta mais 1 s.
    const deferrals = world.queue.visibilityChanges.filter(
      (change) => change.result === 'ok',
    );
    expect(deferrals).toHaveLength(1);
    expect(deferrals[0]?.seconds).toBeGreaterThanOrEqual(
      MIN_RETRY_DELAY_MS / 1000 - 5,
    );
    expect(deferrals[0]?.seconds).toBeLessThanOrEqual(
      MIN_RETRY_DELAY_MS / 1000 + 2,
    );
    expect(world.queue.deletes).toEqual([]);

    // O ERP termina a chamada do worker morto; só então o atraso mínimo, contado do início dela, passa.
    world.clock.advance(30_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(world, order.orderId);
    expect(await replacement.pollOnce()).toBe(1);

    expect(world.transport.sendsOf('createOrder')).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });
});

describe('ORD-03 ERP que fatura e não responde', () => {
  it.each([
    ['sem a H1b', true],
    ['com a H1b', false],
  ])(
    'ORD-03 %s, a segunda tentativa acha a fatura e o pedido fica invoiced com uma fatura',
    async (_label, withoutH1b) => {
      const world = await createWorld(suite, { withoutH1b });
      const order = await submitOrder(suite, world);
      world.sim.script.enqueue(
        { mode: 'invoice_no_response' },
        { op: 'createOrder', reference: order.orderId },
      );
      const worker = buildWorker(world);

      const first = startPoll(worker);
      await first.until(world.transport.waitForSends(1, 'createOrder'));
      world.clock.advance(ERP_TIMEOUT_MS);
      expect(await first.result).toBe(1);
      await world.sim.script.drain();
      // Sem resposta, o pedido segue pendente, e a fatura já existe; a mensagem volta ao SQS pelo retry.
      expect((await readOrder(world.pool, order.orderId)).status).toBe(
        'pending',
      );
      expect(await invoices(order.orderId)).toBe(1);
      expect(world.queue.deletesOf(order.orderId)).toEqual([]);
      expect(world.queue.changesOf(order.orderId)).toHaveLength(1);

      await makeClaimable(world, order.orderId);
      expect(await worker.pollOnce()).toBe(1);

      expect(await invoices(order.orderId)).toBe(1);
      await expectInvoiced(world, order);
    },
  );
});

describe('ORD-04 ERP que fatura depois do timeout, dentro da H4', () => {
  it('ORD-04 sem a H1b, a fatura de 30 s é achada na tentativa seguinte e fica uma só', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world);
    world.sim.script.enqueue(
      { mode: 'invoice_after', delayMs: 30_000 },
      { op: 'createOrder', reference: order.orderId },
    );
    const worker = buildWorker(world);

    const first = startPoll(worker);
    await first.until(world.transport.waitForSends(1, 'createOrder'));
    world.clock.advance(ERP_TIMEOUT_MS);
    expect(await first.result).toBe(1);
    expect(await invoices(order.orderId)).toBe(0);
    expect((await readOrder(world.pool, order.orderId)).status).toBe('pending');

    // Os 30 s da chamada se completam no ERP; o atraso mínimo de 45 s passa antes da nova tentativa.
    world.clock.advance(20_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });
});

describe('ORD-04 a criação que vem depois de uma consulta (a partir da 2ª tentativa)', () => {
  it('ORD-04 sem a H1b, a criação depois de uma consulta lenta renova a permissão de chamada antes de sair, e o atraso mínimo conta a partir dela: uma fatura no fim', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world);
    await markSentBefore(world.pool, order.orderId);
    // A consulta demora 8 s (o p99,9 da premissa) e dá not_found; a criação fatura em 30 s, dentro da H4.
    world.sim.script.enqueue(
      { mode: 'slow', delayMs: 8_000 },
      { op: 'findOrder', reference: order.orderId },
    );
    world.sim.script.enqueue(
      { mode: 'invoice_after', delayMs: 30_000 },
      { op: 'createOrder', reference: order.orderId },
    );
    // Quando a consulta responde, ela já começou há 30 s pelo relógio do banco (a espera real do ERP lento);
    // o last_call_at gravado ao tomar a permissão fica velho, e só a renovação antes da criação o corrige.
    world.transport.afterErp(
      { op: 'findOrder', reference: order.orderId },
      async () => {
        await world.pool.query(
          "update outbox set last_call_at = now() - interval '30 seconds' where order_id = $1",
          [order.orderId],
        );
      },
    );
    const worker = buildWorker(world);

    const first = startPoll(worker);
    await first.until(world.transport.waitForSends(1, 'findOrder'));
    world.clock.advance(8_000);
    await first.until(world.transport.waitForSends(1, 'createOrder'));
    // A criação já saiu: o início dela foi regravado agora, e não o da consulta.
    expect(
      (await readOutbox(world.pool, order.orderId)).sinceLastCallMs ?? Infinity,
    ).toBeLessThan(10_000);
    world.clock.advance(ERP_TIMEOUT_MS);
    expect(await first.result).toBe(1);
    expect(
      (await readOutbox(world.pool, order.orderId)).sinceLastCallMs ?? Infinity,
    ).toBeLessThan(10_000);

    // O atraso mínimo de 45 s conta do início da criação, a última chamada: a mensagem que volta já é adiada.
    await releaseMessage(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);
    expect(world.transport.sends, 'consulta e criação, nada além').toHaveLength(
      2,
    );

    // Os 30 s da criação se completam no ERP; o atraso mínimo passa e a tentativa seguinte acha a fatura.
    world.clock.advance(20_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });
});

describe('ORD-05 ERP que devolve 502 na hora e fatura em seguida', () => {
  it('ORD-05 sem a H1b, o 502 não falha o pedido e a tentativa seguinte acha a fatura: uma só', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world);
    world.sim.script.enqueue(
      { mode: 'fast_502_then_invoice', delayMs: 20_000 },
      { op: 'createOrder', reference: order.orderId },
    );
    const worker = buildWorker(world);

    // O 502 volta na hora: a rodada termina sem avançar o relógio.
    expect(await worker.pollOnce()).toBe(1);
    expect((await readOrder(world.pool, order.orderId)).status).toBe('pending');
    expect(await invoices(order.orderId)).toBe(0);
    expect(world.queue.deletesOf(order.orderId)).toEqual([]);

    world.clock.advance(20_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await makeClaimable(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });
});

describe('ORD-06 ERP acima do limite da H4', () => {
  // A fatura de 60 s sai depois da segunda tentativa (45 s): a consulta não a vê, e o worker cria.
  async function runLateInvoice(withoutH1b: boolean) {
    const world = await createWorld(suite, { withoutH1b });
    const order = await submitOrder(suite, world);
    world.sim.script.enqueue(
      { mode: 'invoice_after', delayMs: 60_000 },
      { op: 'createOrder', reference: order.orderId },
    );
    const worker = buildWorker(world);

    const first = startPoll(worker);
    await first.until(world.transport.waitForSends(1, 'createOrder'));
    world.clock.advance(ERP_TIMEOUT_MS);
    expect(await first.result).toBe(1);

    world.clock.advance(35_000);
    await settle();
    await makeClaimable(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);
    // A segunda tentativa não achou a fatura (ainda não existe) e criou a dela.
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);

    // Aos 60 s a criação atrasada da primeira chamada chega ao ERP.
    world.clock.advance(15_000);
    await settle();
    await world.sim.script.drain();
    return { world, order };
  }

  it('ORD-06 com a H1b, a criação atrasada devolve a fatura existente: uma só', async () => {
    const { order } = await runLateInvoice(false);

    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-06 sem a H1b, a criação atrasada gera a segunda fatura: o limite declarado do README (o teste afirma 2)', async () => {
    const { world, order } = await runLateInvoice(true);

    expect(await invoices(order.orderId)).toBe(2);
    // O pedido da loja não muda: a duplicata é só do lado do ERP.
    await expectInvoiced(world, order);
  });
});

describe('ORD-22 a mensagem repetida não gera segunda fatura', () => {
  async function publishTwiceWithRealRelay(
    world: QueueWorld,
    orderId: string,
  ): Promise<void> {
    // O relay lê toda a outbox não publicada do banco compartilhado: só a linha deste teste entra na fila dele.
    await world.pool.query(
      'update outbox set published_at = now() where published_at is null and order_id <> $1',
      [orderId],
    );
    const relay = createRelay({
      pool: world.pool,
      queue: world.queues.queue,
      logger: pino({ level: 'silent' }),
      telemetry: world.telemetry,
      clock: world.clock,
    });
    expect(await relay.publishOnce()).toBe(1);
    // Uma queda entre publicar e marcar como publicada: a marca se perde, e o relay publica a mesma linha de novo.
    await world.pool.query(
      'update outbox set published_at = null where order_id = $1',
      [orderId],
    );
    expect(await relay.publishOnce()).toBe(1);
  }

  it('ORD-22 sem a H1b, o relay que publicou a mesma linha duas vezes deixa uma fatura: a segunda mensagem é adiada pela permissão de chamada e depois apagada sem chamar o ERP', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await acceptOrder(suite);
    await publishTwiceWithRealRelay(world, order.orderId);
    await vi.waitFor(
      async () =>
        expect((await countsOf(world.emq, world.queues.queueUrl)).visible).toBe(
          2,
        ),
      { timeout: WAIT_GUARD_MS },
    );
    const worker = buildWorker(world);

    // A tentativa que ganhar a permissão fica presa na chamada ao ERP (depois de a fatura nascer, antes de a
    // resposta voltar) até a outra ser adiada. Sem isso, sob carga a primeira conclui antes de a segunda ler o
    // status do pedido, e a segunda apagaria a mensagem como `outbox.closed` sem nunca disputar a permissão.
    let held = false;
    world.transport.afterErp(
      { op: 'createOrder', reference: order.orderId },
      async () => {
        held = true;
        await vi.waitFor(
          () =>
            expect(
              world.queue.visibilityChanges,
              'a segunda tentativa foi adiada pela permissão',
            ).toHaveLength(1),
          {
            timeout: WAIT_GUARD_MS,
            interval: 10,
          },
        );
      },
    );

    // As duas chegam juntas ao mesmo worker.
    expect(await worker.pollOnce()).toBe(2);

    expect(
      held,
      'a chamada ao ERP ficou presa até o adiamento da outra mensagem',
    ).toBe(true);
    expect(await invoices(order.orderId)).toBe(1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(1);
    expect(world.transport.maxInFlight).toBe(1);
    // A que perdeu a permissão não foi apagada: voltou ao SQS pelo tempo que faltava.
    expect(world.queue.deletesOf(order.orderId)).toHaveLength(1);
    expect(world.queue.changesOf(order.orderId)).toHaveLength(1);

    await ageLastCall(world.pool, order.orderId);
    await releaseMessage(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(1);
    expect(world.transport.sendsOf('findOrder')).toHaveLength(0);
    await expectInvoiced(world, order);
    await expectQueuesEmpty(world);
  });
});
