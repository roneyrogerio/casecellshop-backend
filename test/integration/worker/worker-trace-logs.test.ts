import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErpClient } from '../../../src/erp/erp-client.ts';
import { resolveServiceIdentity } from '../../../src/service-identity.ts';
import type { WorkerConfig } from '../../../src/worker.ts';
import { countInvoices } from '../../helpers/erp.ts';
import { captureLogs, type LogLine } from '../../helpers/logs.ts';
import {
  ageLastCall,
  buildWorker,
  CONCLUSION_STATEMENT,
  createWorld,
  enqueueRaw,
  expectInvoiced,
  interceptPool,
  makeClaimable,
  markSentBefore,
  readOrder,
  startWorkerSuite,
  stealMessage,
  stopAdvancing,
  submitOrder,
  type AcceptedOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// Trace e logs do worker (ORD-18, OBS-01 do M3): a tentativa continua o trace do checkout, que vem no
// atributo `traceparent` da mensagem do SQS, e cada log dela leva os campos do design.

let suite: WorkerSuite;

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await suite?.stop();
});

beforeEach(async () => {
  await suite.checkout.telemetry.forceFlush();
  suite.checkout.exporter.reset();
});

afterEach(() => {
  suite.releaseWorlds();
});

interface Recorded {
  traceId: string;
  spanId: string;
  correlationId: string;
}

// O traceparent e o correlationId que o checkout gravou na linha da outbox (e o relay levou à mensagem).
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

// Mundo com a telemetria do checkout, para os spans da tentativa e os do checkout irem ao mesmo exportador.
function traceWorld(): Promise<QueueWorld> {
  return createWorld(suite, { telemetry: suite.checkout.telemetry });
}

