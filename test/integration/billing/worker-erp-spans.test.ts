import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureLogs } from '../../helpers/logs.ts';
import {
  buildWorker,
  createWorld,
  makeClaimable,
  submitOrder,
  useWorkerSuite,
  type QueueWorld,
} from '../../helpers/worker.ts';

// OBS-05: um orderId leva a um trace da requisição ao ERP. A tentativa (outbox.attempt, com o orderId) continua o
// trace do checkout e cada chamada do ErpClient é um span filho dela.

const suiteOf = useWorkerSuite();

beforeEach(async () => {
  await suiteOf().checkout.telemetry.forceFlush();
  suiteOf().checkout.exporter.reset();
});

// Mundo com a telemetria do checkout: o ErpClient, o worker e o checkout exportam para o mesmo lugar.
function traceWorld(): Promise<QueueWorld> {
  return createWorld(suiteOf(), { telemetry: suiteOf().checkout.telemetry });
}

async function finishedSpans(): Promise<ReadableSpan[]> {
  await suiteOf().checkout.telemetry.forceFlush();
  return suiteOf().checkout.exporter.getFinishedSpans();
}

function attemptsOf(spans: ReadableSpan[], orderId: string): ReadableSpan[] {
  return spans
    .filter(
      (span) =>
        span.name === 'outbox.attempt' &&
        span.attributes['orderId'] === orderId,
    )
    .sort(
      (a, b) =>
        Number(a.attributes['attempt']) - Number(b.attributes['attempt']),
    );
}

function childrenOf(
  spans: ReadableSpan[],
  parent: ReadableSpan | undefined,
  name: string,
): ReadableSpan[] {
  return spans.filter(
    (span) =>
      span.name === name &&
      span.parentSpanContext?.spanId === parent?.spanContext().spanId,
  );
}

function only(spans: ReadableSpan[], what: string): ReadableSpan {
  expect(spans, what).toHaveLength(1);
  const [span] = spans;
  if (!span) throw new Error(`${what}: ausente`);
  return span;
}

