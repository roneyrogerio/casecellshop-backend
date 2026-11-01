import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
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
import {
  BillingMessage,
  CheckoutAccepted,
  TRACEPARENT_ATTRIBUTE,
} from '../../../src/contract/index.ts';
import {
  createRelay,
  DEFAULT_RELAY_CONFIG,
  type Relay,
  type RelayConfig,
} from '../../../src/billing/relay.ts';
import {
  createQueue,
  createSqsClient,
  type Queue,
} from '../../../src/queue/sqs.ts';
import {
  createTelemetry,
  type Telemetry,
} from '../../../src/shared/telemetry.ts';
import { settle } from '../../helpers/async.ts';
import {
  APP_POOL_SIZE,
  checkoutBody,
  createAppPool,
  line,
  PATIENT_LIMITS,
  postCheckout,
  seedProduct,
  startCheckoutHarness,
  type CheckoutHarness,
} from '../../helpers/checkout.ts';
import { createManualClock, type ManualClock } from '../../helpers/clock.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import { captureLogs } from '../../helpers/logs.ts';
import { scrapeMetrics, valueOf } from '../../helpers/metrics.ts';
import {
  drain,
  duplicatedOrderIds,
  observe,
  openBillingQueues,
  startBlackHole,
  startElasticMq,
  TEST_REGION,
  visibleCount,
  type BlackHole,
  type OpenedQueues,
  type RawMessage,
  type TestElasticMq,
} from '../../helpers/sqs.ts';

// Message Relay (AD-021; design.md, "Message Relay"): ORD-22. Pedidos nascem do checkout de verdade,
// a fila é o ElasticMQ e o relógio do laço é o manual. A metade "a mensagem repetida não gera segunda
// fatura" do ORD-22 depende do worker e fica para a fatia seguinte.

let database: TestDatabase;
let harness: CheckoutHarness;
let relayPool: pg.Pool;
let emq: TestElasticMq;
let blackHole: BlackHole;
let sharedTelemetry: Telemetry;
const opened: OpenedQueues[] = [];

beforeAll(async () => {
  database = await startMigratedDatabase();
  harness = await startCheckoutHarness(database, APP_POOL_SIZE, PATIENT_LIMITS);
  relayPool = createAppPool(database.uri, 10);
  sharedTelemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  emq = await startElasticMq();
  blackHole = await startBlackHole();
}, 180_000);

// O banco é dividido entre os testes: uma linha que sobra de um seria publicada na fila do seguinte.
beforeEach(async () => {
  await database.pool.query('delete from outbox');
});

afterEach(() => {
  for (const queues of opened.splice(0)) queues.close();
});

afterAll(async () => {
  await blackHole?.close();
  await emq?.stop();
  await sharedTelemetry?.shutdown();
  await relayPool?.end();
  await harness?.close();
  await database?.stop();
});

async function freshQueues(): Promise<OpenedQueues> {
  const queues = await openBillingQueues(emq);
  opened.push(queues);
  return queues;
}

// ---------------------------------------------------------------- dados

interface AcceptedCheckout {
  orderId: string;
  // O X-Request-Id da resposta: o correlationId gravado na outbox.
  requestId: string;
}

async function acceptCheckout(
  options: { traceparent?: string } = {},
): Promise<AcceptedCheckout> {
  const product = await seedProduct(database.pool, {
    priceCents: 4990,
    onHand: 10,
  });
  const requestId = `req-${randomUUID()}`;
  const response = await postCheckout(
    harness.server,
    checkoutBody(line(product)),
    {
      requestId,
      ...(options.traceparent === undefined
        ? {}
        : { traceparent: options.traceparent }),
    },
  );
  expect(response.status).toBe(202);
  return { orderId: CheckoutAccepted.parse(response.body).orderId, requestId };
}

async function acceptMany(count: number): Promise<AcceptedCheckout[]> {
  const accepted: AcceptedCheckout[] = [];
  // Em sequência: o created_at da outbox, que define a ordem do relay, fica estritamente crescente.
  for (let index = 0; index < count; index += 1)
    accepted.push(await acceptCheckout());
  return accepted;
}

interface OutboxState {
  publishedAt: Date | null;
  traceparent: string | null;
  correlationId: string;
}