describe('ORD-18 o span da tentativa é filho do span do checkout', () => {
  it('ORD-18 a tentativa tem o traceId do checkout e é filha do span levado no atributo traceparent da mensagem, com orderId e o número da tentativa', async () => {
    const { telemetry, exporter } = suite.checkout;
    const world = await traceWorld();
    const order = await submitOrder(suite, world);
    const recorded = await recordedContext(order.orderId);

    expect(await buildWorker(world).pollOnce()).toBe(1);
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
    expect(attempt?.name).toBe('outbox.attempt');
    expect(attempt?.spanContext().traceId).toBe(checkout?.spanContext().traceId);
    expect(attempt?.attributes['attempt']).toBe(1);
  });

  it('ORD-18 cada tentativa é um span filho do mesmo span do checkout, com o número de recebimentos da mensagem: 1 e 2', async () => {
    const { telemetry, exporter } = suite.checkout;
    const world = await traceWorld();
    const order = await submitOrder(suite, world);
    const recorded = await recordedContext(order.orderId);
    world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder', reference: order.orderId });
    const worker = buildWorker(world);

    expect(await worker.pollOnce()).toBe(1);
    await makeClaimable(world, order.orderId);
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

interface Prepared {
  // O pool, a configuração ou o ERP que o cenário troca (a falha injetada na fronteira).
  pool?: pg.Pool;
  erp?: ErpClient;
  // Quantas vezes a injeção do cenário tem de ter disparado.
  fired?: () => number;
}

interface Scenario {
  name: string;
  event: string;
  level: 'info' | 'warn' | 'error';
  extra: Record<string, unknown>;
  config?: Partial<WorkerConfig>;
  // Evento que não pode sair no cenário.
  absent?: string;
  prepare: (world: QueueWorld, order: AcceptedOrder) => Prepared | Promise<Prepared>;
}

const SCENARIOS: Scenario[] = [
  { name: 'faturado', event: 'order.invoiced', level: 'info', extra: {}, prepare: () => ({}) },
  {
    name: 'retry por erro transitório do ERP',
    event: 'outbox.retry',
    level: 'warn',
    extra: { outcome: 'transient' },
    prepare: (world, order) => {
      world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder', reference: order.orderId });
      return {};
    },
  },
  {
    name: 'pedido falho por rejeição do ERP',
    event: 'order.failed',
    level: 'warn',
    extra: { reason: 'erp_rejected' },
    prepare: (world, order) => {
      world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: order.orderId });
      return {};
    },
  },
  {
    name: 'erro de configuração do ERP (401)',
    event: 'erp.config_error',
    level: 'warn',
    extra: { status: 401 },
    prepare: (world, order) => {
      world.sim.script.enqueue({ mode: 'status', status: 401 }, { op: 'createOrder', reference: order.orderId });
      return {};
    },
  },
  {
    name: 'permissão de chamada tomada por outra tentativa',
    event: 'outbox.call_deferred',
    level: 'info',
    extra: {},
    absent: 'order.invoiced',
    prepare: async (_world, order) => {
      await markSentBefore(suite.pool, order.orderId);
      await ageLastCall(suite.pool, order.orderId, 10);
      return {};
    },
  },
  {
    name: 'visibilidade curta demais para a chamada',
    event: 'outbox.lease_short',
    level: 'warn',
    extra: {},
    config: { visibilitySeconds: 11 },
    absent: 'order.invoiced',
    prepare: () => ({}),
  },
  {
    name: 'o SQS recusa o receipt handle na conclusão',
    event: 'outbox.conclusion_no_row',
    level: 'warn',
    extra: {},
    prepare: (world, order) => {
      world.transport.afterErp({ op: 'createOrder', reference: order.orderId }, () => stealMessage(world, order.orderId));
      return {};
    },
  },
  {
    name: 'falha do SQS ao apagar a mensagem',
    event: 'outbox.queue_error',
    level: 'warn',
    extra: {},
    prepare: (world) => {
      const injection = world.queue.inject('delete');
      return { fired: () => injection.fired };
    },
  },
  {
    name: 'falha do banco ao gravar o desfecho, antes de repetir',
    event: 'outbox.conclusion_failed',
    level: 'warn',
    extra: {},
    prepare: () => {
      const probe = interceptPool(suite.pool, {
        match: CONCLUSION_STATEMENT,
        times: 1,
        fail: () => Object.assign(new Error('falha injetada ao gravar o desfecho'), { code: '40001' }),
      });
      return { pool: probe.pool, fired: () => probe.fired };
    },
  },
  {
    name: 'erro inesperado na tentativa',
    event: 'outbox.attempt_error',
    level: 'error',
    extra: {},
    prepare: (world) => {
      let thrown = 0;
      const erp: ErpClient = {
        ...world.erp,
        createOrder: () => {
          thrown += 1;
          throw new Error('erro inesperado injetado na porta do ERP');
        },
      };
      return { erp, fired: () => thrown };
    },
  },
];

describe('OBS-01 logs do worker', () => {
  it.each(SCENARIOS)(
    'OBS-01 $name: o log $event ($level) traz os campos obrigatórios, orderId, attempt e o correlationId da mensagem, e nenhum log leva o corpo',
    async ({ event, level, extra, config, absent, prepare }) => {
      const logs = captureLogs();
      const world = await traceWorld();
      const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
      const recorded = await recordedContext(order.orderId);
      const prepared = await prepare(world, order);

      expect(
        await buildWorker(world, {
          logger: logs.logger,
          ...(prepared.pool ? { pool: prepared.pool } : {}),
          ...(prepared.erp ? { erp: prepared.erp } : {}),
          ...(config ? { config } : {}),
        }).pollOnce(),
      ).toBe(1);

      expect(prepared.fired?.() ?? 1, 'a falha injetada disparou').toBeGreaterThanOrEqual(1);
      const lines = logs.ofOrder(order.orderId);
      const wanted = lines.filter((line) => line['event'] === event);
      expect(wanted, `evento ${event} entre ${JSON.stringify(lines.map((line) => line['event']))}`).toHaveLength(1);
      expect(wanted[0]?.['level']).toBe(level);
      expect(wanted[0]).toMatchObject(extra);
      expect(lines.filter((line) => line['event'] === (absent ?? 'nenhum.evento'))).toEqual([]);
      for (const line of lines) expectAttemptLine(line, order, recorded, 1);
    },
  );

  // A mensagem cujo pedido já não está pending é encerrada sem chamar o ERP; o log leva o contexto da mensagem.
  it('OBS-01 outbox.closed (pedido que já não estava pending) traz os campos obrigatórios, orderId, attempt (os recebimentos da mensagem) e o correlationId do checkout', async () => {
    const logs = captureLogs();
    const world = await traceWorld();
    const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    await suite.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);

    await buildWorker(world, { logger: logs.logger }).pollOnce();

    const lines = logs.eventsOf('outbox.closed', order.orderId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('info');
    expectAttemptLine(lines[0] ?? {}, order, recorded, 1);
    expect(world.transport.sends).toHaveLength(0);
    expect(world.queue.deletesOf(order.orderId).map((call) => call.result)).toEqual(['ok']);
  });

  it.each([
    ['fatura', 'invoiced'],
    ['fatura', 'failed'],
    ['rejeição', 'invoiced'],
    ['rejeição', 'failed'],
  ] as const)(
    'OBS-01 conclusão por %s com o pedido já %s fora do fluxo: sai outbox.closed com os campos obrigatórios e o correlationId, e nenhum order.invoiced nem order.failed',
    async (result, externalStatus) => {
      const logs = captureLogs();
      const world = await traceWorld();
      const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
      const recorded = await recordedContext(order.orderId);
      if (result === 'rejeição') world.sim.script.enqueue({ mode: 'reject' }, { op: 'createOrder', reference: order.orderId });
      world.transport.afterErp({ op: 'createOrder', reference: order.orderId }, async () => {
        await suite.pool.query(
          externalStatus === 'invoiced'
            ? "update orders set status = 'invoiced', outcome_at = now() where id = $1"
            : "update orders set status = 'failed', failure_reason = 'cancelled', outcome_at = now() where id = $1",
          [order.orderId],
        );
      });

      await buildWorker(world, { logger: logs.logger }).pollOnce();

      const closed = logs.eventsOf('outbox.closed', order.orderId);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.['level']).toBe('info');
      expectAttemptLine(closed[0] ?? {}, order, recorded, 1);
      expect(logs.eventsOf('order.invoiced', order.orderId)).toEqual([]);
      expect(logs.eventsOf('order.failed', order.orderId)).toEqual([]);
    },
  );

  it('OBS-01 o retry por erro de configuração traz o outcome config_error, e o attempt acompanha o segundo recebimento da mensagem', async () => {
    const logs = captureLogs();
    const world = await traceWorld();
    const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    world.sim.script.enqueue({ mode: 'status', status: 400 }, { op: 'createOrder', reference: order.orderId });
    const worker = buildWorker(world, { logger: logs.logger });

    await worker.pollOnce();
    const retry = logs.eventsOf('outbox.retry', order.orderId);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ level: 'warn', outcome: 'config_error' });
    expect(logs.eventsOf('erp.config_error', order.orderId)[0]).toMatchObject({ level: 'warn', status: 400 });

    await makeClaimable(world, order.orderId);
    await worker.pollOnce();
    const invoiced = logs.eventsOf('order.invoiced', order.orderId);
    expect(invoiced).toHaveLength(1);
    expectAttemptLine(invoiced[0] ?? {}, order, recorded, 2);
  });

  it('OBS-01 os logs do worker usam o span da tentativa: o span_id é o do span exportado, filho do span do checkout', async () => {
    const { telemetry, exporter } = suite.checkout;
    const logs = captureLogs();
    const world = await traceWorld();
    const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);

    await buildWorker(world, { logger: logs.logger }).pollOnce();
    await telemetry.forceFlush();

    const attempt = exporter.getFinishedSpans().find((span) => span.attributes['orderId'] === order.orderId && span.parentSpanContext?.spanId === recorded.spanId);
    expect(attempt, 'span da tentativa').toBeDefined();
    const invoiced = logs.eventsOf('order.invoiced', order.orderId);
    expect(invoiced).toHaveLength(1);
    expect(invoiced[0]?.['span_id']).toBe(attempt?.spanContext().spanId);
    expect(invoiced[0]?.['trace_id']).toBe(attempt?.spanContext().traceId);
  });

  it.each([
    ['sem orderId', '{"correlationId":"req-1"}', false],
    ['com orderId e um campo a mais', `{"orderId":"${randomUUID()}","correlationId":"req-1","extra":1}`, true],
  ] as const)('OBS-01 outbox.invalid_message (error) de um corpo %s: loga com a tentativa, sem o orderId quando o corpo não o tem, e não chama o ERP', async (_label, body, hasOrderId) => {
    const logs = captureLogs();
    const world = await traceWorld();

    await enqueueRaw(world, body);
    expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(1);

    const invalid = logs.eventsOf('outbox.invalid_message');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ level: 'error', event: 'outbox.invalid_message', attempt: 1 });
    expect('orderId' in (invalid[0] ?? {})).toBe(hasOrderId);
    expect(world.transport.sends).toHaveLength(0);
    expect(world.queue.deletes).toEqual([]);
    expect(world.queue.visibilityChanges).toEqual([]);
  });
});

