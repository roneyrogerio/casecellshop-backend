import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import { assert, expect, onTestFinished, vi } from 'vitest';
import { CheckoutAccepted } from '../../src/contract/index.ts';
import { createErpClient } from '../../src/erp/acl.ts';
import type { ErpClient } from '../../src/erp/erp-client.ts';
import { createSimulatedErp, type SimulatedErp } from '../../src/erp/sim/index.ts';
import type { ErpRequest, ErpResponse, ErpTransport } from '../../src/erp/transport.ts';
import type { Semaphore } from '../../src/outbox/semaphore.ts';
import { createTelemetry, type Telemetry } from '../../src/telemetry.ts';
import { createWorker, type Worker, type WorkerConfig } from '../../src/worker.ts';
import {
  APP_POOL_SIZE,
  checkoutBody,
  createAppPool,
  line,
  PATIENT_LIMITS,
  postCheckout,
  readInventory,
  seedProduct,
  startCheckoutHarness,
  type CheckoutHarness,
  type InventorySnapshot,
} from './checkout.ts';
import { createManualClock, type ManualClock } from './clock.ts';
import { startMigratedDatabase, type TestDatabase } from './database.ts';
import { ERP_TIMEOUT_MS, seedErpProduct } from './erp.ts';
import {
  countsOf,
  observeQueue,
  openBillingQueues,
  sendRaw,
  startElasticMq,
  type ObservedQueue,
  type OpenedQueues,
  type QueueCounts,
  type QueueOptions,
  type TestElasticMq,
} from './sqs.ts';

// ---------------------------------------------------------------- transporte medido

export interface ErpMatch {
  op?: ErpRequest['op'];
  reference?: string;
}

export interface StallOptions {
  // Chama o ERP simulado (que grava a fatura do comportamento da fila) e descarta a resposta;
  // `false` nem chega a chamá-lo. Padrão: chama.
  callErp?: boolean;
  // Quantas chamadas que casam ficam presas; `Infinity` prende todas.
  times?: number;
}

export interface Stall {
  // Resolve quando a chamada ao ERP simulado terminou (com resposta ou erro), mesmo presa para o worker.
  erpSettled: Promise<void>;
}

export interface InstrumentedTransport extends ErpTransport {
  readonly sends: readonly ErpRequest[];
  // Maior número de chamadas ao transporte em voo ao mesmo tempo.
  readonly maxInFlight: number;
  sendsOf(op: ErpRequest['op']): ErpRequest[];
  // Resolve quando o total de chamadas (do `op`, se dado) chega a `count`. A chamada ao simulado já foi
  // iniciada, então os timers do roteiro já estão armados no relógio manual.
  waitForSends(count: number, op?: ErpRequest['op']): Promise<void>;
  // Prende a(s) próxima(s) chamada(s) que casam: o worker que a fez nunca recebe a resposta, como
  // um processo que morreu no meio da chamada.
  stall(match?: ErpMatch, options?: StallOptions): Stall;
  // Roda `hook` depois de o ERP simulado responder e antes de a resposta voltar ao worker.
  afterErp(match: ErpMatch, hook: (request: ErpRequest) => Promise<void>, times?: number): void;
}

interface Rule<T> {
  match: ErpMatch;
  remaining: number;
  payload: T;
}

function referenceOf(request: ErpRequest): string | undefined {
  if (request.op === 'createOrder') return request.body.reference;
  if (request.op === 'findOrder') return request.reference;
  return undefined;
}

function matches(match: ErpMatch, request: ErpRequest): boolean {
  return (match.op === undefined || match.op === request.op) && (match.reference === undefined || match.reference === referenceOf(request));
}

function take<T>(rules: Rule<T>[], request: ErpRequest): T | undefined {
  const rule = rules.find((candidate) => candidate.remaining > 0 && matches(candidate.match, request));
  if (!rule) return undefined;
  rule.remaining -= 1;
  return rule.payload;
}