async function readState(orderId: string): Promise<OutboxState> {
  const result = await database.pool.query<{
    published_at: Date | null;
    traceparent: string | null;
    correlation_id: string;
  }>(
    'select published_at, traceparent, correlation_id from outbox where order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return {
    publishedAt: row.published_at,
    traceparent: row.traceparent,
    correlationId: row.correlation_id,
  };
}

async function publishedOrderIds(orderIds: string[]): Promise<string[]> {
  const result = await database.pool.query<{ order_id: string }>(
    'select order_id from outbox where published_at is not null and order_id = any($1::uuid[])',
    [orderIds],
  );
  return result.rows.map((row) => row.order_id).sort();
}

function orderIdsIn(messages: RawMessage[]): string[] {
  return messages
    .map((message) => BillingMessage.parse(JSON.parse(message.body)).orderId)
    .sort();
}

// ---------------------------------------------------------------- relé e relógio

interface RelayOptions {
  pool?: pg.Pool;
  clock?: ManualClock;
  telemetry?: Telemetry;
  logger?: Logger;
  config?: Partial<RelayConfig>;
}

function newRelay(queue: Queue, options: RelayOptions = {}): Relay {
  return createRelay({
    pool: options.pool ?? relayPool,
    queue,
    logger: options.logger ?? pino({ level: 'silent' }),
    telemetry: options.telemetry ?? sharedTelemetry,
    clock: options.clock ?? createManualClock(),
    ...(options.config ? { config: options.config } : {}),
  });
}

// O relógio manual que anota cada espera pedida: o teste só avança o relógio depois de o laço
// ter dormido, senão o `advance` cairia no vazio e o laço esperaria para sempre.
function watchSleeps(): { clock: ManualClock; sleeps: number[] } {
  const inner = createManualClock();
  const sleeps: number[] = [];
  const clock: ManualClock = {
    now: () => inner.now(),
    advance: (ms) => inner.advance(ms),
    sleep(ms) {
      sleeps.push(ms);
      return inner.sleep(ms);
    },
  };
  return { clock, sleeps };
}

// ---------------------------------------------------------------- injeção na fronteira

// Falha do banco entre publicar e marcar: o único erro injetado é a rejeição do UPDATE que grava
// `published_at`, no pool (ou na conexão dele). O SELECT e o resto passam para o PostgreSQL real.
const MARKING_UPDATE =
  /update\s+(?:"?\w+"?\.)?"?outbox"?\s+set[\s\S]*published_at/i;

function queryText(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (
    typeof first === 'object' &&
    first !== null &&
    'text' in first &&
    typeof first.text === 'string'
  )
    return first.text;
  return '';
}

type AnyFunction = (...args: unknown[]) => unknown;

function interceptQueries<T extends object>(
  target: T,
  shouldFail: (args: unknown[]) => boolean,
  wrapConnection: boolean,
): T {
  return new Proxy(target, {
    get(object, property): unknown {
      const value: unknown = Reflect.get(object, property, object);
      if (property === 'query') {
        return (...args: unknown[]): unknown =>
          shouldFail(args)
            ? Promise.reject(new Error('falha injetada ao marcar a outbox'))
            : (value as AnyFunction).apply(object, args);
      }
      if (wrapConnection && property === 'connect') {
        return async (...args: unknown[]): Promise<unknown> => {
          const client = (await (value as AnyFunction).apply(
            object,
            args,
          )) as object;
          return interceptQueries(client, shouldFail, false);
        };
      }
      return typeof value === 'function'
        ? (value as AnyFunction).bind(object)
        : value;
    },
  });
}

function failMarkingOnce(pool: pg.Pool): {
  pool: pg.Pool;
  fired: () => number;
} {
  let fired = 0;
  let armed = true;
  const shouldFail = (args: unknown[]): boolean => {
    if (!armed || !MARKING_UPDATE.test(queryText(args))) return false;
    armed = false;
    fired += 1;
    return true;
  };
  return { pool: interceptQueries(pool, shouldFail, true), fired: () => fired };
}

// A fila falha nas primeiras `failures` chamadas de send e depois delega à fila de verdade: um
// erro de transporte do SQS, injetado na fronteira; nada de resposta inventada.
function failingSend(
  inner: Queue,
  failures: number,
): { queue: Queue; fired: () => number } {
  let fired = 0;
  const queue: Queue = {
    send(messages) {
      if (fired < failures) {
        fired += 1;
        return Promise.reject(new Error('SQS indisponível (injetado)'));
      }
      return inner.send(messages);
    },
    receive: (options) => inner.receive(options),
    delete: (receiptHandle) => inner.delete(receiptHandle),
    changeVisibility: (receiptHandle, seconds) =>
      inner.changeVisibility(receiptHandle, seconds),
    approximateCount: () => inner.approximateCount(),
  };
  return { queue, fired: () => fired };
}

