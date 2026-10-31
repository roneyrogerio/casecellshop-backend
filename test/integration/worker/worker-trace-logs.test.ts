import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveServiceIdentity } from '../../../src/service-identity.ts';
import type { WorkerConfig } from '../../../src/worker.ts';
import { countInvoices } from '../../helpers/erp.ts';
import { captureLogs, type LogLine } from '../../helpers/logs.ts';
import {
  acceptOrder,
  buildWorker,
  cancelLeftoverMessages,
  createErpWorld,
  expectInvoiced,
  makeClaimable,
  readOutbox,
  startWorkerSuite,
  type AcceptedOrder,
  type ErpWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Trace e logs do worker (ORD-18, OBS-01 do M3): a tentativa continua o trace do checkout e cada log dela
// leva os campos do design.

let suite: WorkerSuite;

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 120_000);

afterAll(async () => {
  await suite?.stop();
});

beforeEach(async () => {
  await suite.checkout.telemetry.forceFlush();
  suite.checkout.exporter.reset();
});

afterEach(async () => {
  await cancelLeftoverMessages(suite.pool);
});

interface Recorded {
  traceId: string;
  spanId: string;
  correlationId: string;
}

// O traceparent e o correlationId que o checkout gravou na linha da outbox.
async function recordedContext(orderId: string): Promise<Recorded> {
  const result = await suite.pool.query<{ traceparent: string | null; correlation_id: string }>(
    'select traceparent, correlation_id from outbox where order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(row?.traceparent ?? '');
  expect(match, `traceparent gravado na outbox: ${String(row?.traceparent)}`).not.toBeNull();
  return { traceId: match?.[1] ?? '', spanId: match?.[2] ?? '', correlationId: row?.correlation_id ?? '' };
}

describe('ORD-18 o span da tentativa é filho do span do checkout', () => {
  it('ORD-18 a tentativa tem o traceId do checkout e é filha do span gravado no traceparent da outbox, com orderId e o número da tentativa', async () => {
    const { telemetry, exporter } = suite.checkout;
    const order = await acceptOrder(suite);
    const recorded = await recordedContext(order.orderId);
    const world = createErpWorld(suite.database.erpPool, { telemetry });

    expect(await buildWorker(world, { pool: suite.pool, telemetry }).pollOnce()).toBe(1);
    await telemetry.forceFlush();

    const spans = exporter.getFinishedSpans();
    const checkout = spans.find((span) => span.name === 'POST /checkout' && span.spanContext().traceId === recorded.traceId);
    expect(checkout, 'span do checkout no trace gravado na outbox').toBeDefined();
    expect(
      spans.some((span) => span.spanContext().spanId === recorded.spanId),
      'o span gravado no traceparent existe no trace do checkout',
    ).toBe(true);

    const attempts = spans.filter((span) => span.attributes['orderId'] === order.orderId && span.parentSpanContext?.spanId === recorded.spanId);
    expect(attempts, 'um span de tentativa filho do span do traceparent').toHaveLength(1);
    const attempt = attempts[0];
    expect(attempt?.spanContext().traceId).toBe(checkout?.spanContext().traceId);
    expect(attempt?.attributes['attempt']).toBe(1);
  });

  it('ORD-18 cada tentativa é um span filho do mesmo span do checkout, com o número da tentativa: 1 e 2', async () => {
    const { telemetry, exporter } = suite.checkout;
    const order = await acceptOrder(suite);
    const recorded = await recordedContext(order.orderId);
    const world = createErpWorld(suite.database.erpPool, { telemetry });
    world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder', reference: order.orderId });
    const worker = buildWorker(world, { pool: suite.pool, telemetry });

    expect(await worker.pollOnce()).toBe(1);
    await makeClaimable(suite.pool, order.orderId);
    expect(await worker.pollOnce()).toBe(1);
    await telemetry.forceFlush();

    const attempts = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes['orderId'] === order.orderId && span.parentSpanContext?.spanId === recorded.spanId);
    expect(attempts.map((span) => Number(span.attributes['attempt'])).sort((a, b) => a - b)).toEqual([1, 2]);
    for (const span of attempts) expect(span.spanContext().traceId).toBe(recorded.traceId);
  });
});

const REQUIRED_FIELDS = ['time', 'level', 'service', 'msg', 'event', 'correlationId', 'trace_id', 'span_id'] as const;
// O corpo do pedido (itens, quantidades e preços) não entra em nenhum log do worker.
const BODY_MARKERS = ['"items"', '"body"', 'expectedUnitPrice', 'unitPriceCents', '"quantity"'];