// Embrulha o transporte do ERP simulado: registra as chamadas, mede as que estão em voo e deixa o teste
// prender uma resposta (a morte do worker) ou atrasá-la até um ponto controlado.
export function instrumentTransport(inner: ErpTransport): InstrumentedTransport {
  const sends: ErpRequest[] = [];
  const waiters: { count: number; op: ErpRequest['op'] | undefined; resolve: () => void }[] = [];
  const stalls: Rule<{ callErp: boolean; settle: () => void }>[] = [];
  const hooks: Rule<(request: ErpRequest) => Promise<void>>[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  function countOf(op: ErpRequest['op'] | undefined): number {
    return op === undefined ? sends.length : sends.filter((request) => request.op === op).length;
  }

  function flushWaiters(): void {
    for (const waiter of waiters.splice(0)) {
      if (countOf(waiter.op) >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  }

  async function finish(call: Promise<ErpResponse>, request: ErpRequest, hook: ((request: ErpRequest) => Promise<void>) | undefined) {
    try {
      let response: ErpResponse;
      try {
        response = await call;
      } catch (error) {
        // O gancho roda também quando o simulado lança (ex.: `unavailable`): é o que o teste espera ao
        // agir entre a resposta do ERP e a volta ao worker, com ou sem resposta.
        if (hook) await hook(request);
        throw error;
      }
      if (hook) await hook(request);
      return response;
    } finally {
      inFlight -= 1;
    }
  }

  return {
    get sends() {
      return sends;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    sendsOf(op) {
      return sends.filter((request) => request.op === op);
    },
    waitForSends(count, op) {
      return new Promise<void>((resolve) => {
        waiters.push({ count, op, resolve });
        flushWaiters();
      });
    },
    stall(match = {}, options = {}) {
      let settle!: () => void;
      const erpSettled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      stalls.push({
        match,
        remaining: options.times ?? 1,
        payload: { callErp: options.callErp ?? true, settle },
      });
      return { erpSettled };
    },
    afterErp(match, hook, times = 1) {
      hooks.push({ match, remaining: times, payload: hook });
    },
    send(request, signal) {
      sends.push(request);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const stall = take(stalls, request);
      const hook = take(hooks, request);
      // A chamada ao simulado sai antes de acordar quem espera: os timers do roteiro já estão armados.
      const call = stall?.callErp === false ? undefined : inner.send(request, signal);
      flushWaiters();
      if (stall) {
        void (call?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve()).then(stall.settle);
        return new Promise<ErpResponse>(() => undefined);
      }
      if (!call) throw new Error('chamada sem ERP simulado fora de um stall');
      return finish(call, request, hook);
    },
  };
}

// Portão de uma fila de respostas: cada `park()` espera o teste liberar, sem sleep.
export interface Gate {
  park(): Promise<void>;
  waitForParked(count: number): Promise<void>;
  release(index: number): void;
  releaseAll(): void;
}

export function createGate(): Gate {
  const parked: (() => void)[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    park() {
      return new Promise<void>((resolve) => {
        parked.push(resolve);
        for (const waiter of waiters.splice(0)) {
          if (parked.length >= waiter.count) waiter.resolve();
          else waiters.push(waiter);
        }
      });
    },
    waitForParked(count) {
      return new Promise<void>((resolve) => {
        if (parked.length >= count) resolve();
        else waiters.push({ count, resolve });
      });
    },
    release(index) {
      parked[index]?.();
    },
    releaseAll() {
      for (const resolve of parked) resolve();
    },
  };
}

// ---------------------------------------------------------------- mundo do ERP e do worker

export interface ErpWorld {
  clock: ManualClock;
  sim: SimulatedErp;
  transport: InstrumentedTransport;
  // A camada anticorrupção sobre o transporte medido do ERP simulado, tudo no relógio manual.
  erp: ErpClient;
}

export function createErpWorld(erpPool: pg.Pool, options: { withoutH1b?: boolean; telemetry?: Telemetry } = {}): ErpWorld {
  const clock = createManualClock();
  const sim = createSimulatedErp(options.withoutH1b === undefined ? { pool: erpPool, clock } : { pool: erpPool, clock, withoutH1b: options.withoutH1b });
  const transport = instrumentTransport(sim.transport);
  // Com a telemetria, a camada anticorrupção produz as métricas do ERP (OBS-02, M3); os spans da tentativa são do worker, não dela.
  const erp = createErpClient({ transport, clock, timeoutMs: ERP_TIMEOUT_MS, ...(options.telemetry ? { telemetry: options.telemetry } : {}) });
  return { clock, sim, transport, erp };
}

export interface WorkerSuite {
  database: TestDatabase;
  checkout: CheckoutHarness;
  // Pool do worker como em produção: 10 conexões, lock_timeout de 2 s e statement_timeout de 5 s.
  pool: pg.Pool;
  telemetry: Telemetry;
  // Um ElasticMQ por arquivo de teste; cada teste cria as filas dele (createWorld).
  emq: TestElasticMq;
  // Fecha o que cada teste abriu (os clientes do SQS): chamado no afterEach.
  releaseWorlds(): void;
  stop(): Promise<void>;
}

// Quem fecha as filas de cada mundo; fora da interface pública da suíte.
const cleanupsOf = new WeakMap<WorkerSuite, (() => void)[]>();

// PostgreSQL real, o app do checkout (pedidos nascem como em produção), o pool do worker e o ElasticMQ.
export async function startWorkerSuite(): Promise<WorkerSuite> {
  const [database, emq] = await Promise.all([startMigratedDatabase(), startElasticMq()]);
  const checkout = await startCheckoutHarness(database, APP_POOL_SIZE, PATIENT_LIMITS);
  const pool = createAppPool(database.uri, 10);
  const telemetry = createTelemetry({ spanExporter: new InMemorySpanExporter() });
  const cleanups: (() => void)[] = [];
  const suite: WorkerSuite = {
    database,
    checkout,
    pool,
    telemetry,
    emq,
    releaseWorlds() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    async stop() {
      suite.releaseWorlds();
      await pool.end();
      await telemetry.shutdown();
      await checkout.close();
      await emq.stop();
      await database.stop();
    },
  };
  cleanupsOf.set(suite, cleanups);
  return suite;
}

// ---------------------------------------------------------------- mundo de um teste: ERP, filas e relógio

export interface QueueWorld extends ErpWorld {
  // Pool do worker (o mesmo da suíte): o teste lê e semeia o banco por ele.
  pool: pg.Pool;
  telemetry: Telemetry;
  emq: TestElasticMq;
  // As filas reais deste teste (nome único), com a DLQ.
  queues: OpenedQueues;
  // A porta que o worker usa: a fila real embrulhada para registrar e, se o teste pedir, falhar.
  queue: ObservedQueue;
}

export interface WorldOptions extends QueueOptions {
  withoutH1b?: boolean;
  // Telemetria própria do cenário (ERP e worker): os contadores começam do zero.
  telemetry?: Telemetry;
}

// ERP simulado no relógio manual e filas novas no ElasticMQ, com a mesma redrive policy do
// elasticmq.conf (o limite de recebimentos pode ser menor no teste).
export async function createWorld(suite: WorkerSuite, options: WorldOptions = {}): Promise<QueueWorld> {
  const erpWorld = createErpWorld(suite.database.erpPool, {
    ...(options.withoutH1b === undefined ? {} : { withoutH1b: options.withoutH1b }),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });
  const queues = await openBillingQueues(suite.emq, {
    ...(options.maxReceiveCount === undefined ? {} : { maxReceiveCount: options.maxReceiveCount }),
    ...(options.visibilitySeconds === undefined ? {} : { visibilitySeconds: options.visibilitySeconds }),
  });
  cleanupsOf.get(suite)?.push(() => queues.close());
  return {
    ...erpWorld,
    pool: suite.pool,
    telemetry: options.telemetry ?? suite.telemetry,
    emq: suite.emq,
    queues,
    queue: observeQueue(queues.queue),
  };
}

export interface BuildWorkerOptions {
  pool?: pg.Pool;
  telemetry?: Telemetry;
  config?: Partial<WorkerConfig>;
  random?: () => number;
  // Padrão: silencioso. Os testes de log passam o logger que captura as linhas.
  logger?: Logger;
  semaphore?: Semaphore;
  erp?: ErpClient;
}

// Sem long polling por padrão: com a fila vazia o pollOnce responde na hora. Os testes do start()
// pedem o de 1 s, o do design, para o laço não girar sem parar.
export const TEST_WORKER_CONFIG: Partial<WorkerConfig> = { receiveWaitSeconds: 0 };

// Um worker novo, como um processo novo: semáforo próprio, mesmo ERP, mesmo relógio e a mesma fila.
export function buildWorker(world: QueueWorld, options: BuildWorkerOptions = {}): Worker {
  const worker = createWorker({
    pool: options.pool ?? world.pool,
    queue: world.queue,
    erp: options.erp ?? world.erp,
    logger: options.logger ?? pino({ level: 'silent' }),
    telemetry: options.telemetry ?? world.telemetry,
    clock: world.clock,
    random: options.random ?? (() => 0.5),
    ...(options.semaphore ? { semaphore: options.semaphore } : {}),
    config: { ...TEST_WORKER_CONFIG, ...options.config },
  });
  // Toda rodada recebe do SQS: a fila é a fonte das mensagens (AD-021). Sem esta conferência, um worker que
  // ainda lesse a tabela da outbox passaria os testes que só olham o banco e o ERP.
  return {
    start: () => worker.start(),
    stop: () => worker.stop(),
    async pollOnce() {
      const before = world.queue.receives.length;
      const received = await worker.pollOnce();
      expect(world.queue.receives.length, 'a rodada pediu mensagens ao SQS').toBeGreaterThan(before);
      return received;
    },
  };
}

// ---------------------------------------------------------------- rodadas

export interface PollHandle {
  readonly settled: boolean;
  result: Promise<number>;
  // Rejeita se a rodada rejeitar; nunca resolve. Evita que o teste espere para sempre por algo que
  // a rodada, já caída, nunca fará.
  failed: Promise<never>;
  until<T>(wait: Promise<T>): Promise<T>;
}

// Prazo, em tempo real, para o que o teste espera do worker: sem ele, um comportamento que falta viraria um
// teste pendurado até o timeout do vitest, em vez de uma falha de asserção que diz o que não aconteceu.
export const WAIT_GUARD_MS = 20_000;

export async function within<T>(wait: Promise<T>, what: string, ms: number = WAIT_GUARD_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const message = `passaram ${ms} ms e ainda falta: ${what}`;
      // A falha é uma AssertionError, como qualquer outra asserção do teste.
      let failure = new Error(message);
      try {
        assert.fail(message);
      } catch (error) {
        if (error instanceof Error) failure = error;
      }
      reject(failure);
    }, ms);
  });
  try {
    return await Promise.race([wait, guard]);
  } finally {
    clearTimeout(timer);
  }
}