describe('OBS-05 o orderId leva a um trace da requisição ao ERP', () => {
  it('OBS-05 o span erp.create_order está no trace do checkout e do outbox.attempt, com a tentativa como pai', async () => {
    const world = await traceWorld();
    const order = await submitOrder(suiteOf(), world);

    expect(await buildWorker(world).pollOnce()).toBe(1);

    const spans = await finishedSpans();
    const attempt = only(
      attemptsOf(spans, order.orderId),
      'tentativa do pedido',
    );
    const erp = only(
      childrenOf(spans, attempt, 'erp.create_order'),
      'span da criação filho da tentativa',
    );
    expect(erp.spanContext().traceId).toBe(attempt.spanContext().traceId);
    expect(erp.kind).toBe(SpanKind.CLIENT);
    expect(erp.attributes['casecellshop.erp.operation']).toBe('create_order');
    expect(erp.attributes['casecellshop.erp.outcome']).toBe('ok');
    expect(erp.status.code).toBe(SpanStatusCode.UNSET);
    expect(erp.attributes['error.type']).toBeUndefined();

    // O mesmo trace começa na requisição do checkout.
    const checkout = spans.find(
      (span) =>
        span.name === 'POST /checkout' &&
        span.spanContext().traceId === erp.spanContext().traceId,
    );
    expect(checkout, 'span da requisição no trace do ERP').toBeDefined();
  });

  // O orderId é a chave para os dois lados: o log da tentativa com aquele pedido e o span da chamada ao ERP caem
  // no mesmo trace, que é o da requisição do checkout.
  it('OBS-05 o log da tentativa com o orderId traz o trace_id do span erp.create_order daquela tentativa e do checkout', async () => {
    const logs = captureLogs();
    const world = await traceWorld();
    const order = await submitOrder(suiteOf(), world);

    expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(
      1,
    );

    const spans = await finishedSpans();
    const attempt = only(attemptsOf(spans, order.orderId), 'tentativa');
    const erp = only(
      childrenOf(spans, attempt, 'erp.create_order'),
      'span da criação',
    );
    const checkout = spans.find(
      (span) =>
        span.name === 'POST /checkout' &&
        span.spanContext().traceId === erp.spanContext().traceId,
    );
    expect(checkout, 'span da requisição no trace do ERP').toBeDefined();

    const lines = logs.ofOrder(order.orderId);
    expect(lines.length, 'logs da tentativa do pedido').toBeGreaterThan(0);
    expect(
      lines.map((line) => line['event']),
      'o desfecho da tentativa está entre os logs do pedido',
    ).toContain('casecellshop.order.invoiced');
    for (const line of lines) {
      const label = `linha ${JSON.stringify(line)}`;
      expect(line['trace_id'], label).toBe(erp.spanContext().traceId);
      expect(line['trace_id'], label).toBe(checkout?.spanContext().traceId);
      // O span da linha é o da tentativa, pai do span da chamada ao ERP.
      expect(line['span_id'], label).toBe(attempt.spanContext().spanId);
      expect(line['span_id'], label).toBe(erp.parentSpanContext?.spanId);
    }
  });

  it('OBS-05 pedidos diferentes têm traces diferentes: o trace_id do log de um pedido não aparece no span do ERP do outro', async () => {
    const logs = captureLogs();
    const world = await traceWorld();
    const first = await submitOrder(suiteOf(), world);
    const second = await submitOrder(suiteOf(), world);

    expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(
      2,
    );

    const spans = await finishedSpans();
    const traceOf = (orderId: string): string => {
      const attempt = only(attemptsOf(spans, orderId), 'tentativa');
      return only(
        childrenOf(spans, attempt, 'erp.create_order'),
        'span da criação',
      ).spanContext().traceId;
    };
    expect(traceOf(first.orderId)).not.toBe(traceOf(second.orderId));
    for (const order of [first, second]) {
      const lines = logs.ofOrder(order.orderId);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines)
        expect(line['trace_id']).toBe(traceOf(order.orderId));
    }
  });

  it.each([
    {
      label: 'indisponível (transient)',
      behavior: { mode: 'unavailable' },
      outcome: 'transient',
      status: SpanStatusCode.ERROR,
      errorType: 'transient',
    },
    {
      label: 'status 500 (ambiguous)',
      behavior: { mode: 'status', status: 500 },
      outcome: 'ambiguous',
      status: SpanStatusCode.ERROR,
      errorType: 'ambiguous',
    },
    {
      label: 'status 401 (config_error)',
      behavior: { mode: 'status', status: 401 },
      outcome: 'config_error',
      status: SpanStatusCode.ERROR,
      errorType: 'config_error',
    },
    {
      label: 'recusa de negócio (permanent)',
      behavior: { mode: 'reject' },
      outcome: 'permanent',
      status: SpanStatusCode.UNSET,
      errorType: undefined,
    },
  ] as const)(
    'OBS-05 criação com ERP $label: o span da chamada traz o desfecho; só a falha técnica marca erro',
    async ({ behavior, outcome, status, errorType }) => {
      const world = await traceWorld();
      const order = await submitOrder(suiteOf(), world);
      world.sim.script.enqueue(behavior, {
        op: 'createOrder',
        reference: order.orderId,
      });

      await buildWorker(world).pollOnce();

      const spans = await finishedSpans();
      const attempt = only(attemptsOf(spans, order.orderId), 'tentativa');
      const erp = only(
        childrenOf(spans, attempt, 'erp.create_order'),
        'span da criação',
      );
      expect(erp.attributes['casecellshop.erp.outcome']).toBe(outcome);
      expect(erp.status.code).toBe(status);
      expect(erp.attributes['error.type']).toBe(errorType);
    },
  );

  it('OBS-05 cada tentativa tem os próprios spans do ERP: a segunda, depois de um desfecho ambíguo, consulta (erp.find_order) e cria, ambos filhos dela', async () => {
    const world = await traceWorld();
    const order = await submitOrder(suiteOf(), world);
    world.sim.script.enqueue(
      { mode: 'status', status: 500 },
      { op: 'createOrder', reference: order.orderId },
    );
    const polls: number[] = [];
    const worker = buildWorker(world);
    polls.push(await worker.pollOnce());
    await makeClaimable(world, order.orderId);
    polls.push(await worker.pollOnce());
    expect(polls, 'cada rodada recebeu a mensagem').toEqual([1, 1]);

    const spans = await finishedSpans();
    const [first, second] = attemptsOf(spans, order.orderId);
    expect(first?.attributes['attempt']).toBe(1);
    expect(second?.attributes['attempt']).toBe(2);

    const firstCreate = only(
      childrenOf(spans, first, 'erp.create_order'),
      'criação da 1a tentativa',
    );
    expect(firstCreate.attributes['casecellshop.erp.outcome']).toBe(
      'ambiguous',
    );
    expect(childrenOf(spans, first, 'erp.find_order')).toHaveLength(0);

    const find = only(
      childrenOf(spans, second, 'erp.find_order'),
      'consulta da 2a tentativa',
    );
    expect(find.kind).toBe(SpanKind.CLIENT);
    expect(find.attributes['casecellshop.erp.operation']).toBe('find_order');
    expect(find.attributes['casecellshop.erp.outcome']).toBe('not_found');
    expect(find.status.code).toBe(SpanStatusCode.UNSET);
    expect(find.attributes['error.type']).toBeUndefined();

    const secondCreate = only(
      childrenOf(spans, second, 'erp.create_order'),
      'criação da 2a tentativa',
    );
    expect(secondCreate.attributes['casecellshop.erp.outcome']).toBe('ok');
    for (const span of [firstCreate, find, secondCreate])
      expect(span.spanContext().traceId).toBe(first?.spanContext().traceId);
  });
});