function expectAttemptLine(line: LogLine, order: AcceptedOrder, recorded: Recorded, attempt: number): void {
  const label = `linha ${JSON.stringify(line)}`;
  for (const field of REQUIRED_FIELDS) expect(line[field], `${label}: falta ${field}`).toBeDefined();
  expect(line['time'], label).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  expect(['info', 'warn', 'error'], label).toContain(line['level']);
  expect(line['service'], label).toBe(resolveServiceIdentity('casecellshop-worker').service);
  expect(typeof line['msg'] === 'string' && line['msg'] !== '', label).toBe(true);
  expect(line['correlationId'], label).toBe(order.requestId);
  expect(line['correlationId'], label).toBe(recorded.correlationId);
  expect(line['trace_id'], label).toBe(recorded.traceId);
  expect(line['span_id'], label).toMatch(/^[0-9a-f]{16}$/);
  expect(line['orderId'], label).toBe(order.orderId);
  expect(line['attempt'], label).toBe(attempt);
  for (const marker of BODY_MARKERS) expect(JSON.stringify(line), label).not.toContain(marker);
}

interface Scenario {
  name: string;
  event: string;
  level: 'info' | 'warn' | 'error';
  extra: Record<string, unknown>;
  config?: Partial<WorkerConfig>;
  // Evento que não pode sair no cenário (a mensagem que vai para `dead` não volta à fila).
  absent?: string;
  script: (world: ErpWorld, orderId: string) => void;
}

const SCENARIOS: Scenario[] = [
  { name: 'faturado', event: 'order.invoiced', level: 'info', extra: {}, script: () => undefined },
  {
    name: 'retry por erro transitório do ERP',
    event: 'outbox.retry',
    level: 'warn',
    extra: { outcome: 'transient' },
    script: (world, orderId) => world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder', reference: orderId }),
  },
  {
    name: 'pedido falho por rejeição do ERP',
    event: 'order.failed',
    level: 'warn',
    extra: { reason: 'erp_rejected' },
    script: (world, orderId) => world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: orderId }),
  },
  {
    name: 'erro de configuração do ERP (401)',
    event: 'erp.config_error',
    level: 'warn',
    extra: { status: 401 },
    script: (world, orderId) => world.sim.script.enqueue({ mode: 'status', status: 401 }, { op: 'createOrder', reference: orderId }),
  },
  {
    name: 'mensagem na DLQ no limite de tentativas',
    event: 'outbox.dead',
    level: 'error',
    extra: {},
    config: { maxAttempts: 1 },
    absent: 'outbox.retry',
    script: (world, orderId) => world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder', reference: orderId }),
  },
];

