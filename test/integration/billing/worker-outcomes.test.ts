import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readInventory } from '../../helpers/checkout.ts';
import { expectMatchesContract, findRoute } from '../../helpers/contract.ts';
import { countInvoices, ERP_TIMEOUT_MS, invoiceTotals, MIN_RETRY_DELAY_MS } from '../../helpers/erp.ts';
import { captureLogs } from '../../helpers/logs.ts';
import {
  ageLastCall,
  buildWorker,
  createWorld,
  expectInvoiced,
  expectOneInFlight,
  expectQueuesEmpty,
  interceptPool,
  ledgerViolations,
  makeClaimable,
  markSentBefore,
  readOrder,
  releaseMessage,
  snapshotQueues,
  startPoll,
  startWorkerSuite,
  submitOrder,
  TAKE_PERMIT_STATEMENT,
  untilState,
  waitForDlq,
  type AcceptedOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Desfechos do envio (ORD-08 a ORD-11) e o status do pedido depois do worker (ORD-19), pelo SQS.

let suite: WorkerSuite;
const statusRoute = findRoute('get', '/orders/{orderId}/status');

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
  ] as const)('ORD-08 %s: pedido failed com o motivo %s, reserva liberada, mensagem apagada do SQS e nenhuma fatura', async (label, reason) => {
    // A falta de estoque vem do estado do erp_sim, não do roteiro: o ERP tem 0 e a loja reservou 2.
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, { quantity: 2, onHand: 10, ...(reason === 'erp_out_of_stock' ? { erpOnHand: 0 } : {}) });
    if (reason === 'erp_rejected') world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: order.orderId });
    expect(await readInventory(suite.pool, order.sku), `${label}: a reserva nasce no checkout`).toMatchObject({ reserved: 2 });

    expect(await buildWorker(world).pollOnce()).toBe(1);

    const row = await readOrder(suite.pool, order.orderId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe(reason);
    expect(row.outcomeAt).not.toBeNull();
    // A mensagem é encerrada: apagada, sem voltar à fila por retry e sem ir para a DLQ.
    expect(world.queue.deletesOf(order.orderId).map((call) => call.result)).toEqual(['ok']);
    expect(world.queue.changesOf(order.orderId)).toEqual([]);
    await expectQueuesEmpty(world);
    await expectNothingSold(order, 0);
    expect(await invoices(order.orderId)).toBe(0);
  });
});

describe('ORD-09 404 na consulta', () => {
  it('ORD-09 o 404 com o corpo de pedido inexistente leva à criação: uma fatura e o pedido invoiced', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    await markSentBefore(suite.pool, order.orderId);

    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it.each([
    ['sem corpo', undefined],
    ['com outro corpo', { code: 'route_not_found' }],
  ])('ORD-09 o 404 %s é erro de configuração: não cria, o pedido segue pending e a mensagem volta ao SQS para nova tentativa', async (_label, body) => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    world.sim.script.enqueue({ mode: 'status', status: 404, ...(body === undefined ? {} : { body }) }, { op: 'findOrder', reference: order.orderId });
    await markSentBefore(suite.pool, order.orderId);

    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect(await invoices(order.orderId)).toBe(0);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect(world.queue.deletesOf(order.orderId)).toEqual([]);
    expect(world.queue.changesOf(order.orderId).map((call) => call.result)).toEqual(['ok']);
    await expectOneInFlight(world);
    await expectNothingSold(order, order.quantity);
  });
});

describe('ORD-10 400 e 401 do ERP não falham o pedido', () => {
  it.each([400, 401])('ORD-10 o %i na criação é transitório: pedido pending, mensagem de volta ao SQS depois do atraso mínimo e reserva mantida', async (status) => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, { quantity: 2 });
    world.sim.script.enqueue({ mode: 'status', status }, { op: 'createOrder', reference: order.orderId });

    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect(world.queue.deletesOf(order.orderId)).toEqual([]);
    const changes = world.queue.changesOf(order.orderId);
    expect(changes).toHaveLength(1);
    // A nova tentativa respeita o atraso mínimo contado do início da chamada: a mensagem fica escondida por ao menos ele.
    expect(changes[0]?.seconds ?? 0).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS / 1000 - 1);
    await expectOneInFlight(world);
    await expectNothingSold(order, 2);
    expect(await invoices(order.orderId)).toBe(0);
  });

  it('ORD-10 o 401 na consulta também é transitório: não cria, pedido pending e reserva mantida', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    world.sim.script.enqueue({ mode: 'status', status: 401 }, { op: 'findOrder', reference: order.orderId });
    await markSentBefore(suite.pool, order.orderId);

    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    expect(world.queue.changesOf(order.orderId)).toHaveLength(1);
    await expectNothingSold(order, order.quantity);
  });
});