// Inicia uma rodada sem esperá-la: a morte do worker é uma rodada abandonada no meio da chamada.
export function startPoll(worker: Worker): PollHandle {
  const state = { settled: false };
  const result = worker.pollOnce();
  const failed = new Promise<never>((_resolve, reject) => {
    result.catch(reject);
  });
  failed.catch(() => undefined);
  result.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return {
    get settled() {
      return state.settled;
    },
    result,
    failed,
    until(wait) {
      return within(Promise.race([wait, failed]), 'o estado que o teste espera do worker');
    },
  };
}

// Espera um estado do banco (consulta em intervalo, sem sleep fixo) ou a queda da rodada.
export function untilState(poll: PollHandle, check: () => Promise<void>): Promise<void> {
  return poll.until(vi.waitFor(check, { timeout: 20_000, interval: 25 }));
}

// O laço do start() só termina quando o stop() resolve; o teste avança o relógio manual enquanto espera,
// para nenhum timer do processo (o timeout de uma chamada presa, um intervalo) segurar o encerramento.
export async function stopAdvancing(worker: Worker, world: ErpWorld): Promise<void> {
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await vi.waitFor(
    () => {
      world.clock.advance(500);
      expect(stopped, 'o stop() ainda espera o laço ou uma tentativa').toBe(true);
    },
    { timeout: 20_000, interval: 20 },
  );
  await stopping;
}

