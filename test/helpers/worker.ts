import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import { expect, vi } from 'vitest';
import { CheckoutAccepted } from '../../src/contract/index.ts';
import { createErpClient } from '../../src/erp/acl.ts';
import type { ErpClient } from '../../src/erp/erp-client.ts';
import { createSimulatedErp, type SimulatedErp } from '../../src/erp/sim/index.ts';
import type { ErpRequest, ErpResponse, ErpTransport } from '../../src/erp/transport.ts';
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
      const response = await call;
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
  stop(): Promise<void>;
}

// PostgreSQL real, o app do checkout (pedidos nascem como em produção) e o pool do worker.
export async function startWorkerSuite(): Promise<WorkerSuite> {
  const database = await startMigratedDatabase();
  const checkout = await startCheckoutHarness(database, APP_POOL_SIZE, PATIENT_LIMITS);
  const pool = createAppPool(database.uri, 10);
  const telemetry = createTelemetry({ spanExporter: new InMemorySpanExporter() });
  return {
    database,
    checkout,
    pool,
    telemetry,
    async stop() {
      await pool.end();
      await telemetry.shutdown();
      await checkout.close();
      await database.stop();
    },
  };
}

// Uma mensagem pendente que sobra de um teste seria reivindicada pelo pollOnce do teste seguinte,
// que divide o banco com ela. Cancelar a deixa fora da fila sem apagar o que o teste mostrou.
export async function cancelLeftoverMessages(pool: pg.Pool): Promise<void> {
  await pool.query("update outbox set status = 'cancelled' where status = 'pending'");
}

export interface BuildWorkerOptions {
  pool: pg.Pool;
  telemetry: Telemetry;
  config?: Partial<WorkerConfig>;
  random?: () => number;
  // Padrão: silencioso. Os testes de log passam o logger que captura as linhas.
  logger?: Logger;
}

// Um worker novo, como um processo novo: semáforo próprio, mesmo ERP e mesmo relógio.
export function buildWorker(world: ErpWorld, options: BuildWorkerOptions): Worker {
  return createWorker({
    pool: options.pool,
    erp: world.erp,
    logger: options.logger ?? pino({ level: 'silent' }),
    telemetry: options.telemetry,
    clock: world.clock,
    random: options.random ?? (() => 0.5),
    ...(options.config ? { config: options.config } : {}),
  });
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
      return Promise.race([wait, failed]);
    },
  };
}

// Espera um estado do banco (consulta em intervalo, sem sleep fixo) ou a queda da rodada.
export function untilState(poll: PollHandle, check: () => Promise<void>): Promise<void> {
  return poll.until(vi.waitFor(check, { timeout: 20_000, interval: 25 }));
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

export interface OutboxRow {
  status: string;
  attempts: number;
  leaseUntil: Date | null;
  claimToken: string | null;
  firstSentAt: Date | null;
  lastCallAt: Date | null;
  nextAttemptAt: Date;
  // Calculados pelo relógio do banco, o mesmo que grava os prazos.
  leased: boolean;
  scheduledInFuture: boolean;
}

export async function readOutbox(pool: pg.Pool, orderId: string): Promise<OutboxRow> {
  const result = await pool.query<{
    status: string;
    attempts: number;
    lease_until: Date | null;
    claim_token: string | null;
    first_sent_at: Date | null;
    last_call_at: Date | null;
    next_attempt_at: Date;
    leased: boolean;
    scheduled: boolean;
  }>(
    `select status, attempts, lease_until, claim_token, first_sent_at, last_call_at, next_attempt_at,
            (lease_until is not null and lease_until > now()) as leased,
            (next_attempt_at > now()) as scheduled
       from outbox where order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return {
    status: row.status,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    claimToken: row.claim_token,
    firstSentAt: row.first_sent_at,
    lastCallAt: row.last_call_at,
    nextAttemptAt: row.next_attempt_at,
    leased: row.leased,
    scheduledInFuture: row.scheduled,
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

// Mensagens com lease ativo entre as dos pedidos dados.
export async function countActiveLeases(pool: pg.Pool, orderIds: string[]): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "select count(*)::int as n from outbox where status = 'pending' and lease_until > now() and order_id = any($1::uuid[])",
    [orderIds],
  );
  return result.rows[0]?.n ?? 0;
}

// Deixa a mensagem reivindicável de novo sem esperar: o lease vence e o atraso mínimo (45 s desde
// a última chamada) está cumprido. Os prazos gravados correm no relógio do banco, então o teste os
// semeia em vez de esperar.
export async function makeClaimable(pool: pg.Pool, orderId: string): Promise<void> {
  await pool.query(
    `update outbox
        set lease_until = now() - interval '1 second',
            last_call_at = now() - interval '46 seconds',
            next_attempt_at = now() - interval '1 second'
      where order_id = $1 and status = 'pending'`,
    [orderId],
  );
}

// Só o lease vence: o atraso mínimo continua contando da última chamada real.
export async function expireLeaseOnly(pool: pg.Pool, orderId: string): Promise<void> {
  await pool.query("update outbox set lease_until = now() - interval '1 second' where order_id = $1", [orderId]);
}

// A mensagem já foi enviada antes (first_sent_at preenchido), há tempo suficiente para o atraso
// mínimo: a próxima tentativa consulta o ERP pela referência antes de criar.
export async function markSentBefore(pool: pg.Pool, orderId: string): Promise<void> {
  await pool.query(
    `update outbox
        set first_sent_at = now() - interval '5 minutes',
            last_call_at = now() - interval '5 minutes',
            attempts = 1
      where order_id = $1`,
    [orderId],
  );
}

// Espera do retry em ms: do início da última chamada ao `next_attempt_at` gravado.
export async function retryDelayMs(pool: pg.Pool, orderId: string): Promise<number> {
  const result = await pool.query<{ ms: number }>(
    'select (extract(epoch from (next_attempt_at - last_call_at)) * 1000)::float8 as ms from outbox where order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return row.ms;
}

export interface LedgerExpectation {
  onHand: number;
  reserved: number;
  soldTotal: number;
}

// O desfecho feliz, visto de fora: pedido faturado, mensagem encerrada e a reserva virando venda.
export async function expectInvoiced(pool: pg.Pool, order: AcceptedOrder): Promise<void> {
  const row = await readOrder(pool, order.orderId);
  expect(row.status).toBe('invoiced');
  expect(row.failureReason).toBeNull();
  expect(row.outcomeAt).not.toBeNull();
  expect((await readOutbox(pool, order.orderId)).status).toBe('done');
  const inventory = await readInventory(pool, order.sku);
  expect(ledgerViolations(inventory, { onHand: order.onHand - order.quantity, reserved: 0, soldTotal: order.quantity })).toEqual([]);
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
