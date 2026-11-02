import { describe, expect, it } from 'vitest';
import type {
  LateCheck,
  LateCheckResult,
} from '../../../src/billing/late-check.ts';
import { createSemaphore } from '../../../src/shared/semaphore.ts';
import { settle } from '../../helpers/async.ts';
import { readInventory } from '../../helpers/checkout.ts';
import { driveClock } from '../../helpers/dlq.ts';
import { countInvoices, ERP_TIMEOUT_MS, orderFor } from '../../helpers/erp.ts';
import {
  buildLateCheck,
  LATE_CHECK_COMPLETED,
  LATE_INVOICE_DETECTED,
  markOthersChecked,
  PAST_WINDOW_SECONDS,
  readLateColumns,
  readLateInvoices,
  seedOutcome,
  seedSentState,
  spyErp,
  useTelemetryPerTest,
  WITHIN_WINDOW_SECONDS,
  type LateCheckOptions,
  type SeededOutcome,
  type SpiedErp,
} from '../../helpers/late-check.ts';
import { captureLogs, type CapturedLogs } from '../../helpers/logs.ts';
import {
  ageLastCall,
  buildWorker,
  createErpWorld,
  createWorld,
  interceptPool,
  makeClaimable,
  readOrder,
  readOutbox,
  startPoll,
  submitOrder,
  TAKE_PERMIT_STATEMENT,
  useWorkerSuite,
  type AcceptedOrder,
  type QueueWorld,
} from '../../helpers/worker.ts';

// Verificação tardia dos pedidos com envio em dúvida (AD-031; design.md, "Worker: verificação tardia"). Sem a H1b e
// com o ERP acima da H4, um pedido termina com duas faturas, ou `failed` com uma fatura que aparece depois. Os
// cenários do cancelado e do duplicado nascem pelo fluxo real do worker sobre o ERP simulado, no relógio manual; o
// que depende de outra fatia (o cancelamento, a recusa depois de dois envios) é semeado por SQL. O prazo da janela
// de assentamento corre no relógio do banco: o teste semeia `last_call_at` no passado em vez de esperar.

const suiteOf = useWorkerSuite();
const newTelemetry = useTelemetryPerTest();

// ERP simulado sem a H1b (cada criação vira uma fatura) e telemetria própria: os contadores começam do zero.
function newWorld(): Promise<QueueWorld> {
  return createWorld(suiteOf(), {
    withoutH1b: true,
    telemetry: newTelemetry(),
  });
}

function invoices(orderId: string): Promise<number> {
  return countInvoices(suiteOf().database.pool, orderId);
}

// ---------------------------------------------------------------- cenários pelo fluxo real do worker

// O worker manda a criação, o ERP fatura só aos 60 s (acima da H4) e a chamada estoura o timeout: o pedido
// segue `pending` com uma criação contada, e a fatura ainda não existe.
async function startUnansweredSend(
  world: QueueWorld,
  order: AcceptedOrder,
): Promise<void> {
  world.sim.script.enqueue(
    { mode: 'invoice_after', delayMs: 60_000 },
    { op: 'createOrder', reference: order.orderId },
  );
  const first = startPoll(buildWorker(world));
  await first.until(world.transport.waitForSends(1, 'createOrder'));
  world.clock.advance(ERP_TIMEOUT_MS);
  expect(await first.result).toBe(1);
  expect((await readOrder(world.pool, order.orderId)).status).toBe('pending');
  expect(await invoices(order.orderId)).toBe(0);
  expect((await readLateColumns(world.pool, order.orderId)).createCalls).toBe(
    1,
  );
}

// (a) O cancelamento depois de um envio sem resposta, e então a fatura chega ao ERP. O cancelamento é semeado por
// SQL, porque o `cancelOrder` novo é de outra fatia.
async function cancelledThenInvoiced(
  world: QueueWorld,
  lastCallAgoSeconds = PAST_WINDOW_SECONDS,
): Promise<AcceptedOrder> {
  const order = await submitOrder(suiteOf(), world);
  await startUnansweredSend(world, order);
  await seedOutcome(world.pool, order, {
    status: 'failed',
    reason: 'cancelled',
  });
  // Os 60 s da criação atrasada se completam no ERP (a chamada começou há 10 s no relógio manual).
  world.clock.advance(50_000);
  await settle();
  await world.sim.script.drain();
  expect(await invoices(order.orderId)).toBe(1);
  await ageLastCall(world.pool, order.orderId, lastCallAgoSeconds);
  return order;
}