// Segura cada send até `expected` relés estarem dentro do send ao mesmo tempo, para forçar a janela em
// que os dois já leram a outbox e nenhum marcou. O prazo é só uma rede de segurança: sem a janela
// (relés que se serializam), o send segue e o teste mede o que houve.
function windowedSend(
  inner: Queue,
  expected: number,
): { queue: Queue; maxInside: () => number } {
  let inside = 0;
  let maxInside = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue: Queue = {
    async send(messages) {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      if (inside >= expected) release();
      const safety = setTimeout(release, 5_000);
      try {
        await gate;
      } finally {
        clearTimeout(safety);
      }
      try {
        return await inner.send(messages);
      } finally {
        inside -= 1;
      }
    },
    receive: (options) => inner.receive(options),
    delete: (receiptHandle) => inner.delete(receiptHandle),
    changeVisibility: (receiptHandle, seconds) =>
      inner.changeVisibility(receiptHandle, seconds),
    approximateCount: () => inner.approximateCount(),
  };
  return { queue, maxInside: () => maxInside };
}

// A versão ingênua do relé, sem FOR UPDATE SKIP LOCKED: lê as não publicadas, publica e marca. Com a janela
// forçada por `windowedSend`, dois relés assim publicam as mesmas linhas: o controle negativo da invariante.
async function naivePublishOnce(pool: pg.Pool, queue: Queue): Promise<number> {
  const result = await pool.query<{
    order_id: string;
    correlation_id: string;
    traceparent: string | null;
  }>(
    'select order_id, correlation_id, traceparent from outbox where published_at is null order by created_at limit $1',
    [DEFAULT_RELAY_CONFIG.batchSize],
  );
  if (result.rows.length === 0) return 0;
  await queue.send(
    result.rows.map((row) => ({
      id: row.order_id,
      body: JSON.stringify({
        orderId: row.order_id,
        correlationId: row.correlation_id,
      }),
      traceparent: row.traceparent,
    })),
  );
  await pool.query(
    'update outbox set published_at = now() where order_id = any($1::uuid[])',
    [result.rows.map((row) => row.order_id)],
  );
  return result.rows.length;
}

// ---------------------------------------------------------------- publishOnce