describe('OBS-01 worker.poll_error', () => {
  it('OBS-01 a falha do recebimento no laço do start() é logada em error (worker.poll_error) e não para o laço: a mensagem seguinte é faturada', async () => {
    const logs = captureLogs();
    const world = await traceWorld();
    const injection = world.queue.inject('receive');
    const worker = buildWorker(world, { logger: logs.logger, config: { receiveWaitSeconds: 1 } });

    await worker.start();
    // O laço pode esperar um intervalo no relógio injetável depois do erro: o teste o avança junto com a espera.
    await vi.waitFor(
      () => {
        world.clock.advance(500);
        expect(logs.eventsOf('worker.poll_error')).toHaveLength(1);
      },
      { timeout: 20_000, interval: 20 },
    );
    expect(injection.fired, 'a falha injetada disparou').toBe(1);
    expect(logs.eventsOf('worker.poll_error')[0]).toMatchObject({ level: 'error', event: 'worker.poll_error' });

    const order = await submitOrder(suite, world);
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
});

describe('OBS-01 os eventos que encerram a mensagem sem chamar o ERP saem num span outbox.settle, não num outbox.attempt', () => {
  it('OBS-01 outbox.closed: um span outbox.settle filho do traceparent da mensagem, com orderId, attempt e outcome closed, e nenhum outbox.attempt', async () => {
    const { telemetry, exporter } = suite.checkout;
    const world = await traceWorld();
    const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    await suite.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [order.orderId]);

    await buildWorker(world).pollOnce();
    await telemetry.forceFlush();

    const spans = exporter.getFinishedSpans().filter((span) => span.attributes['orderId'] === order.orderId);
    const settle = spans.filter((span) => span.name === 'outbox.settle' && span.parentSpanContext?.spanId === recorded.spanId);
    const attempts = spans.filter((span) => span.name === 'outbox.attempt');
    expect(settle).toHaveLength(1);
    expect(settle[0]?.spanContext().traceId).toBe(recorded.traceId);
    expect(settle[0]?.attributes).toMatchObject({ orderId: order.orderId, attempt: 1, outcome: 'closed' });
    expect(attempts).toEqual([]);
  });
});

// Pool que falha, uma vez e só depois de armado, a consulta de guarda que o invólucro de transação faz
// antes do COMMIT, com o erro `25P02` que o PostgreSQL devolve numa transação abortada.
describe('OBS-01 db.transaction_aborted também sai do worker', () => {
  it('OBS-01 uma conclusão cuja transação aborta antes do COMMIT grava o log error db.transaction_aborted com orderId, attempt e correlationId', async () => {
    const logs = captureLogs();
    const world = await traceWorld();
    const order = await submitOrder(suite, world, { requestId: `obs01-${randomUUID()}` });
    const recorded = await recordedContext(order.orderId);
    // O alias "guard" é o da consulta do invólucro; outro `select 1` não é a guarda.
    const probe = interceptPool(suite.pool, {
      match: /^\s*select\s+1\s+as\s+"guard"\s*$/i,
      times: 1,
      fail: () =>
        Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' }),
    });
    probe.armed = false;
    // A tomada da permissão já terminou: só a conclusão, que vem depois da resposta do ERP, encontra a guarda armada.
    world.transport.afterErp({ op: 'createOrder', reference: order.orderId }, () => {
      probe.armed = true;
      return Promise.resolve();
    });
    const worker = buildWorker(world, { pool: probe.pool, logger: logs.logger });

    await worker.pollOnce();

    expect(probe.fired, 'a guarda da conclusão foi falhada uma vez').toBe(1);
    const aborted = logs.eventsOf('db.transaction_aborted', order.orderId);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ level: 'error', orderId: order.orderId, attempt: 1, correlationId: recorded.correlationId });
    // A conclusão abortada não grava nada; a repetida fecha a mensagem, fatura o pedido e baixa o estoque uma vez só.
    expect(await countInvoices(suite.database.pool, order.orderId)).toBe(1);
    await expectInvoiced(world, order);
  });
});