// ---------------------------------------------------------------- dados

export interface AcceptedOrder {
  orderId: string;
  // O X-Request-Id da resposta do checkout: o correlationId gravado na outbox.
  requestId: string;
  sku: string;
  quantity: number;
  priceCents: number;
  onHand: number;
}

// Pedido aceito pelo próprio checkout: a outbox, o pedido, os itens e a reserva nascem como em
// produção. O mesmo SKU entra no erp_sim com estoque (por padrão, de sobra).
export async function acceptOrder(
  suite: WorkerSuite,
  options: { quantity?: number; onHand?: number; erpOnHand?: number; priceCents?: number; requestId?: string } = {},
): Promise<AcceptedOrder> {
  const quantity = options.quantity ?? 1;
  const onHand = options.onHand ?? 10;
  const priceCents = options.priceCents ?? 4990;
  const product = await seedProduct(suite.database.pool, { priceCents, onHand });
  await seedErpProduct(suite.database.pool, { sku: product.sku, priceCents, onHand: options.erpOnHand ?? onHand + 100 });
  const res = await postCheckout(suite.checkout.server, checkoutBody(line(product, quantity)), options.requestId === undefined ? {} : { requestId: options.requestId });
  expect(res.status).toBe(202);
  const { orderId } = CheckoutAccepted.parse(res.body);
  return { orderId, requestId: String(res.headers['x-request-id']), sku: product.sku, quantity, priceCents, onHand };
}