// (b) Como o ORD-06 sem a H1b: a segunda tentativa não vê a fatura de 60 s, cria a dela, e a criação atrasada da
// primeira chamada gera a segunda fatura. O pedido fica `invoiced`, com duas criações contadas.
async function duplicatedByFlow(
  world: QueueWorld,
  lastCallAgoSeconds = PAST_WINDOW_SECONDS,
): Promise<AcceptedOrder> {
  const order = await submitOrder(suiteOf(), world);
  await startUnansweredSend(world, order);
  world.clock.advance(35_000);
  await settle();
  await makeClaimable(world, order.orderId);
  expect(await buildWorker(world).pollOnce()).toBe(1);
  world.clock.advance(15_000);
  await settle();
  await world.sim.script.drain();
  expect(await invoices(order.orderId)).toBe(2);
  expect((await readOrder(world.pool, order.orderId)).status).toBe('invoiced');
  expect((await readLateColumns(world.pool, order.orderId)).createCalls).toBe(
    2,
  );
  await ageLastCall(world.pool, order.orderId, lastCallAgoSeconds);
  return order;
}

// ---------------------------------------------------------------- cenários semeados

// O estado que o fluxo de outra fatia deixaria: o desfecho, as criações contadas, a última chamada velha e
// `invoices` faturas no ERP (sem a H1b, cada criação pela porta é uma fatura nova).
interface Seed {
  outcome?: SeededOutcome;
  createCalls: number;
  invoices: number;
  agoSeconds?: number;
}

const CANCELLED: Seed = {
  outcome: { status: 'failed', reason: 'cancelled' },
  createCalls: 1,
  invoices: 1,
};
// A recusa depois de um envio sem resposta só existe com o ORD-27.
const REFUSED_TWICE: Seed = {
  outcome: { status: 'failed', reason: 'erp_rejected' },
  createCalls: 2,
  invoices: 1,
};
const DUPLICATED: Seed = {
  outcome: { status: 'invoiced' },
  createCalls: 2,
  invoices: 2,
};
const SINGLE_INVOICE: Seed = { ...DUPLICATED, invoices: 1 };
const NOT_IN_ERP: Seed = { ...CANCELLED, invoices: 0 };

async function erpGetsInvoices(
  world: QueueWorld,
  order: AcceptedOrder,
  times: number,
): Promise<void> {
  const already = await invoices(order.orderId);
  for (let created = 0; created < times; created += 1) {
    const result = await world.erp.createOrder(
      orderFor(order.orderId, order.sku, order.quantity, order.priceCents),
    );
    expect(result.kind).toBe('ok');
  }
  expect(await invoices(order.orderId)).toBe(already + times);
}

async function seededOrder(
  world: QueueWorld,
  seed: Seed,
): Promise<AcceptedOrder> {
  const order = await submitOrder(suiteOf(), world);
  await seedSentState(world.pool, order.orderId, {
    createCalls: seed.createCalls,
    lastCallAgoSeconds: seed.agoSeconds ?? PAST_WINDOW_SECONDS,
  });
  if (seed.outcome) await seedOutcome(world.pool, order, seed.outcome);
  await erpGetsInvoices(world, order, seed.invoices);
  return order;
}

// ---------------------------------------------------------------- a verificação e o que se lê dela

interface Case {
  world: QueueWorld;
  order: AcceptedOrder;
  lateCheck: LateCheck;
  spy: SpiedErp;
  logs: CapturedLogs;
  // O pedido e o estoque antes da verificação: ela nunca os muda, o operador é quem decide corrigir.
  before: { order: unknown; inventory: unknown };
}