describe('ORD-11 visibilidade da mensagem prestes a vencer', () => {
  // timeout (10 s) + folga (2 s) = 12 s: com menos prazo que isso pela frente, a tentativa desiste antes de chamar.
  async function expectGaveUpWithoutCalling(world: QueueWorld, order: AcceptedOrder): Promise<void> {
    expect(world.transport.sends).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect((await readOrder(suite.pool, order.orderId)).status).toBe('pending');
    // Sem resposta ao SQS: nem apagada, nem devolvida; ela volta sozinha quando a visibilidade vencer.
    expect(world.queue.deletes).toEqual([]);
    expect(world.queue.visibilityChanges).toEqual([]);
    await expectOneInFlight(world);
  }

  it.each([5, 11])('ORD-11 com a visibilidade de %i s, menor que timeout + folga, o worker não chama o ERP, não responde ao SQS e a mensagem volta depois', async (visibilitySeconds) => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);

    await buildWorker(world, { config: { visibilitySeconds } }).pollOnce();

    expect(world.queue.receives[0]?.visibilitySeconds).toBe(visibilitySeconds);
    await expectGaveUpWithoutCalling(world, order);

    // Vencida a visibilidade, outro worker, com a configuração normal, termina o envio.
    await makeClaimable(world, order.orderId);
    expect(await buildWorker(world).pollOnce()).toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it('ORD-11 o recebimento pede a visibilidade da configuração (60 s), e não a da fila, mesmo com a fila em 0', async () => {
    const world = await createWorld(suite, { visibilitySeconds: 0 });
    await submitOrder(suite, world);

    await buildWorker(world).pollOnce();

    expect(world.queue.receives[0]).toMatchObject({ visibilitySeconds: 60 });
    // Se o worker herdasse a visibilidade 0 da fila, a mensagem concluída ou adiada voltaria na hora.
    expect(world.queue.received).toHaveLength(1);
  });

  // O prazo da mensagem é o instante lido antes do recebimento mais 60 s, no relógio injetável: o recebimento
  // que demora (aqui, segundos no relógio manual) deixa menos prazo pela frente.
  it('ORD-11 se o relógio avança 49 s entre o recebimento e a chamada, restam 11 s (menos que timeout + 2 s) e o worker desiste sem chamar o ERP', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    world.queue.afterReceive(() => world.clock.advance(49_000));

    await buildWorker(world).pollOnce();

    await expectGaveUpWithoutCalling(world, order);
  });

  it('ORD-11 controle do prazo: se o relógio avança 47 s entre o recebimento e a chamada, restam 13 s e o worker chama o ERP e fatura', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    world.queue.afterReceive(() => world.clock.advance(47_000));

    await buildWorker(world).pollOnce();

    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it('ORD-11 o prazo é conferido antes de cada chamada: uma consulta lenta que gasta o prazo impede a criação', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    await markSentBefore(suite.pool, order.orderId);
    // Visibilidade de 20 s: a consulta de 9 s deixa 11 s, menos que timeout + 2 s, para a criação.
    world.sim.script.enqueue({ mode: 'slow', delayMs: 9_000 }, { op: 'findOrder', reference: order.orderId });
    const poll = startPoll(buildWorker(world, { config: { visibilitySeconds: 20 } }));

    await poll.until(world.transport.waitForSends(1, 'findOrder'));
    world.clock.advance(9_000);
    expect(await poll.result).toBe(1);

    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect(world.queue.deletes).toEqual([]);
    expect(world.queue.visibilityChanges).toEqual([]);
    await expectOneInFlight(world);
  });

  // A permissão de chamada vale 33 s (atraso mínimo − timeout − 2 s): depois disso outra tentativa do mesmo
  // pedido já pode tomá-la, e um processo que parou entre tomar a permissão e chamar chamaria junto com ela.
  it('ORD-11 se o processo para 34 s (relógio injetável) entre mandar o UPDATE da permissão e chamar, a permissão já passou de 33 s e o worker desiste sem chamar o ERP', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const probe = interceptPool(suite.pool, { match: TAKE_PERMIT_STATEMENT, before: () => world.clock.advance(34_000), times: 1 });

    await buildWorker(world, { pool: probe.pool }).pollOnce();

    expect(probe.fired, 'o UPDATE da permissão passou pelo pool injetado').toBe(1);
    await expectGaveUpWithoutCalling(world, order);
    // A permissão ficou tomada: a mensagem que volta é adiada até o atraso mínimo passar, e só depois o ERP é chamado.
    await releaseMessage(world, order.orderId);
    expect(await buildWorker(world).pollOnce()).toBe(1);
    expect(world.transport.sends).toHaveLength(0);
    await makeClaimable(world, order.orderId);
    expect(await buildWorker(world).pollOnce()).toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-11 controle da idade da permissão: se o processo para 32 s entre mandar o UPDATE e chamar, a permissão ainda vale e o worker chama o ERP e fatura', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const probe = interceptPool(suite.pool, { match: TAKE_PERMIT_STATEMENT, before: () => world.clock.advance(32_000), times: 1 });

    await buildWorker(world, { pool: probe.pool }).pollOnce();

    expect(probe.fired, 'o UPDATE da permissão passou pelo pool injetado').toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  // A leitura dos itens é uma consulta ao banco: se ficasse depois da permissão, ela poderia demorar entre a
  // última conferência de prazo e a chamada, e o ERP seria chamado com a permissão já velha (A14).
  const READ_ITEMS_OR_TAKE_PERMIT = /from\s+"order_items"|update\s+"outbox"[\s\S]*"first_sent_at"/i;

  it('ORD-11 os itens do pedido são lidos antes de tomar a permissão de chamada, e nenhuma consulta ao banco fica entre a tomada e a primeira chamada ao ERP', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    const statements: { kind: 'items' | 'permit'; erpCalls: number }[] = [];
    // Cada leitura de itens é anotada com as chamadas ao ERP já feitas: a primeira leitura sai antes de qualquer uma.
    const probe = interceptPool(suite.pool, {
      match: READ_ITEMS_OR_TAKE_PERMIT,
      before: (sql) => {
        statements.push({ kind: /first_sent_at/i.test(sql) ? 'permit' : 'items', erpCalls: world.transport.sends.length });
      },
    });

    await buildWorker(world, { pool: probe.pool }).pollOnce();

    const firstItems = statements.findIndex((statement) => statement.kind === 'items');
    const firstPermit = statements.findIndex((statement) => statement.kind === 'permit');
    expect(firstItems, 'o worker leu os itens do pedido').toBeGreaterThanOrEqual(0);
    expect(firstPermit, 'o worker tomou a permissão de chamada').toBeGreaterThanOrEqual(0);
    expect(firstItems, 'os itens são lidos antes da permissão').toBeLessThan(firstPermit);
    expect(statements[firstItems]?.erpCalls).toBe(0);
    expect(await invoices(order.orderId)).toBe(1);
  });

  it('ORD-11 uma leitura lenta dos itens (2 s) com a permissão tomada logo depois não envelhece a permissão: o ERP é chamado com ela a 32 s, nunca acima de 33 s', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    let permitSentAt: number | undefined;
    let calledAt: number | undefined;
    let itemReads = 0;
    const probe = interceptPool(suite.pool, {
      match: READ_ITEMS_OR_TAKE_PERMIT,
      before: (sql) => {
        if (/first_sent_at/i.test(sql)) {
          if (permitSentAt !== undefined) return;
          permitSentAt = world.clock.now();
          // O processo para 32 s entre mandar o UPDATE da permissão e chamar: ainda abaixo dos 33 s.
          world.clock.advance(32_000);
          return;
        }
        if (itemReads > 0) return;
        itemReads += 1;
        world.clock.advance(2_000);
      },
    });
    world.transport.afterErp({ op: 'createOrder', reference: order.orderId }, () => {
      calledAt = world.clock.now();
      return Promise.resolve();
    });

    await buildWorker(world, { pool: probe.pool }).pollOnce();

    expect(itemReads, 'a leitura lenta dos itens passou pelo pool injetado').toBe(1);
    expect(permitSentAt, 'a permissão passou pelo pool injetado').toBeDefined();
    expect(calledAt, 'o ERP foi chamado').toBeDefined();
    // A idade que importa é a da permissão no momento da chamada, e a leitura dos itens não conta nela.
    expect(Number(calledAt) - Number(permitSentAt)).toBeLessThanOrEqual(33_000);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  // A criação que vem depois da consulta regrava a permissão (a renovação) e precisa da mesma conferência
  // de idade imediatamente antes de sair: uma renovação lenta deixa a permissão nova já velha.
  const RENEW_PERMIT = /update\s+"outbox"\s+set\s+"last_call_at"/i;

  it('ORD-11 se o processo para 34 s entre mandar o UPDATE da renovação e criar, a permissão renovada passou de 33 s e o worker desiste sem criar', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    await markSentBefore(suite.pool, order.orderId);
    const logs = captureLogs();
    let renewals = 0;
    const probe = interceptPool(suite.pool, {
      match: RENEW_PERMIT,
      before: (sql) => {
        if (/first_sent_at/i.test(sql)) return;
        renewals += 1;
        world.clock.advance(34_000);
      },
    });

    await buildWorker(world, { pool: probe.pool, logger: logs.logger }).pollOnce();

    expect(renewals, 'o UPDATE da renovação passou pelo pool injetado').toBe(1);
    expect(world.transport.sendsOf('findOrder')).toHaveLength(1);
    expect(world.transport.sendsOf('createOrder')).toHaveLength(0);
    expect(await invoices(order.orderId)).toBe(0);
    expect(logs.eventsOf('outbox.lease_short', order.orderId)).toHaveLength(1);
    expect(world.queue.deletes).toEqual([]);
    expect(world.queue.visibilityChanges).toEqual([]);
    await expectOneInFlight(world);
  });

  it('ORD-11 controle da renovação: se o processo para 32 s entre o UPDATE da renovação e criar, a permissão ainda vale e o worker cria e fatura', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    await markSentBefore(suite.pool, order.orderId);
    let renewals = 0;
    const probe = interceptPool(suite.pool, {
      match: RENEW_PERMIT,
      before: (sql) => {
        if (/first_sent_at/i.test(sql)) return;
        renewals += 1;
        world.clock.advance(32_000);
      },
    });

    await buildWorker(world, { pool: probe.pool }).pollOnce();

    expect(renewals, 'o UPDATE da renovação passou pelo pool injetado').toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it('ORD-11 duas mensagens do mesmo pedido recebidas juntas não chamam o ERP ao mesmo tempo: a segunda é adiada pela permissão de chamada e depois apagada', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, { times: 2 });
    // A chamada da que ganhou a permissão fica em voo (5 s no relógio manual) enquanto a outra decide.
    world.sim.script.enqueue({ mode: 'slow', delayMs: 5_000 }, { op: 'createOrder', reference: order.orderId });
    const poll = startPoll(buildWorker(world));

    await poll.until(world.transport.waitForSends(1, 'createOrder'));
    await untilState(poll, () => {
      expect(world.queue.changesOf(order.orderId)).toHaveLength(1);
      return Promise.resolve();
    });
    expect(world.transport.sends, 'só uma chamada ao ERP enquanto a primeira está em voo').toHaveLength(1);
    const deferral = world.queue.changesOf(order.orderId)[0];
    expect(deferral?.result).toBe('ok');
    // Volta pelo tempo que falta do atraso mínimo mais 1 s.
    expect(deferral?.seconds ?? 0).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS / 1000 - 5);
    expect(deferral?.seconds ?? 0).toBeLessThanOrEqual(MIN_RETRY_DELAY_MS / 1000 + 2);

    world.clock.advance(5_000);
    expect(await poll.result).toBe(2);
    expect(world.transport.maxInFlight).toBe(1);
    expect(await invoices(order.orderId)).toBe(1);
    expect(world.queue.deletesOf(order.orderId)).toHaveLength(1);
    // A adiada segue escondida no SQS.
    await expectOneInFlight(world);

    // Passado o atraso mínimo, ela volta, encontra o pedido já faturado e é apagada sem chamar o ERP.
    await makeClaimable(world, order.orderId);
    expect(await buildWorker(world).pollOnce()).toBe(1);
    expect(world.transport.sends).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });

  it('ORD-11 uma mensagem adiada pela permissão volta com o atraso mínimo ainda por cumprir: o ERP só é chamado depois dele', async () => {
    const world = await createWorld(suite, { withoutH1b: true });
    const order = await submitOrder(suite, world);
    // Uma chamada recente de outra tentativa (semeada): a permissão está tomada.
    await markSentBefore(suite.pool, order.orderId);
    await ageLastCall(suite.pool, order.orderId, 10);
    const logs = captureLogs();

    expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(1);

    expect(world.transport.sends).toHaveLength(0);
    const [change] = world.queue.changesOf(order.orderId);
    // Faltam uns 35 s, mais 1 s.
    expect(change?.seconds ?? 0).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS / 1000 - 10 - 2);
    expect(change?.seconds ?? 0).toBeLessThanOrEqual(MIN_RETRY_DELAY_MS / 1000 - 10 + 3);
    expect(logs.eventsOf('outbox.call_deferred', order.orderId)).toHaveLength(1);
  });
});