// O que a outbox guarda depois do SQS (AD-021, AD-024): a marca de publicação e o estado por pedido
// que a fila não tem. Nada daqui depende das colunas da fila na tabela, que a migração tira.
export interface OutboxRow {
  publishedAt: Date | null;
  firstSentAt: Date | null;
  lastCallAt: Date | null;
  callToken: string | null;
  deadAt: Date | null;
  // Idade do início da última chamada pelo relógio do banco, o mesmo que a grava; null sem chamada.
  sinceLastCallMs: number | null;
}

export async function readOutbox(pool: pg.Pool, orderId: string): Promise<OutboxRow> {
  const result = await pool.query<{
    published_at: Date | null;
    first_sent_at: Date | null;
    last_call_at: Date | null;
    call_token: string | null;
    dead_at: Date | null;
    since_last_call_ms: number | null;
  }>(
    `select published_at, first_sent_at, last_call_at, call_token, dead_at,
            (extract(epoch from (now() - last_call_at)) * 1000)::float8 as since_last_call_ms
       from outbox where order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return {
    publishedAt: row.published_at,
    firstSentAt: row.first_sent_at,
    lastCallAt: row.last_call_at,
    callToken: row.call_token,
    deadAt: row.dead_at,
    sinceLastCallMs: row.since_last_call_ms,
  };
}

export interface OrderRow {
  status: string;
  failureReason: string | null;
  outcomeAt: Date | null;
}

export async function readOrder(pool: pg.Pool, orderId: string): Promise<OrderRow> {
  const result = await pool.query<{ status: string; failure_reason: string | null; outcome_at: Date | null }>(
    'select status, failure_reason, outcome_at from orders where id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`pedido inexistente: ${orderId}`);
  return { status: row.status, failureReason: row.failure_reason, outcomeAt: row.outcome_at };
}

// ---------------------------------------------------------------- mensagens na fila

// A mensagem que o relay publicaria: corpo { orderId, correlationId } e o traceparent gravados na
// linha da outbox pelo checkout. Vai direto para a fila do teste (o relay tem os testes dele), e a
// linha fica marcada como publicada, como depois do relay. `times` > 1 é a entrega repetida.
export async function enqueue(world: QueueWorld, order: AcceptedOrder, options: { times?: number } = {}): Promise<void> {
  const result = await world.pool.query<{ traceparent: string | null; correlation_id: string }>(
    'select traceparent, correlation_id from outbox where order_id = $1',
    [order.orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${order.orderId}`);
  const body = JSON.stringify({ orderId: order.orderId, correlationId: row.correlation_id });
  const times = options.times ?? 1;
  const batch = Array.from({ length: times }, (_unused, index) => ({ id: `m${index}`, body, traceparent: row.traceparent }));
  const sent = await world.queues.queue.send(batch);
  expect(sent.failedIds).toEqual([]);
  await world.pool.query('update outbox set published_at = coalesce(published_at, now()) where order_id = $1', [order.orderId]);
}