async function snapshotOf(world: QueueWorld, order: AcceptedOrder) {
  return {
    order: await readOrder(world.pool, order.orderId),
    inventory: await readInventory(world.pool, order.sku),
  };
}

// A verificação sobre o ERP do mundo, com as chamadas anotadas e o logger de captura. As outras linhas da outbox
// saem da frente, porque o banco é dos testes do arquivo e a verificação lê candidatos da tabela toda.
async function caseOf(
  world: QueueWorld,
  order: AcceptedOrder,
  options: LateCheckOptions = {},
): Promise<Case> {
  await markOthersChecked(world.pool, [order.orderId]);
  const spy = spyErp(world.erp);
  const logs = captureLogs();
  const lateCheck = buildLateCheck(world, {
    erp: spy.erp,
    logger: logs.logger,
    ...options,
  });
  return {
    world,
    order,
    lateCheck,
    spy,
    logs,
    before: await snapshotOf(world, order),
  };
}

async function seededCase(seed: Seed): Promise<Case> {
  const world = await newWorld();
  return caseOf(world, await seededOrder(world, seed));
}

async function expectRound(
  { lateCheck }: Case,
  expected: LateCheckResult,
): Promise<void> {
  expect(await lateCheck.checkOnce()).toEqual(expected);
}

function detections({ logs, order }: Case) {
  return logs.eventsOf(LATE_INVOICE_DETECTED, order.orderId);
}

// Achado gravado e anunciado uma vez: a marca durável com a causa, o log `error` com o `orderId` e a causa, e +1 no
// counter da causa, sem mais nada no da outra.
async function expectFinding(
  found: Case,
  cause: 'failed_order' | 'duplicate',
): Promise<void> {
  const { world, order } = found;
  const columns = await readLateColumns(world.pool, order.orderId);
  expect(columns.lateCheckedAt).not.toBeNull();
  expect(columns.lateFinding).toBe(cause);
  const logged = detections(found);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    level: 'error',
    event: LATE_INVOICE_DETECTED,
    orderId: order.orderId,
    correlationId: order.requestId,
    cause,
  });
  const counter = await readLateInvoices(world.telemetry);
  expect(counter.failedOrder ?? 0).toBe(cause === 'failed_order' ? 1 : 0);
  expect(counter.duplicate ?? 0).toBe(cause === 'duplicate' ? 1 : 0);
}

// Nada de achado anunciado: nem log, nem counter. A marca vem de fora, porque a consulta sem achado a grava.
async function expectNoAlert(found: Case): Promise<void> {
  expect(detections(found)).toEqual([]);
  const counter = await readLateInvoices(found.world.telemetry);
  expect(counter.failedOrder ?? 0).toBe(0);
  expect(counter.duplicate ?? 0).toBe(0);
}

// Nada gravado: nem a marca, nem o log, nem o counter. O pedido volta na rodada seguinte.
async function expectNothingRecorded(found: Case): Promise<void> {
  const columns = await readLateColumns(found.world.pool, found.order.orderId);
  expect(columns.lateCheckedAt).toBeNull();
  expect(columns.lateFinding).toBeNull();
  await expectNoAlert(found);
}

// Consultado e concluído sem achado: a marca gravada com a causa nula, e nenhum alerta.
async function expectCheckedWithoutFinding(found: Case): Promise<void> {
  const columns = await readLateColumns(found.world.pool, found.order.orderId);
  expect(columns.lateCheckedAt).not.toBeNull();
  expect(columns.lateFinding).toBeNull();
  await expectNoAlert(found);
}

async function expectUntouched(found: Case): Promise<void> {
  expect(await snapshotOf(found.world, found.order)).toEqual(found.before);
}

// ---------------------------------------------------------------- ORD-23

