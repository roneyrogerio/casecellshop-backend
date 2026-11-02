import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ErpSimBehavior } from '../../../src/erp/sim/index.ts';
import { settle } from '../../helpers/async.ts';
import { readInventory } from '../../helpers/checkout.ts';
import { ERP_TIMEOUT_MS, MIN_RETRY_DELAY_MS } from '../../helpers/erp.ts';
import {
  PAST_WINDOW_SECONDS,
  SETTLE_WINDOW_SECONDS,
  WITHIN_WINDOW_SECONDS,
} from '../../helpers/late-check.ts';
import { captureLogs, type CapturedLogs } from '../../helpers/logs.ts';
import {
  buildWorker,
  createWorld,
  expectInvoiced,
  expectOneInFlight,
  expectQueuesEmpty,
  invoiceCounter,
  makeClaimable,
  readOrder,
  startPoll,
  submitOrder,
  useWorkerSuite,
  type AcceptedOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';
import type { Worker } from '../../../src/billing/worker.ts';

// Recusa definitiva depois de um envio sem resposta (ORD-27, AD-031), com o ERP simulado sem a H1b: a criação
// anterior pode ainda estar em processamento no ERP, então o worker grava a recusa, devolve a mensagem pela janela
// de assentamento (15 min) e só conclui depois dela, pela consulta à referência. As colunas `refusal_reason` e
// `refused_at` ainda não estão nos tipos gerados do Kysely: o teste as lê e semeia por SQL cru. Os prazos da janela
// correm no relógio do banco, então o teste os semeia no passado em vez de esperar.

const suiteOf = useWorkerSuite();
let suite: WorkerSuite;

beforeEach(() => {
  suite = suiteOf();
});

const invoices = invoiceCounter(suiteOf);

type Reason = 'erp_rejected' | 'erp_out_of_stock';

const REASONS: readonly Reason[] = ['erp_rejected', 'erp_out_of_stock'];

interface RefusalColumns {
  reason: string | null;
  refusedAt: Date | null;
}

async function readRefusal(
  pool: pg.Pool,
  orderId: string,
): Promise<RefusalColumns> {
  const result = await pool.query<{
    refusal_reason: string | null;
    refused_at: Date | null;
  }>('select refusal_reason, refused_at from outbox where order_id = $1', [
    orderId,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return { reason: row.refusal_reason, refusedAt: row.refused_at };
}

// O estado que a recusa deixa na outbox: dois envios (o segundo, a criação recusada), a recusa gravada e tudo
// isso `agoSeconds` atrás pelo relógio do banco. A última chamada acompanha a recusa, e o atraso mínimo já passou.
async function seedRefusal(
  pool: pg.Pool,
  orderId: string,
  reason: Reason,
  agoSeconds: number,
): Promise<void> {
  await pool.query(
    `update outbox
        set first_sent_at = now() - make_interval(secs => $3),
            create_calls = 2,
            last_call_at = now() - make_interval(secs => $3),
            refusal_reason = $2,
            refused_at = now() - make_interval(secs => $3)
      where order_id = $1`,
    [orderId, reason, agoSeconds],
  );
}

// Nada foi vendido: a reserva segue (pedido pending) ou foi liberada (pedido failed).
async function expectReserved(
  order: AcceptedOrder,
  reserved: number,
): Promise<void> {
  expect(await readInventory(suite.pool, order.sku)).toMatchObject({
    onHand: order.onHand,
    reserved,
    soldTotal: 0,
  });
}

// A espera, em segundos, do último `ChangeMessageVisibility` do pedido, e quantos houve.
function visibilityOf(
  world: QueueWorld,
  order: AcceptedOrder,
): { seconds: number; count: number; result: string | undefined } {
  const changes = world.queue.changesOf(order.orderId);
  const last = changes.at(-1);
  return {
    seconds: last?.seconds ?? Number.NaN,
    count: changes.length,
    result: last?.result,
  };
}

// A recusa gravada, semeada, e uma rodada do worker: a primeira recepção da mensagem já é a tentativa seguinte.
async function pollAfterRefusal(
  reason: Reason,
  agoSeconds: number,
  script?: ErpSimBehavior,
): Promise<{ world: QueueWorld; order: AcceptedOrder; logs: CapturedLogs }> {
  const world = await createWorld(suite, { withoutH1b: true });
  const order = await submitOrder(suite, world, { quantity: 2 });
  await seedRefusal(suite.pool, order.orderId, reason, agoSeconds);
  if (script)
    world.sim.script.enqueue(script, {
      op: 'findOrder',
      reference: order.orderId,
    });
  const logs = captureLogs();
  expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(1);
  return { world, order, logs };
}

// A tentativa só consultou: com a recusa gravada nunca há criação, e o pedido segue pending com a reserva.
async function expectOnlyLookedUp(
  world: QueueWorld,
  order: AcceptedOrder,
): Promise<void> {
  expect(world.transport.sends.map((request) => request.op)).toEqual([
    'findOrder',
  ]);
  expect(await readOrder(suite.pool, order.orderId)).toMatchObject({
    status: 'pending',
    failureReason: null,
  });
  await expectReserved(order, order.quantity);
  expect(await invoices(order.orderId)).toBe(0);
  expect(world.queue.deletesOf(order.orderId)).toEqual([]);
}

// O pedido terminou failed com o motivo, a reserva voltou e a mensagem foi apagada, sem retry e sem DLQ.
async function expectFailedAndClosed(
  world: QueueWorld,
  order: AcceptedOrder,
  reason: Reason,
): Promise<void> {
  expect(await readOrder(suite.pool, order.orderId)).toMatchObject({
    status: 'failed',
    failureReason: reason,
  });
  await expectReserved(order, 0);
  expect(await invoices(order.orderId)).toBe(0);
  const deletes = world.queue.deletesOf(order.orderId);
  expect(deletes.map((call) => call.result)).toEqual(['ok']);
  expect(world.queue.changesOf(order.orderId)).toHaveLength(0);
  await expectQueuesEmpty(world);
}

// O pedido aceito no checkout e a fila do teste. A recusa vem do roteiro (`reject`) ou do estoque zerado no erp_sim
// (H2); `first` é o comportamento da primeira criação, que o roteiro serve antes da recusa.
async function prepareOrder(
  reason: Reason,
  first?: ErpSimBehavior,
): Promise<{ world: QueueWorld; order: AcceptedOrder }> {
  const world = await createWorld(suite, { withoutH1b: true });
  const outOfStock = reason === 'erp_out_of_stock';
  const order = await submitOrder(suite, world, {
    quantity: 2,
    ...(outOfStock ? { erpOnHand: 0 } : {}),
  });
  const create = { op: 'createOrder', reference: order.orderId } as const;
  if (first) world.sim.script.enqueue(first, create);
  if (!outOfStock) world.sim.script.enqueue({ mode: 'reject' }, create);
  return { world, order };
}

// O primeiro envio fica sem resposta: a rodada termina pelo timeout do ERP e a mensagem volta por retry.
async function sendWithoutAnswer(
  world: QueueWorld,
  worker: Worker,
): Promise<void> {
  const first = startPoll(worker);
  await first.until(world.transport.waitForSends(1, 'createOrder'));
  world.clock.advance(ERP_TIMEOUT_MS);
  expect(await first.result).toBe(1);
}

interface Refused {
  world: QueueWorld;
  order: AcceptedOrder;
  worker: Worker;
  logs: CapturedLogs;
}

// O caminho inteiro até a recusa: a primeira criação fica em dúvida (`first`), a mensagem volta, a consulta dá
// not_found e a segunda criação recebe a recusa definitiva do ERP (o roteiro `reject`, ou o estoque zerado do erp_sim).
async function refuseAfterDoubt(
  reason: Reason,
  first: ErpSimBehavior,
): Promise<Refused> {
  const { world, order } = await prepareOrder(reason, first);
  const logs = captureLogs();
  const worker = buildWorker(world, { logger: logs.logger });

  await sendWithoutAnswer(world, worker);
  await makeClaimable(world, order.orderId);
  expect(await worker.pollOnce()).toBe(1);
  return { world, order, worker, logs };
}

describe('ORD-27 a recusa depois de um envio sem resposta espera a janela de assentamento', () => {
  it.each(REASONS)(
    'ORD-27 a recusa %s na criação que vem depois de outro envio deixa o pedido pending com a reserva, grava a recusa e devolve a mensagem pela janela de assentamento',
    async (reason) => {
      const { world, order, logs } = await refuseAfterDoubt(reason, {
        mode: 'hang',
      });

      // A consulta deu not_found e a segunda criação foi recusada: duas criações, nenhuma fatura.
      expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
      expect(world.transport.sendsOf('createOrder')).toHaveLength(2);
      expect(await invoices(order.orderId)).toBe(0);
      // O pedido não conclui: segue pending, com a reserva.
      const row = await readOrder(suite.pool, order.orderId);
      expect(row.status).toBe('pending');
      expect(row.failureReason).toBeNull();
      expect(row.outcomeAt).toBeNull();
      await expectReserved(order, order.quantity);
      // A recusa fica gravada na outbox.
      const refusal = await readRefusal(suite.pool, order.orderId);
      expect(refusal.reason).toBe(reason);
      expect(refusal.refusedAt).not.toBeNull();
      // A mensagem não é apagada: volta ao SQS escondida pela janela de assentamento (15 min).
      expect(world.queue.deletesOf(order.orderId)).toEqual([]);
      const hidden = visibilityOf(world, order);
      expect(hidden.count).toBe(2);
      expect(hidden.result).toBe('ok');
      expect(hidden.seconds).toBeGreaterThanOrEqual(SETTLE_WINDOW_SECONDS - 1);
      expect(hidden.seconds).toBeLessThanOrEqual(SETTLE_WINDOW_SECONDS + 2);
      await expectOneInFlight(world);
      // O reagendamento traz a causa própria da recusa não confirmada.
      const retries = logs.eventsOf(
        'casecellshop.outbox.retry.scheduled',
        order.orderId,
      );
      expect(retries).toHaveLength(2);
      expect(retries[1]).toMatchObject({
        level: 'warn',
        cause: 'refusal_unconfirmed',
      });
    },
  );

  it('ORD-27 antes de a janela vencer, a tentativa seguinte só consulta o ERP: not_found não cria, o pedido segue pending e a mensagem volta pelo tempo que falta mais 1 s', async () => {
    const { world, order } = await pollAfterRefusal(
      'erp_rejected',
      WITHIN_WINDOW_SECONDS,
    );

    await expectOnlyLookedUp(world, order);
    // A recusa gravada não é regravada: o início da janela continua o da primeira recusa.
    const refusal = await readRefusal(suite.pool, order.orderId);
    expect(refusal.reason).toBe('erp_rejected');
    const age = await suite.pool.query<{ seconds: number }>(
      'select extract(epoch from now() - refused_at)::float8 as seconds from outbox where order_id = $1',
      [order.orderId],
    );
    expect(age.rows[0]?.seconds ?? 0).toBeGreaterThanOrEqual(
      WITHIN_WINDOW_SECONDS - 1,
    );
    // Faltam 60 s da janela (900 − 840), mais 1 s.
    const remaining = SETTLE_WINDOW_SECONDS - WITHIN_WINDOW_SECONDS;
    const hidden = visibilityOf(world, order);
    expect(hidden.count).toBe(1);
    expect(hidden.result).toBe('ok');
    expect(hidden.seconds).toBeGreaterThanOrEqual(remaining - 2);
    expect(hidden.seconds).toBeLessThanOrEqual(remaining + 5);
    await expectOneInFlight(world);
  });

  it('ORD-27 depois da janela, com a fatura da primeira criação já no ERP, a consulta acha o pedido e ele termina invoiced com uma fatura, sem nova criação', async () => {
    // A primeira criação fatura só aos 60 s, acima da H4: a consulta do 2º envio ainda não a vê, e a criação é recusada.
    const { world, order, worker } = await refuseAfterDoubt('erp_rejected', {
      mode: 'invoice_after',
      delayMs: 60_000,
    });
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect(
      (await readRefusal(suite.pool, order.orderId)).reason,
      'a recusa ficou gravada',
    ).toBe('erp_rejected');
    expect(await invoices(order.orderId)).toBe(0);

    // A criação em dúvida chega ao ERP depois da recusa; a janela de assentamento passa e a mensagem volta.
    world.clock.advance(60_000);
    await settle();
    await world.sim.script.drain();
    expect(await invoices(order.orderId)).toBe(1);
    await seedRefusal(
      suite.pool,
      order.orderId,
      'erp_rejected',
      PAST_WINDOW_SECONDS,
    );
    await makeClaimable(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(world.transport.sendsOf('findOrder')).toHaveLength(2);
    expect(
      world.transport.sendsOf('createOrder'),
      'as duas criações de antes, nenhuma nova',
    ).toHaveLength(2);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it.each(REASONS)(
    'ORD-27 depois da janela, sem fatura no ERP, o pedido termina failed com o motivo %s gravado, a reserva é liberada e a criação não sai de novo',
    async (reason) => {
      const { world, order } = await pollAfterRefusal(
        reason,
        PAST_WINDOW_SECONDS,
      );

      expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
      expect(
        world.transport.sendsOf('createOrder'),
        'com a recusa gravada, nunca cria de novo',
      ).toHaveLength(0);
      await expectFailedAndClosed(world, order, reason);
    },
  );

  it('ORD-27 a consulta que falha depois da recusa segue o retry normal (causa transient): não conclui, não cria e a recusa continua gravada', async () => {
    const { world, order, logs } = await pollAfterRefusal(
      'erp_rejected',
      PAST_WINDOW_SECONDS,
      { mode: 'unavailable' },
    );

    await expectOnlyLookedUp(world, order);
    expect((await readRefusal(suite.pool, order.orderId)).reason).toBe(
      'erp_rejected',
    );
    // O retry normal: o atraso mínimo mais o jitter, e não a janela de assentamento.
    const hidden = visibilityOf(world, order);
    expect(hidden.count).toBe(1);
    expect(hidden.seconds).toBeGreaterThanOrEqual(
      MIN_RETRY_DELAY_MS / 1000 - 1,
    );
    expect(hidden.seconds).toBeLessThan(SETTLE_WINDOW_SECONDS / 3);
    const retries = logs.eventsOf(
      'casecellshop.outbox.retry.scheduled',
      order.orderId,
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ level: 'warn', cause: 'transient' });
  });
});

describe('ORD-08 controle: a recusa no primeiro envio continua concluindo na hora', () => {
  it.each(REASONS)(
    'ORD-08 sem envio anterior, a recusa %s deixa o pedido failed na hora, sem gravar a recusa na outbox',
    async (reason) => {
      const { world, order } = await prepareOrder(reason);

      expect(await buildWorker(world).pollOnce()).toBe(1);

      expect(world.transport.sendsOf('createOrder')).toHaveLength(1);
      await expectFailedAndClosed(world, order, reason);
      expect(await readRefusal(suite.pool, order.orderId)).toEqual({
        reason: null,
        refusedAt: null,
      });
    },
  );
});