describe('ORD-19 status do pedido depois do worker', () => {
  it('ORD-19 depois de faturar, o status devolve invoiced; antes, pending', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, { quantity: 2, priceCents: 1990 });
    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'pending' });

    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'invoiced' });
    // A fatura sai pelo preço aceito no checkout (H3).
    expect(await invoiceTotals(suite.database.pool, order.orderId)).toEqual([2 * 1990]);
    await expectQueuesEmpty(world);
  });

  it.each([
    ['erp_rejected', false],
    ['erp_out_of_stock', true],
  ] as const)('ORD-19 depois da rejeição permanente (%s), o status devolve failed com o motivo', async (reason, outOfStock) => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world, outOfStock ? { erpOnHand: 0 } : {});
    if (!outOfStock) world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: order.orderId });

    expect(await buildWorker(world).pollOnce()).toBe(1);

    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'failed', reason });
    await expectQueuesEmpty(world);
  });

  it('ORD-19 com a mensagem na DLQ do SQS, o status continua pending', async () => {
    const maxReceiveCount = 2;
    const world = await createWorld(suite, { maxReceiveCount });
    const order = await submitOrder(suite, world);
    world.sim.script.setDefault({ mode: 'unavailable' });
    const worker = buildWorker(world);

    // A DLQ vem do limite de recebimentos: cada rodada falha, e a mensagem volta à fila sem esperar a visibilidade.
    for (let round = 1; round <= maxReceiveCount; round += 1) {
      expect(await worker.pollOnce(), `recebimento ${round}`).toBe(1);
      await makeClaimable(world, order.orderId);
    }
    // O recebimento seguinte ao limite não devolve a mensagem: o SQS a move para a DLQ.
    expect(await worker.pollOnce()).toBe(0);
    await waitForDlq(world, 1);

    expect((await snapshotQueues(world)).queue).toEqual({ visible: 0, notVisible: 0 });
    expect(await getStatus(order.orderId)).toEqual({ orderId: order.orderId, status: 'pending' });
  });
});

describe('ORD-11 o intervalo entre as chamadas conta no relógio do banco, não no do processo', () => {
  it('ORD-11 avançar o relógio do processo não cumpre o atraso mínimo da H4: a permissão segue tomada', async () => {
    const world = await createWorld(suite);
    const order = await submitOrder(suite, world);
    world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder', reference: order.orderId });
    const worker = buildWorker(world);
    expect(await worker.pollOnce()).toBe(1);
    expect(world.transport.sends).toHaveLength(1);

    // O relógio injetável corre, mas o prazo gravado é do banco: a próxima tentativa continua adiada.
    world.clock.advance(ERP_TIMEOUT_MS * 10);
    await releaseMessage(world, order.orderId);
    expect(await worker.pollOnce()).toBe(1);

    expect(world.transport.sends).toHaveLength(1);
    expect(await invoices(order.orderId)).toBe(0);
  });
});
