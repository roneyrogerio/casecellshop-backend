import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRelay } from '../../../src/billing/relay.ts';
import { fromPino } from '../../../src/shared/logging.ts';
import { createTelemetry } from '../../../src/shared/telemetry.ts';
import { createManualClock } from '../../helpers/clock.ts';
import { drain } from '../../helpers/sqs.ts';
import {
  acceptOrder,
  createWorld,
  startWorkerSuite,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// OBS-05: cada SendMessageBatch do relay é um span `send billing` (convenção de mensageria do OpenTelemetry),
// CLIENT, com um link para o contexto do checkout de cada mensagem.

let suite: WorkerSuite;
const exporter = new InMemorySpanExporter();
const relayTelemetry = createTelemetry({ spanExporter: exporter });

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await relayTelemetry.shutdown();
  await suite?.stop();
});

// O banco é dividido entre os testes: uma linha que sobra de um seria publicada no lote do seguinte.
beforeEach(async () => {
  await suite.pool.query('delete from outbox');
  await relayTelemetry.forceFlush();
  exporter.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  suite.releaseWorlds();
});

function relayOver(world: QueueWorld, batchSize?: number) {
  return createRelay({
    pool: suite.pool,
    queue: world.queues.queue,
    logger: fromPino(pino({ level: 'silent' })),
    telemetry: relayTelemetry,
    clock: createManualClock(),
    ...(batchSize === undefined ? {} : { config: { batchSize } }),
  });
}

async function sendSpans(): Promise<ReadableSpan[]> {
  // O processador exporta em lote: sem o flush o teste leria spans a menos.
  await relayTelemetry.forceFlush();
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name === 'send billing');
}

async function onlySendSpan(): Promise<ReadableSpan> {
  const spans = await sendSpans();
  expect(spans, 'um único span "send billing"').toHaveLength(1);
  const [span] = spans;
  if (!span) throw new Error('span "send billing" ausente');
  return span;
}

interface StoredContext {
  traceId: string;
  spanId: string;
}

// O contexto que o checkout gravou na linha da outbox: o que o link de cada mensagem tem de apontar.
async function storedContext(orderId: string): Promise<StoredContext> {
  const result = await suite.pool.query<{ traceparent: string | null }>(
    'select traceparent from outbox where order_id = $1',
    [orderId],
  );
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(
    result.rows[0]?.traceparent ?? '',
  );
  expect(match, 'traceparent gravado pelo checkout').not.toBeNull();
  return { traceId: match?.[1] ?? '', spanId: match?.[2] ?? '' };
}

function linkedContexts(span: ReadableSpan): StoredContext[] {
  return span.links.map((link) => ({
    traceId: link.context.traceId,
    spanId: link.context.spanId,
  }));
}

async function acceptMany(count: number): Promise<string[]> {
  const orderIds: string[] = [];
  // Em sequência: o created_at da outbox, que define a ordem do relay, fica estritamente crescente.
  for (let index = 0; index < count; index += 1)
    orderIds.push((await acceptOrder(suite)).orderId);
  return orderIds;
}

describe('OBS-05 o envio do relay ao SQS é um span de mensageria', () => {
  it('OBS-05 um lote de 3 mensagens abre um único span "send billing" CLIENT com os atributos de mensageria', async () => {
    const world = await createWorld(suite);
    await acceptMany(3);

    expect(await relayOver(world).publishOnce()).toBe(3);

    const span = await onlySendSpan();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['messaging.system']).toBe('aws_sqs');
    expect(span.attributes['messaging.operation.name']).toBe('send');
    expect(span.attributes['messaging.operation.type']).toBe('send');
    expect(span.attributes['messaging.destination.name']).toBe('billing');
    expect(span.attributes['messaging.batch.message_count']).toBe(3);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(
      span.attributes['error.type'],
      'o envio que dá certo não leva error.type',
    ).toBeUndefined();
    expect(await drain(world.emq, world.queues.queueUrl)).toHaveLength(3);
  });

  it('OBS-05 o span tem um link para o contexto de checkout de cada mensagem, o traceparent da linha da outbox', async () => {
    const world = await createWorld(suite);
    const orderIds = await acceptMany(3);
    const expected = await Promise.all(orderIds.map(storedContext));

    await relayOver(world).publishOnce();

    const linked = linkedContexts(await onlySendSpan());
    expect(linked).toHaveLength(3);
    expect(linked).toEqual(expect.arrayContaining(expected));
  });

  it('OBS-05 duas rodadas com lote de 2 e 3 pedidos abrem dois spans, um por SendMessageBatch, cada um com a própria contagem', async () => {
    const world = await createWorld(suite);
    await acceptMany(3);
    const relay = relayOver(world, 2);

    expect(await relay.publishOnce()).toBe(2);
    expect(await relay.publishOnce()).toBe(1);

    const counts = (await sendSpans())
      .map((span) => span.attributes['messaging.batch.message_count'])
      .sort((a, b) => Number(a) - Number(b));
    expect(counts).toEqual([1, 2]);
  });

  it('OBS-05 rodada sem linhas na outbox não abre span de envio', async () => {
    const world = await createWorld(suite);

    expect(await relayOver(world).publishOnce()).toBe(0);

    expect(await sendSpans()).toHaveLength(0);
  });

  it('OBS-05 linha sem traceparent: a mensagem sai sem link, e as demais mantêm o delas', async () => {
    const world = await createWorld(suite);
    const [withContext, withoutContext] = await acceptMany(2);
    await suite.pool.query(
      'update outbox set traceparent = null where order_id = $1',
      [withoutContext],
    );
    const expected = await storedContext(withContext ?? '');

    expect(await relayOver(world).publishOnce()).toBe(2);

    const span = await onlySendSpan();
    expect(span.attributes['messaging.batch.message_count']).toBe(2);
    expect(linkedContexts(span)).toEqual([expected]);
  });

  it('OBS-05 lote só com linhas sem traceparent: o span sai sem nenhum link', async () => {
    const world = await createWorld(suite);
    await acceptMany(2);
    await suite.pool.query('update outbox set traceparent = null');

    expect(await relayOver(world).publishOnce()).toBe(2);

    const span = await onlySendSpan();
    expect(span.attributes['messaging.batch.message_count']).toBe(2);
    expect(span.links).toHaveLength(0);
  });

  it('OBS-05 falha do envio ao SQS marca o span com status de erro e com error.type igual ao nome da exceção, e a linha continua sem published_at', async () => {
    const world = await createWorld(suite);
    const [orderId] = await acceptMany(1);
    // Só o erro de transporte do SQS, injetado na fronteira; a fila de verdade responde depois dele. O TypeError
    // (e não um Error) separa o nome da exceção de um valor fixo no código.
    const send = vi
      .spyOn(world.queues.queue, 'send')
      .mockRejectedValueOnce(new TypeError('SQS indisponível (injetado)'));

    await expect(relayOver(world).publishOnce()).rejects.toThrow(
      'SQS indisponível (injetado)',
    );

    expect(send, 'a falha injetada disparou').toHaveBeenCalledTimes(1);
    const span = await onlySendSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // Convenção de mensageria: `error.type` é "Conditionally Required" se, e somente se, a operação falhou.
    expect(span.attributes['error.type']).toBe('TypeError');
    expect(span.kind).toBe(SpanKind.CLIENT);
    const row = await suite.pool.query<{ published_at: Date | null }>(
      'select published_at from outbox where order_id = $1',
      [orderId],
    );
    expect(row.rows[0]?.published_at).toBeNull();
  });
});