describe('ORD-22 relay publica as linhas da outbox', () => {
  it('ORD-22 publica a linha depois do commit do checkout, marca published_at e a mensagem valida no BillingMessage', async () => {
    const queues = await freshQueues();
    const { orderId, requestId } = await acceptCheckout();
    expect((await readState(orderId)).publishedAt).toBeNull();

    const published = await newRelay(queues.queue).publishOnce();

    expect(published).toBe(1);
    expect((await readState(orderId)).publishedAt).not.toBeNull();
    const messages = await drain(emq, queues.queueUrl);
    expect(messages).toHaveLength(1);
    expect(BillingMessage.parse(JSON.parse(messages[0]?.body ?? ''))).toEqual({
      orderId,
      correlationId: requestId,
    });
  });

  it('ORD-22 a mensagem leva no atributo traceparent o traceparent gravado na outbox pelo checkout', async () => {
    const queues = await freshQueues();
    const { orderId } = await acceptCheckout({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    const stored = (await readState(orderId)).traceparent;
    expect(stored).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    await newRelay(queues.queue).publishOnce();

    const [message] = await drain(emq, queues.queueUrl);
    expect(TRACEPARENT_ATTRIBUTE).toBe('traceparent');
    expect(message?.traceparent).toBe(stored);
    expect(message?.traceparentDataType).toBe('String');
  });

  it('ORD-22 a linha de uma transação ainda aberta não é publicada; depois do commit, é', async () => {
    const queues = await freshQueues();
    const relay = newRelay(queues.queue);
    const connection = await database.pool.connect();
    let committed = false;
    try {
      await connection.query('begin');
      const order = await connection.query<{ id: string }>(
        'insert into orders default values returning id',
      );
      const orderId = order.rows[0]?.id ?? '';
      await connection.query(
        'insert into outbox (order_id, correlation_id, traceparent) values ($1, $2, $3)',
        [
          orderId,
          'req-transacao-aberta',
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        ],
      );

      const whileOpen = await relay.publishOnce();
      expect(whileOpen).toBe(0);
      expect(await visibleCount(emq, queues.queueUrl)).toBe(0);

      await connection.query('commit');
      committed = true;

      expect(await relay.publishOnce()).toBe(1);
      expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual([orderId]);
    } finally {
      if (!committed) await connection.query('rollback');
      connection.release();
    }
  });

  it('ORD-22 uma linha já publicada não é publicada de novo na rodada seguinte', async () => {
    const queues = await freshQueues();
    const { orderId } = await acceptCheckout();
    const relay = newRelay(queues.queue);

    expect(await relay.publishOnce()).toBe(1);
    expect(await relay.publishOnce()).toBe(0);

    expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual([orderId]);
  });

  it('ORD-22 publica no máximo batchSize (10) linhas por rodada, das mais antigas para as mais novas', async () => {
    const queues = await freshQueues();
    const accepted = await acceptMany(25);
    const ids = accepted.map((order) => order.orderId);
    // Os 10 últimos a nascer passam a ser os mais antigos pelo created_at: a ordem da leitura física
    // (a de inserção) discordaria da ordem pedida, e só um ORDER BY created_at acerta o lote.
    const newest = ids.slice(15);
    await database.pool.query(
      "update outbox set created_at = created_at - interval '1 hour' where order_id = any($1::uuid[])",
      [newest],
    );
    const relay = newRelay(queues.queue);
    const expectedRounds = [newest, ids.slice(0, 10), ids.slice(10, 15)];
    const published: string[] = [];

    for (const expected of expectedRounds) {
      expect(await relay.publishOnce()).toBe(expected.length);
      published.push(...expected);
      expect(await publishedOrderIds(ids)).toEqual([...published].sort());
    }
    expect(await relay.publishOnce()).toBe(0);
    expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual(
      [...ids].sort(),
    );
  });

  it('ORD-22 uma falha entre publicar e marcar deixa a linha sem published_at, e a rodada seguinte publica o mesmo pedido de novo', async () => {
    const queues = await freshQueues();
    const { orderId } = await acceptCheckout();
    const injected = failMarkingOnce(relayPool);
    const telemetry = createTelemetry({
      spanExporter: new InMemorySpanExporter(),
    });
    const relay = newRelay(queues.queue, { pool: injected.pool, telemetry });

    // A rodada pode rejeitar ou resolver com 0: o contrato fala só do estado que ela deixa.
    await relay.publishOnce().catch(() => undefined);

    expect(
      injected.fired(),
      'a injeção no UPDATE de marcação não disparou',
    ).toBe(1);
    expect((await readState(orderId)).publishedAt).toBeNull();
    // O SQS já aceitou a mensagem antes da falha do banco.
    await vi.waitFor(async () =>
      expect(await visibleCount(emq, queues.queueUrl)).toBe(1),
    );

    expect(await relay.publishOnce()).toBe(1);

    expect((await readState(orderId)).publishedAt).not.toBeNull();
    // Duas mensagens para o mesmo pedido: a entrega é pelo menos uma vez (a fatura única é do worker).
    expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual([
      orderId,
      orderId,
    ]);
    expect(await publishedCount(telemetry)).toBe(1);
    await telemetry.shutdown();
  });

  it('ORD-22 dois relés ao mesmo tempo não publicam a mesma linha na mesma rodada', async () => {
    const queues = await freshQueues();
    const accepted = await acceptMany(20);
    const window = windowedSend(queues.queue, 2);
    const first = newRelay(window.queue);
    const second = newRelay(window.queue);

    const [fromFirst, fromSecond] = await Promise.all([
      first.publishOnce(),
      second.publishOnce(),
    ]);

    expect(fromFirst + fromSecond).toBe(20);
    const messages = await drain(emq, queues.queueUrl);
    expect(duplicatedOrderIds(messages)).toEqual([]);
    expect(orderIdsIn(messages)).toEqual(
      accepted.map((order) => order.orderId).sort(),
    );
    // Os dois estiveram dentro do send ao mesmo tempo: o SKIP LOCKED deu a cada um um lote diferente, sem um esperar o outro.
    expect(window.maxInside()).toBe(2);
  });

  it('ORD-22 controle negativo: dois relés ingênuos (sem SKIP LOCKED) com a janela forçada publicam as mesmas linhas', async () => {
    const queues = await freshQueues();
    const accepted = await acceptMany(10);
    const window = windowedSend(queues.queue, 2);

    await Promise.all([
      naivePublishOnce(relayPool, window.queue),
      naivePublishOnce(relayPool, window.queue),
    ]);

    const messages = await drain(emq, queues.queueUrl);
    expect(messages).toHaveLength(20);
    expect(duplicatedOrderIds(messages).sort()).toEqual(
      accepted.map((order) => order.orderId).sort(),
    );
  });
});

async function publishedCount(
  telemetry: Telemetry,
): Promise<number | undefined> {
  return valueOf(await scrapeMetrics(telemetry), 'outbox_published_total');
}

describe('ORD-22 outbox_published_total', () => {
  it('ORD-22 conta no /metrics as linhas que o relay publicou, sem label', async () => {
    const queues = await freshQueues();
    await acceptMany(3);
    const telemetry = createTelemetry({
      spanExporter: new InMemorySpanExporter(),
    });
    const relay = newRelay(queues.queue, { telemetry });

    expect(await relay.publishOnce()).toBe(3);
    expect(await relay.publishOnce()).toBe(0);

    const families = await scrapeMetrics(telemetry);
    expect(families.get('outbox_published_total')?.type).toBe('counter');
    expect(valueOf(families, 'outbox_published_total')).toBe(3);
    await telemetry.shutdown();
  });
});

// ---------------------------------------------------------------- start e stop

async function untilPublished(orderIds: string[]): Promise<void> {
  await vi.waitFor(
    async () =>
      expect(await publishedOrderIds(orderIds)).toEqual([...orderIds].sort()),
    { timeout: 30_000, interval: 25 },
  );
}

describe('ORD-22 laço do relay (start e stop)', () => {
  it('ORD-22 com a outbox vazia espera 500 ms pelo relógio injetado e publica na rodada seguinte', async () => {
    const queues = await freshQueues();
    const { clock, sleeps } = watchSleeps();
    const relay = newRelay(queues.queue, { clock });
    void relay.start();
    try {
      await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(1), {
        timeout: 30_000,
        interval: 10,
      });
      expect(sleeps[0]).toBe(DEFAULT_RELAY_CONFIG.idleIntervalMs);
      expect(DEFAULT_RELAY_CONFIG.idleIntervalMs).toBe(500);

      const { orderId } = await acceptCheckout();
      await settle();
      // O relógio não andou: o laço ainda dorme e a linha espera.
      expect((await readState(orderId)).publishedAt).toBeNull();

      clock.advance(500);
      await untilPublished([orderId]);
    } finally {
      const stopping = relay.stop();
      clock.advance(500);
      await stopping;
    }
    expect(new Set(sleeps)).toEqual(new Set([500]));
  });

  it('ORD-22 um lote cheio roda de novo na hora, sem esperar 500 ms: 12 linhas saem sem o relógio andar', async () => {
    const queues = await freshQueues();
    const accepted = await acceptMany(12);
    const { clock } = watchSleeps();
    const relay = newRelay(queues.queue, { clock });
    void relay.start();
    try {
      // O relógio nunca anda dentro do try: o segundo lote (2 linhas) só sai se o primeiro, cheio, rodou de novo sem esperar.
      await untilPublished(accepted.map((order) => order.orderId));
    } finally {
      const stopping = relay.stop();
      clock.advance(500);
      await stopping;
    }
    expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual(
      accepted.map((order) => order.orderId).sort(),
    );
  });

  it('ORD-22 um erro do SQS é logado como outbox.relay_error e não para o laço: a rodada seguinte publica', async () => {
    const queues = await freshQueues();
    const { orderId } = await acceptCheckout();
    const failing = failingSend(queues.queue, 1);
    const logs = captureLogs();
    const { clock, sleeps } = watchSleeps();
    const relay = newRelay(failing.queue, { clock, logger: logs.logger });
    void relay.start();
    try {
      await vi.waitFor(() => expect(failing.fired()).toBe(1), {
        timeout: 30_000,
        interval: 10,
      });
      await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(1), {
        timeout: 30_000,
        interval: 10,
      });

      const errors = logs.eventsOf('outbox.relay_error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.['level']).toBe('error');
      expect((await readState(orderId)).publishedAt).toBeNull();
      expect(sleeps[0]).toBe(500);

      clock.advance(500);
      await untilPublished([orderId]);
    } finally {
      const stopping = relay.stop();
      clock.advance(500);
      await stopping;
    }
    expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual([orderId]);
  });

  it('ORD-22 depois do stop o laço não publica mais, mesmo com o relógio andando', async () => {
    const queues = await freshQueues();
    const { clock, sleeps } = watchSleeps();
    const relay = newRelay(queues.queue, { clock });
    void relay.start();
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(1), {
      timeout: 30_000,
      interval: 10,
    });

    const stopping = relay.stop();
    clock.advance(500);
    await stopping;
    const sleepsAtStop = sleeps.length;
    const { orderId } = await acceptCheckout();
    clock.advance(500);
    clock.advance(500);
    await settle(20);

    expect((await readState(orderId)).publishedAt).toBeNull();
    expect(sleeps.length).toBe(sleepsAtStop);
    expect(await visibleCount(emq, queues.queueUrl)).toBe(0);
  });
});