export interface SubmitOptions {
  quantity?: number;
  onHand?: number;
  erpOnHand?: number;
  priceCents?: number;
  requestId?: string;
  times?: number;
}

// Checkout de verdade e a mensagem na fila deste teste.
export async function submitOrder(suite: WorkerSuite, world: QueueWorld, options: SubmitOptions = {}): Promise<AcceptedOrder> {
  const { times, ...acceptance } = options;
  const order = await acceptOrder(suite, acceptance);
  await enqueue(world, order, times === undefined ? {} : { times });
  return order;
}

// Mensagem que o worker não pode entender: entra na fila como qualquer outra.
export async function enqueueRaw(world: QueueWorld, body: string, traceparent?: string): Promise<void> {
  await sendRaw(world.emq, world.queues.queueUrl, body, traceparent);
}

// Devolve a mensagem do pedido à fila na hora (`ChangeMessageVisibility` com 0), como a visibilidade
// vencida, sem esperar o relógio do emulador. Vale para o último recebimento do pedido.
export async function releaseMessage(world: QueueWorld, orderId: string): Promise<void> {
  expect(await world.queues.queue.changeVisibility(world.queue.latestHandle(orderId), 0)).toBe('ok');
}

// O início da última chamada fica velho o bastante para o atraso mínimo (45 s) ter passado. Os prazos
// gravados correm no relógio do banco, então o teste os semeia em vez de esperar.
export async function ageLastCall(pool: pg.Pool, orderId: string, seconds = 46): Promise<void> {
  await pool.query("update outbox set last_call_at = now() - make_interval(secs => $2) where order_id = $1 and last_call_at is not null", [
    orderId,
    seconds,
  ]);
}

// A mensagem volta a ficar visível e o atraso mínimo está cumprido: a próxima tentativa pode chamar o ERP.
export async function makeClaimable(world: QueueWorld, orderId: string): Promise<void> {
  await ageLastCall(world.pool, orderId);
  await releaseMessage(world, orderId);
}

// Outro consumidor recebe a mensagem: o receipt handle do worker passa a ser antigo (`stale`).
export async function stealMessage(world: QueueWorld, orderId: string): Promise<void> {
  await releaseMessage(world, orderId);
  const taken = await world.queues.queue.receive({ max: 10, waitSeconds: 0, visibilitySeconds: 300 });
  expect(taken.length, 'o outro consumidor recebeu a mensagem').toBeGreaterThanOrEqual(1);
}