describe('ORD-23 verificação tardia: pedido falho que o ERP passou a ter', () => {
  it('ORD-23 o cancelado depois de um envio sem resposta, que o ERP passou a ter, é achado como failed_order na primeira rodada depois da janela, e a rodada seguinte não registra de novo', async () => {
    const world = await newWorld();
    const found = await caseOf(world, await cancelledThenInvoiced(world));
    const { order, spy, logs } = found;

    await expectRound(found, { checked: 1, found: 1 });

    await expectFinding(found, 'failed_order');
    // O pedido falho foi consultado pela referência (H1a), sem contar as faturas no banco do ERP.
    expect(spy.finds).toEqual([order.orderId]);
    expect(spy.counts).toEqual([]);
    await expectUntouched(found);
    // A consulta tomou a permissão de chamada (a última chamada é de agora), sem somar create_calls.
    expect(
      (await readOutbox(world.pool, order.orderId)).sinceLastCallMs ?? Infinity,
    ).toBeLessThan(10_000);
    expect((await readLateColumns(world.pool, order.orderId)).createCalls).toBe(
      1,
    );
    // Toda rodada termina com o resumo.
    expect(logs.eventsOf(LATE_CHECK_COMPLETED)).toHaveLength(1);
    expect(logs.eventsOf(LATE_CHECK_COMPLETED)[0]).toMatchObject({
      level: 'info',
      checked: 1,
      found: 1,
    });

    // A rodada seguinte não encontra candidato e não registra de novo.
    await expectRound(found, { checked: 0, found: 0 });
    await expectFinding(found, 'failed_order');
    expect(spy.finds).toEqual([order.orderId]);
    await expectUntouched(found);
  });

  it('ORD-23 o recusado depois de dois envios, que o ERP passou a ter, é achado como failed_order', async () => {
    const found = await seededCase(REFUSED_TWICE);

    await expectRound(found, { checked: 1, found: 1 });

    await expectFinding(found, 'failed_order');
    expect(found.spy.finds).toEqual([found.order.orderId]);
    await expectUntouched(found);
  });
});

// Duas verificações simultâneas (duas réplicas do worker) sobre o mesmo pedido: um log e +1 só. A marca é gravada
// por compare-and-set (`late_checked_at IS NULL`), então só uma das duas anuncia o achado.
const ROUNDS = 5;

async function concurrentRound(
  world: QueueWorld,
  seed: Seed,
): Promise<{ replicas: Case; found: number }> {
  const order = await seededOrder(world, seed);
  const replicas = await caseOf(world, order);
  // Duas instâncias, como dois processos: semáforo e verificação próprios, o mesmo banco e o mesmo ERP.
  const processes = [0, 1].map(() =>
    buildLateCheck(world, {
      logger: replicas.logs.logger,
      semaphore: createSemaphore(30),
    }),
  );
  const results = await Promise.all(
    processes.map((process) => process.checkOnce()),
  );
  return {
    replicas,
    found: results.reduce((total, result) => total + result.found, 0),
  };
}

// Rodadas em laço, com o banco e o ERP do mesmo mundo, e o invariante conferido no banco, no log e no counter.
async function expectOneAnnouncementPerOrder(
  seed: Seed,
  cause: 'failed_order' | 'duplicate',
): Promise<void> {
  const world = await newWorld();
  for (let round = 1; round <= ROUNDS; round += 1) {
    const { replicas, found } = await concurrentRound(world, seed);

    expect(found, `rodada ${round}: achados somados`).toBe(1);
    expect(detections(replicas), `rodada ${round}: logs`).toHaveLength(1);
    const columns = await readLateColumns(world.pool, replicas.order.orderId);
    expect(columns.lateFinding, `rodada ${round}: marca`).toBe(cause);
    const counter = await readLateInvoices(world.telemetry);
    expect(
      cause === 'failed_order' ? counter.failedOrder : counter.duplicate,
      `rodada ${round}: counter acumulado`,
    ).toBe(round);
  }
}