// ---------------------------------------------------------------- SQS que não responde (A1)

// Uma fila de verdade (porta e SDK de produção) cujo endpoint aceita a conexão e nunca responde.
function blackHoleQueue(): { queue: Queue; destroy: () => void } {
  const client = createSqsClient({
    endpoint: blackHole.url,
    region: TEST_REGION,
  });
  return {
    queue: createQueue(client, `${blackHole.url}/queue/billing`),
    destroy: () => client.destroy(),
  };
}

// Outra conexão tenta o mesmo bloqueio que o relay tomou: NOWAIT falha na hora se a linha ainda está presa.
async function rowLockIsFree(orderId: string): Promise<boolean> {
  const connection = await database.pool.connect();
  try {
    await connection.query('begin');
    await connection.query(
      'select 1 from outbox where order_id = $1 for update nowait',
      [orderId],
    );
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === '55P03') return false;
    throw error;
  } finally {
    await connection.query('rollback');
    connection.release();
  }
}

// Para o laço sem depender de a espera já ter começado: anda o relógio até o stop terminar.
async function stopRelay(relay: Relay, clock: ManualClock): Promise<void> {
  let stopped = false;
  const stopping = relay.stop().finally(() => {
    stopped = true;
  });
  for (let attempt = 0; attempt < 5_000 && !stopped; attempt += 1) {
    clock.advance(500);
    await settle(2);
  }
  await stopping;
}