// A mensagem já foi enviada antes (first_sent_at preenchido), há tempo suficiente para o atraso
// mínimo: a próxima tentativa consulta o ERP pela referência antes de criar.
export async function markSentBefore(pool: pg.Pool, orderId: string): Promise<void> {
  await pool.query(
    `update outbox
        set first_sent_at = now() - interval '5 minutes',
            last_call_at = now() - interval '5 minutes'
      where order_id = $1`,
    [orderId],
  );
}

export interface QueueSnapshot {
  queue: QueueCounts;
  dlq: QueueCounts;
}

export async function snapshotQueues(world: QueueWorld): Promise<QueueSnapshot> {
  return { queue: await countsOf(world.emq, world.queues.queueUrl), dlq: await countsOf(world.emq, world.queues.dlqUrl) };
}

// A fila e a DLQ sem nenhuma mensagem, visível ou em voo: as visíveis sozinhas não veem a mensagem que um worker segura.
export async function expectQueuesEmpty(world: QueueWorld): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await snapshotQueues(world)).toEqual({ queue: { visible: 0, notVisible: 0 }, dlq: { visible: 0, notVisible: 0 } });
    },
    { timeout: 5_000, interval: 50 },
  );
}

// A mensagem do pedido segue na fila de origem, escondida (em voo): nem apagada nem na DLQ.
export async function expectOneInFlight(world: QueueWorld): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await snapshotQueues(world)).toEqual({ queue: { visible: 0, notVisible: 1 }, dlq: { visible: 0, notVisible: 0 } });
    },
    { timeout: 5_000, interval: 50 },
  );
}

// O SQS move a mensagem para a DLQ ao receber pela vez seguinte ao limite; a contagem chega pouco depois.
export async function waitForDlq(world: QueueWorld, count: number): Promise<void> {
  await vi.waitFor(async () => expect(await world.queues.dlq.approximateCount()).toBe(count), { timeout: 10_000, interval: 50 });
}

// A espera do retry que o design define para o `ChangeMessageVisibility`: atraso mínimo mais full
// jitter sobre um exponencial com teto, em segundos inteiros e arredondado para cima.
export function retrySeconds(options: { minDelayMs: number; baseMs: number; capMs: number; random: number; attempt: number }): number {
  const ceiling = Math.min(options.capMs, options.baseMs * 2 ** (options.attempt - 1));
  return Math.ceil((options.minDelayMs + options.random * ceiling) / 1000);
}

// ---------------------------------------------------------------- falha e atraso na fronteira do banco

export interface PoolRule {
  // Casa com o texto SQL do comando que o Kysely manda ao `pg`.
  match: RegExp;
  // Roda antes de o comando seguir: o teste avança o relógio manual no ponto exato, sem sleep.
  before?: (sql: string) => void | Promise<void>;
  // Faz o comando lançar este erro, sem chegar ao banco. Só falha; nunca devolve dado.
  fail?: () => Error;
  // Quantos comandos que casam sofrem o efeito; os outros passam (padrão: todos).
  times?: number;
}

export interface PoolProbe {
  pool: pg.Pool;
  // Comandos que casaram, tenham ou não sofrido o efeito: conta as transações tentadas.
  readonly matched: number;
  // Comandos em que o efeito (`before` ou `fail`) de fato disparou: o teste confere que a injeção aconteceu.
  readonly fired: number;
  // Liga e desliga a regra, para o cenário armar a falha só depois da chamada ao ERP.
  armed: boolean;
  // Devolve a cada cliente tocado o `query` original. Roda sozinho no fim do teste que instalou a regra.
  release(): void;
}