describe('ORD-23 duas verificações simultâneas não registram de novo', () => {
  it(`ORD-23 ${ROUNDS} rodadas de duas verificações em paralelo sobre o mesmo pedido falho: um log e +1 no counter por pedido`, async () => {
    await expectOneAnnouncementPerOrder(CANCELLED, 'failed_order');
  });

  // A versão ingênua lê a marca e grava depois, sem a condição `late_checked_at IS NULL` no mesmo UPDATE, com a
  // janela forçada entre ler e gravar: as duas anunciam o mesmo achado.
  it('ORD-23 controle negativo: duas verificações ingênuas (ler a marca e depois gravar, sem a condição no UPDATE) anunciam o achado duas vezes', async () => {
    const world = await newWorld();
    const order = await seededOrder(world, CANCELLED);
    let arrived = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });

    async function naiveMark(): Promise<boolean> {
      const read = await world.pool.query<{ unchecked: boolean }>(
        'select late_checked_at is null as unchecked from outbox where order_id = $1',
        [order.orderId],
      );
      arrived += 1;
      if (arrived === 2) open();
      await opened;
      if (!read.rows[0]?.unchecked) return false;
      await world.pool.query(
        "update outbox set late_checked_at = now(), late_finding = 'failed_order' where order_id = $1",
        [order.orderId],
      );
      return true;
    }

    const announced = await Promise.all([naiveMark(), naiveMark()]);

    expect(announced.filter(Boolean)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- ORD-24

describe('ORD-24 verificação tardia: fatura duplicada', () => {
  it('ORD-24 o pedido invoiced com duas faturas para a referência, contadas pela leitura do banco do ERP, é achado como duplicate, uma vez só, sem mudar o pedido nem o estoque', async () => {
    const world = await newWorld();
    const found = await caseOf(world, await duplicatedByFlow(world));
    const { order, spy } = found;

    await expectRound(found, { checked: 1, found: 1 });

    await expectFinding(found, 'duplicate');
    // Pedido faturado: conta as faturas pelo banco do ERP, em vez de consultar a API.
    expect(spy.counts).toEqual([order.orderId]);
    expect(spy.finds).toEqual([]);
    await expectUntouched(found);
    expect(await invoices(order.orderId)).toBe(2);

    await expectRound(found, { checked: 0, found: 0 });
    await expectFinding(found, 'duplicate');
    expect(spy.counts).toEqual([order.orderId]);
  });

  it('ORD-24 três faturas para a referência também são duplicate, e o achado é um só por pedido', async () => {
    const found = await seededCase({ ...DUPLICATED, invoices: 3 });

    await expectRound(found, { checked: 1, found: 1 });

    await expectFinding(found, 'duplicate');
  });

  it(`ORD-24 ${ROUNDS} rodadas de duas verificações em paralelo sobre o mesmo pedido duplicado: um log e +1 no counter por pedido`, async () => {
    await expectOneAnnouncementPerOrder(DUPLICATED, 'duplicate');
  });
});

// ---------------------------------------------------------------- ORD-25

interface NotCandidate {
  label: string;
  prepare: (world: QueueWorld) => Promise<AcceptedOrder>;
}

// Cada caso tem uma fatura a mais ou uma fatura de pedido falho esperando no ERP: uma verificação que consultasse
// o pedido a acharia, e só a regra dos candidatos a deixa quieta.
const NOT_CANDIDATES: NotCandidate[] = [
  {
    label: 'um envio só com resposta conclusiva (faturado)',
    async prepare(world) {
      const order = await submitOrder(suiteOf(), world);
      expect(await buildWorker(world).pollOnce()).toBe(1);
      expect((await readOrder(world.pool, order.orderId)).status).toBe(
        'invoiced',
      );
      expect(
        (await readLateColumns(world.pool, order.orderId)).createCalls,
      ).toBe(1);
      await erpGetsInvoices(world, order, 2);
      return order;
    },
  },
  {
    label: 'um envio só com recusa conclusiva (failed erp_rejected)',
    async prepare(world) {
      const order = await submitOrder(suiteOf(), world);
      world.sim.script.enqueue(
        { mode: 'reject' },
        { op: 'createOrder', reference: order.orderId },
      );
      expect(await buildWorker(world).pollOnce()).toBe(1);
      const row = await readOrder(world.pool, order.orderId);
      expect([row.status, row.failureReason]).toEqual([
        'failed',
        'erp_rejected',
      ]);
      expect(
        (await readLateColumns(world.pool, order.orderId)).createCalls,
      ).toBe(1);
      await erpGetsInvoices(world, order, 1);
      return order;
    },
  },
  {
    label: 'cancelado sem nenhum envio (create_calls 0)',
    prepare: (world) => seededOrder(world, { ...CANCELLED, createCalls: 0 }),
  },
  {
    label: 'pedido ainda pending com três envios (sem desfecho)',
    prepare: (world) => seededOrder(world, { createCalls: 3, invoices: 2 }),
  },
];

describe('ORD-25 controles negativos: o que não é consultado', () => {
  it.each(NOT_CANDIDATES)(
    'ORD-25 $label não é candidato: nenhuma chamada ao ERP pela verificação e a marca fica nula',
    async ({ prepare }) => {
      const world = await newWorld();
      const order = await prepare(world);
      await ageLastCall(world.pool, order.orderId, PAST_WINDOW_SECONDS);
      const found = await caseOf(world, order);
      const findsBefore = world.transport.sendsOf('findOrder').length;

      await expectRound(found, { checked: 0, found: 0 });

      expect(found.spy.finds).toEqual([]);
      expect(found.spy.counts).toEqual([]);
      expect(world.transport.sendsOf('findOrder')).toHaveLength(findsBefore);
      await expectNothingRecorded(found);
    },
  );

  it('ORD-25 um candidato dentro da janela de assentamento não é consultado, e a primeira rodada depois da janela o acha', async () => {
    const world = await newWorld();
    const found = await caseOf(
      world,
      await duplicatedByFlow(world, WITHIN_WINDOW_SECONDS),
    );

    await expectRound(found, { checked: 0, found: 0 });

    expect([found.spy.counts, found.spy.finds]).toEqual([[], []]);
    await expectNothingRecorded(found);

    // A janela vence (a última chamada fica velha pelo relógio do banco): a rodada seguinte já acha.
    await ageLastCall(world.pool, found.order.orderId, PAST_WINDOW_SECONDS);
    await expectRound(found, { checked: 1, found: 1 });
    await expectFinding(found, 'duplicate');
  });

  it('ORD-25 o candidato falho dentro da janela não toma a permissão de chamada nem consulta o ERP', async () => {
    const world = await newWorld();
    const found = await caseOf(
      world,
      await cancelledThenInvoiced(world, WITHIN_WINDOW_SECONDS),
    );
    const { lastCallAt } = await readOutbox(world.pool, found.order.orderId);

    await expectRound(found, { checked: 0, found: 0 });

    expect(found.spy.finds).toEqual([]);
    expect(
      (await readOutbox(world.pool, found.order.orderId)).lastCallAt,
    ).toEqual(lastCallAt);
    await expectNothingRecorded(found);
  });
});

describe('ORD-25 controles negativos: consulta sem achado', () => {
  it('ORD-25 o pedido falho que o ERP não tem grava a marca sem achado, sem log nem counter, e não é consultado de novo', async () => {
    const found = await seededCase(NOT_IN_ERP);

    await expectRound(found, { checked: 1, found: 0 });

    await expectCheckedWithoutFinding(found);
    expect(found.spy.finds).toEqual([found.order.orderId]);
    await expectUntouched(found);

    await expectRound(found, { checked: 0, found: 0 });
    expect(found.spy.finds).toEqual([found.order.orderId]);
  });

  it('ORD-25 o pedido invoiced com uma fatura só grava a marca sem achado, sem log nem counter, e não é contado de novo', async () => {
    const found = await seededCase(SINGLE_INVOICE);

    await expectRound(found, { checked: 1, found: 0 });

    await expectCheckedWithoutFinding(found);
    expect(found.spy.counts).toEqual([found.order.orderId]);
    await expectUntouched(found);

    await expectRound(found, { checked: 0, found: 0 });
    expect(found.spy.counts).toEqual([found.order.orderId]);
  });
});

describe('ORD-25 controles negativos: falha do ERP e falta da permissão de chamada', () => {
  it('ORD-25 a consulta do pedido falho que falha (transient) não grava a marca, e o pedido é consultado de novo na rodada seguinte', async () => {
    const found = await seededCase(CANCELLED);
    const { world, order, spy } = found;
    world.sim.script.enqueue(
      { mode: 'unavailable' },
      { op: 'findOrder', reference: order.orderId },
    );

    await expectRound(found, { checked: 0, found: 0 });

    expect(spy.finds).toEqual([order.orderId]);
    await expectNothingRecorded(found);

    // A consulta tomou a permissão de chamada, que reinicia a janela: passada a janela de novo, a rodada seguinte
    // consulta outra vez, e agora o ERP responde.
    await ageLastCall(world.pool, order.orderId, PAST_WINDOW_SECONDS);
    await expectRound(found, { checked: 1, found: 1 });
    expect(spy.finds).toEqual([order.orderId, order.orderId]);
    await expectFinding(found, 'failed_order');
  });

  it('ORD-25 a contagem do pedido invoiced que falha (transient) não grava a marca, e o pedido é contado de novo na rodada seguinte', async () => {
    const found = await seededCase(DUPLICATED);
    const { world, order, spy } = found;
    world.sim.script.enqueue(
      { mode: 'unavailable' },
      { op: 'countInvoices', reference: order.orderId },
    );

    await expectRound(found, { checked: 0, found: 0 });

    expect(spy.counts).toEqual([order.orderId]);
    await expectNothingRecorded(found);

    await expectRound(found, { checked: 1, found: 1 });
    expect(spy.counts).toEqual([order.orderId, order.orderId]);
    await expectFinding(found, 'duplicate');
  });

  it('ORD-25 a contagem que estoura o timeout do ERP (hang) também não grava a marca', async () => {
    const found = await seededCase(DUPLICATED);
    found.world.sim.script.enqueue(
      { mode: 'hang' },
      { op: 'countInvoices', reference: found.order.orderId },
    );

    const round = found.lateCheck.checkOnce();
    await driveClock(round, found.world);

    expect(await round).toEqual({ checked: 0, found: 0 });
    await expectNothingRecorded(found);
  });

  it('ORD-25 sem a permissão de chamada (outra tentativa chamou o ERP entre a escolha e a tomada) o pedido não é consultado, nada é gravado, e a rodada seguinte o acha', async () => {
    const world = await newWorld();
    const order = await cancelledThenInvoiced(world);
    // Outra instância toma a permissão de chamada do pedido logo antes do UPDATE da verificação.
    const probe = interceptPool(world.pool, {
      match: TAKE_PERMIT_STATEMENT,
      times: 1,
      before: async () => {
        await world.pool.query(
          'update outbox set last_call_at = now() where order_id = $1',
          [order.orderId],
        );
      },
    });
    const found = await caseOf({ ...world, pool: probe.pool }, order);

    await expectRound(found, { checked: 0, found: 0 });

    expect(probe.fired, 'a tomada concorrente disparou').toBe(1);
    expect(found.spy.finds).toEqual([]);
    await expectNothingRecorded(found);

    await ageLastCall(world.pool, order.orderId, PAST_WINDOW_SECONDS);
    await expectRound(found, { checked: 1, found: 1 });
    await expectFinding(found, 'failed_order');
  });
});

describe('ORD-25 depois do start(), o counter já existe com 0 para as duas causas', () => {
  it('ORD-25 o start() deixa casecellshop.order.late_invoices em 0 para failed_order e duplicate, e o stop() encerra o laço', async () => {
    const telemetry = newTelemetry();
    const erpWorld = createErpWorld(suiteOf().database.erpPool, { telemetry });
    const lateCheck = buildLateCheck({
      ...erpWorld,
      pool: suiteOf().pool,
      telemetry,
    });
    await markOthersChecked(suiteOf().pool, []);

    await lateCheck.start();

    expect(await readLateInvoices(telemetry)).toEqual({
      failedOrder: 0,
      duplicate: 0,
    });
    await driveClock(lateCheck.stop(), erpWorld);
  });
});