describe('ORD-22 relay com o SQS que aceita a conexão e não responde', () => {
  it('ORD-22 publishOnce rejeita em torno de 5 s, solta o bloqueio da linha e deixa published_at nulo', async () => {
    const { orderId } = await acceptCheckout();
    const hole = blackHoleQueue();
    const relay = newRelay(hole.queue);
    const requestsBefore = blackHole.requestCount();
    const round = relay.publishOnce();
    try {
      // O prazo de 5 s corre em tempo real dentro do SDK, não no relógio injetável: o teste mede o tempo decorrido.
      const outcome = await observe(round, 12_000);

      expect(
        blackHole.requestCount(),
        'o send não chegou ao servidor que não responde',
      ).toBeGreaterThan(requestsBefore);
      expect(outcome.state).toBe('rejected');
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(4_000);
      expect(outcome.elapsedMs).toBeLessThanOrEqual(9_000);
      expect((await readState(orderId)).publishedAt).toBeNull();
      expect(
        await rowLockIsFree(orderId),
        'a linha continuou bloqueada FOR UPDATE depois da rodada',
      ).toBe(true);
    } finally {
      // Sem prazo na porta a rodada nunca termina; soltar a conexão evita que ela trave os testes seguintes.
      hole.destroy();
      await observe(round, 10_000);
    }
  }, 40_000);

  it('ORD-22 sob start() o send sem resposta vira outbox.relay_error na rodada, e o stop não trava', async () => {
    const { orderId } = await acceptCheckout();
    const hole = blackHoleQueue();
    const logs = captureLogs();
    const { clock, sleeps } = watchSleeps();
    const relay = newRelay(hole.queue, { clock, logger: logs.logger });
    const requestsBefore = blackHole.requestCount();
    void relay.start();
    try {
      await vi.waitFor(
        () => expect(logs.eventsOf('outbox.relay_error')).toHaveLength(1),
        { timeout: 15_000, interval: 50 },
      );

      expect(
        blackHole.requestCount(),
        'o send não chegou ao servidor que não responde',
      ).toBeGreaterThan(requestsBefore);
      expect(logs.eventsOf('outbox.relay_error')[0]?.['level']).toBe('error');
      expect((await readState(orderId)).publishedAt).toBeNull();
      await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(1), {
        timeout: 5_000,
        interval: 10,
      });
      expect(sleeps[0]).toBe(500);
    } finally {
      hole.destroy();
      await stopRelay(relay, clock);
    }
  }, 40_000);
});