// Embrulha o pool do worker: a regra olha cada comando antes de ele seguir ao banco. O resto do caminho é o real.
// O `pg-pool` reaproveita o cliente mais recente e o pool do suite é de todos os testes do arquivo: por isso
// a regra é desfeita no fim do teste que a instalou (`onTestFinished`) e nunca vaza para o seguinte.
export function interceptPool(pool: pg.Pool, rule: PoolRule): PoolProbe {
  const patched = new WeakSet<object>();
  const restores: (() => void)[] = [];
  const state = { matched: 0, fired: 0, released: false };
  const probe: PoolProbe = {
    pool,
    armed: true,
    get matched() {
      return state.matched;
    },
    get fired() {
      return state.fired;
    },
    release() {
      state.released = true;
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
  onTestFinished(() => probe.release());
  probe.pool = new Proxy(pool, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'connect') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      return async () => {
        const client = await target.connect();
        if (!patched.has(client)) {
          patched.add(client);
          const raw = client as unknown as { query: (...args: unknown[]) => unknown };
          const previous = raw.query;
          const hadOwn = Object.hasOwn(raw, 'query');
          const original = previous.bind(client);
          const wrapper = async (...args: unknown[]) => {
            const first = args[0];
            const text = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
            if (!state.released && probe.armed && rule.match.test(text)) {
              state.matched += 1;
              if (state.fired < (rule.times ?? Infinity)) {
                state.fired += 1;
                await rule.before?.(text);
                if (rule.fail) throw rule.fail();
              }
            }
            return original(...args);
          };
          raw.query = wrapper;
          restores.push(() => {
            // Só desfaz se ninguém embrulhou por cima; senão `released` já deixa o embrulho passar direto.
            if (raw.query !== wrapper) return;
            if (hadOwn) raw.query = previous;
            else delete (raw as { query?: unknown }).query;
          });
        }
        return client;
      };
    },
  });
  return probe;
}

// O comando que grava o desfecho do pedido (a transição por compare-and-set): toda conclusão, de
// fatura ou de rejeição, começa por ele.
export const CONCLUSION_STATEMENT = /update\s+"orders"[\s\S]*"outcome_at"/i;
// O UPDATE que toma a permissão de chamada (o que preenche first_sent_at) e o que a renova pelo token.
export const TAKE_PERMIT_STATEMENT = /update\s+"outbox"[\s\S]*"first_sent_at"/i;

export interface LedgerExpectation {
  onHand: number;
  reserved: number;
  soldTotal: number;
}

// O desfecho feliz, visto de fora: pedido faturado, a reserva virando venda e a mensagem apagada, sem
// nada em voo nem na DLQ. `queueEmpty: false` é para o teste com mais de um pedido na mesma fila.
export async function expectInvoiced(world: QueueWorld, order: AcceptedOrder, options: { queueEmpty?: boolean } = {}): Promise<void> {
  const row = await readOrder(world.pool, order.orderId);
  expect(row.status).toBe('invoiced');
  expect(row.failureReason).toBeNull();
  expect(row.outcomeAt).not.toBeNull();
  const inventory = await readInventory(world.pool, order.sku);
  expect(ledgerViolations(inventory, { onHand: order.onHand - order.quantity, reserved: 0, soldTotal: order.quantity })).toEqual([]);
  if (options.queueEmpty ?? true) await expectQueuesEmpty(world);
}

// A invariante da baixa (ORD-17): lista o que difere do esperado, para o teste real exigir a lista
// vazia e o controle negativo exigir uma lista com itens.
export function ledgerViolations(actual: InventorySnapshot, expected: LedgerExpectation): string[] {
  const violations: string[] = [];
  if (actual.soldTotal !== expected.soldTotal) violations.push(`sold_total ${actual.soldTotal}, esperado ${expected.soldTotal}`);
  if (actual.reserved !== expected.reserved) violations.push(`reserved ${actual.reserved}, esperado ${expected.reserved}`);
  if (actual.onHand !== expected.onHand) violations.push(`on_hand ${actual.onHand}, esperado ${expected.onHand}`);
  return violations;
}