describe('OBS-01 logs do worker', () => {
  it.each(SCENARIOS)(
    'OBS-01 $name: o log $event ($level) traz os campos obrigatórios, orderId, attempt e o correlationId da outbox, e nenhum log leva o corpo',
    async ({ event, level, extra, config, absent, script }) => {
      const logs = captureLogs();
      const order = await acceptOrder(suite, { requestId: `obs01-${randomUUID()}` });
      const recorded = await recordedContext(order.orderId);
      const world = createErpWorld(suite.database.erpPool);
      script(world, order.orderId);

      expect(
        await buildWorker(world, { pool: suite.pool, telemetry: suite.checkout.telemetry, logger: logs.logger, ...(config ? { config } : {}) }).pollOnce(),
      ).toBe(1);

      const lines = logs.ofOrder(order.orderId);
      const wanted = lines.filter((line) => line['event'] === event);
      expect(wanted, `evento ${event} entre ${JSON.stringify(lines.map((line) => line['event']))}`).toHaveLength(1);
      expect(wanted[0]?.['level']).toBe(level);
      expect(wanted[0]).toMatchObject(extra);
      expect(lines.filter((line) => line['event'] === (absent ?? 'nenhum.evento'))).toEqual([]);
      for (const line of lines) expectAttemptLine(line, order, recorded, 1);
    },
  );

  // Os dois eventos que a reivindicação decide, sem chamar o ERP, também levam o contexto da outbox.
  it('OBS-01 outbox.closed (pedido que já não estava pending) traz os campos obrigatórios, orderId, attempt e o correlationId do checkout', async () => {
    const logs = captureLogs();
    const order = await acceptOrder(suite, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    await suite.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);
    const world = createErpWorld(suite.database.erpPool);

    await buildWorker(world, { pool: suite.pool, telemetry: suite.checkout.telemetry, logger: logs.logger }).pollOnce();

    const lines = logs.eventsOf('outbox.closed', order.orderId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('info');
    expectAttemptLine(lines[0] ?? {}, order, recorded, (await readOutbox(suite.pool, order.orderId)).attempts);
    expect(world.transport.sends).toHaveLength(0);
  });

  it('OBS-01 outbox.dead do limite já gasto traz os campos obrigatórios, orderId, attempt e o correlationId do checkout', async () => {
    const maxAttempts = 3;
    const logs = captureLogs();
    const order = await acceptOrder(suite, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    await suite.pool.query('update outbox set attempts = $2 where order_id = $1', [order.orderId, maxAttempts]);
    await makeClaimable(suite.pool, order.orderId);
    const world = createErpWorld(suite.database.erpPool);

    await buildWorker(world, { pool: suite.pool, telemetry: suite.checkout.telemetry, logger: logs.logger, config: { maxAttempts } }).pollOnce();

    const row = await readOutbox(suite.pool, order.orderId);
    expect(row.status).toBe('dead');
    const lines = logs.eventsOf('outbox.dead', order.orderId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('error');
    expectAttemptLine(lines[0] ?? {}, order, recorded, row.attempts);
    expect(world.transport.sends).toHaveLength(0);
  });

  it('OBS-01 o retry por erro de configuração traz o outcome config_error, e o attempt acompanha a segunda tentativa', async () => {
    const logs = captureLogs();
    const order = await acceptOrder(suite, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    const world = createErpWorld(suite.database.erpPool);
    world.sim.script.enqueue({ mode: 'status', status: 400 }, { op: 'createOrder', reference: order.orderId });
    const worker = buildWorker(world, { pool: suite.pool, telemetry: suite.checkout.telemetry, logger: logs.logger });

    await worker.pollOnce();
    const retry = logs.eventsOf('outbox.retry', order.orderId);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ level: 'warn', outcome: 'config_error' });
    expect(logs.eventsOf('erp.config_error', order.orderId)[0]).toMatchObject({ level: 'warn', status: 400 });

    await makeClaimable(suite.pool, order.orderId);
    await worker.pollOnce();
    const invoiced = logs.eventsOf('order.invoiced', order.orderId);
    expect(invoiced).toHaveLength(1);
    expectAttemptLine(invoiced[0] ?? {}, order, recorded, 2);
  });

  it('OBS-01 os logs do worker usam o span da tentativa: o span_id é o do span exportado, filho do span do checkout', async () => {
    const { telemetry, exporter } = suite.checkout;
    const logs = captureLogs();
    const order = await acceptOrder(suite, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    const world = createErpWorld(suite.database.erpPool);

    await buildWorker(world, { pool: suite.pool, telemetry, logger: logs.logger }).pollOnce();
    await telemetry.forceFlush();

    const attempt = exporter.getFinishedSpans().find((span) => span.attributes['orderId'] === order.orderId && span.parentSpanContext?.spanId === recorded.spanId);
    expect(attempt, 'span da tentativa').toBeDefined();
    const invoiced = logs.eventsOf('order.invoiced', order.orderId);
    expect(invoiced).toHaveLength(1);
    expect(invoiced[0]?.['span_id']).toBe(attempt?.spanContext().spanId);
    expect(invoiced[0]?.['trace_id']).toBe(attempt?.spanContext().traceId);
  });
});

// Pool que falha, uma vez e só depois de armado, a consulta de guarda que o invólucro de transação faz
// antes do COMMIT, com o erro `25P02` que o PostgreSQL devolve numa transação abortada.
interface AbortSwitch {
  armed: boolean;
  fired: number;
}

function poolAbortingGuard(pool: pg.Pool, control: AbortSwitch): pg.Pool {
  const patched = new WeakSet<object>();
  return new Proxy(pool, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'connect') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      return async () => {
        const client = await target.connect();
        if (!patched.has(client)) {
          patched.add(client);
          const raw = client as unknown as { query: (...args: unknown[]) => unknown };
          const original = raw.query.bind(client);
          raw.query = (...args: unknown[]) => {
            const first = args[0];
            const text = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
            // O alias "guard" é o da consulta do invólucro; outro `select 1` não é a guarda.
            if (control.armed && /^\s*select\s+1\s+as\s+"guard"\s*$/i.test(text)) {
              control.armed = false;
              control.fired += 1;
              return Promise.reject(Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' }));
            }
            return original(...args);
          };
        }
        return client;
      };
    },
  });
}

describe('OBS-01 db.transaction_aborted também sai do worker', () => {
  it('OBS-01 uma conclusão cuja transação aborta antes do COMMIT grava o log error db.transaction_aborted com orderId, attempt e correlationId', async () => {
    const logs = captureLogs();
    const order = await acceptOrder(suite, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    const control: AbortSwitch = { armed: false, fired: 0 };
    const world = createErpWorld(suite.database.erpPool);
    // A reivindicação já terminou: só a conclusão, que vem depois da resposta do ERP, encontra a guarda armada.
    world.transport.afterErp({ op: 'createOrder', reference: order.orderId }, () => {
      control.armed = true;
      return Promise.resolve();
    });
    const worker = buildWorker(world, { pool: poolAbortingGuard(suite.pool, control), telemetry: suite.checkout.telemetry, logger: logs.logger });

    await worker.pollOnce();

    expect(control.fired, 'a guarda da conclusão foi falhada uma vez').toBe(1);
    const aborted = logs.eventsOf('db.transaction_aborted', order.orderId);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ level: 'error', orderId: order.orderId, attempt: 1, correlationId: recorded.correlationId });
    // A conclusão abortada não grava nada; a repetida fecha a mensagem, fatura o pedido e baixa o estoque uma vez só.
    expect(await countInvoices(suite.database.pool, order.orderId)).toBe(1);
    await expectInvoiced(suite.pool, order);
  });
});