// ---------------------------------------------------------------- linha inválida e espera sem publicação (A3, A4)

// Linha escrita direto no SQL, fora da API: é a única forma de uma linha que o BillingMessage recusa chegar à outbox.
// `ageSeconds` define a ordem do relay: quanto maior, mais antiga.
async function insertOutboxRow(
  correlationId: string,
  ageSeconds: number,
): Promise<string> {
  const order = await database.pool.query<{ id: string }>(
    'insert into orders default values returning id',
  );
  const orderId = order.rows[0]?.id ?? '';
  await database.pool.query(
    'insert into outbox (order_id, correlation_id, created_at) values ($1, $2, now() - make_interval(secs => $3::double precision))',
    [orderId, correlationId, ageSeconds],
  );
  return orderId;
}

describe('ORD-22 relay com linha da outbox que não passa no BillingMessage', () => {
  it('ORD-22 a linha inválida (a mais antiga) é logada como outbox.invalid_row com o orderId e não impede as outras de saírem', async () => {
    const queues = await freshQueues();
    const invalidId = await insertOutboxRow('req com espaço', 100);
    const validIds = [
      await insertOutboxRow(`req-${randomUUID()}`, 30),
      await insertOutboxRow(`req-${randomUUID()}`, 20),
      await insertOutboxRow(`req-${randomUUID()}`, 10),
    ];
    const logs = captureLogs();
    const relay = newRelay(queues.queue, { logger: logs.logger });

    await expect(relay.publishOnce()).resolves.toBe(3);

    expect(await publishedOrderIds([invalidId, ...validIds])).toEqual(
      [...validIds].sort(),
    );
    expect(orderIdsIn(await drain(emq, queues.queueUrl))).toEqual(
      [...validIds].sort(),
    );
    const invalid = logs.eventsOf('outbox.invalid_row');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.['level']).toBe('error');
    expect(invalid[0]?.['orderId']).toBe(invalidId);
    expect(logs.eventsOf('outbox.relay_error')).toEqual([]);
  });

  it('ORD-22 uma rodada que leu um lote cheio de linhas inválidas e não publicou nada espera 500 ms pelo relógio, sem girar', async () => {
    const queues = await freshQueues();
    // Mais de batchSize (10) linhas inválidas e as mais antigas: o lote lido é cheio, mas nada é publicável.
    const invalidIds: string[] = [];
    for (let index = 0; index < DEFAULT_RELAY_CONFIG.batchSize; index += 1) {
      invalidIds.push(
        await insertOutboxRow(
          index % 2 === 0 ? 'req com espaço' : 'req-não-ascii-ç',
          1_000 - index,
        ),
      );
    }
    const logs = captureLogs();
    const { clock, sleeps } = watchSleeps();
    const relay = newRelay(queues.queue, { clock, logger: logs.logger });
    void relay.start();
    try {
      // Se o laço girasse sem esperar, o relógio nunca seria pedido e a espera abaixo estouraria o prazo.
      await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(1), {
        timeout: 5_000,
        interval: 10,
      });

      expect(sleeps[0]).toBe(500);
      expect(
        logs.eventsOf('outbox.relay_error'),
        'a linha inválida derrubou a rodada em vez de ficar fora do lote',
      ).toEqual([]);
      const logged = new Set(
        logs.eventsOf('outbox.invalid_row').map((line) => line['orderId']),
      );
      expect(logged).toEqual(new Set(invalidIds));
      expect(await publishedOrderIds(invalidIds)).toEqual([]);
      expect(await visibleCount(emq, queues.queueUrl)).toBe(0);
    } finally {
      await stopRelay(relay, clock);
    }
  }, 20_000);
});
