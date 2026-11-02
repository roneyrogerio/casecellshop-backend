import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTelemetry,
  type Telemetry,
} from '../../../src/shared/telemetry.ts';
import { buildReconciler, driveClock } from '../../helpers/dlq.ts';
import {
  metricValue,
  scrapeMetrics,
  type Exposition,
} from '../../helpers/metrics.ts';
import { sendRaw, type ObservedQueue } from '../../helpers/sqs.ts';
import {
  buildWorker,
  createGate,
  createWorld,
  stopAdvancing,
  submitOrder,
  useWorkerSuite,
  within,
  type Gate,
  type QueueWorld,
} from '../../helpers/worker.ts';

// `casecellshop.queue.messages` (design.md, "Quando as métricas de fila e de estoque (M5) sobem"): o
// `ApproximateNumberOfMessages` do SQS lido a cada scrape no /metrics do worker, com `billing` (callback do worker)
// e `dlq` (callback da reconciliação). Cada callback entra no `start()` e sai no `stop()`.
//
// O laço do worker e o da reconciliação consomem a fila assim que começam. Para a contagem ficar estável, o
// primeiro recebimento de cada um fica preso num portão do teste, e as mensagens esperam na fila do ElasticMQ.

const suiteOf = useWorkerSuite();
const telemetries: Telemetry[] = [];

afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

// O laço do start() usa o long polling de 1 s do design; sem ele giraria sem parar contra o ElasticMQ.
const LOOP_CONFIG = { receiveWaitSeconds: 1 };

interface Rig {
  telemetry: Telemetry;
  world: QueueWorld;
}

async function createRig(): Promise<Rig> {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  const world = await createWorld(suiteOf(), { telemetry });
  return { telemetry, world };
}

// Uma mensagem de pedido na fila de origem deste teste.
function submit(world: QueueWorld): Promise<unknown> {
  return submitOrder(suiteOf(), world);
}

function queueMessages(
  families: Exposition,
  queue: 'billing' | 'dlq',
): number | undefined {
  return metricValue(families, 'casecellshop.queue.messages', {
    'casecellshop.queue.name': queue,
  });
}

// Mensagens na DLQ sem passar pelo limite de recebimentos: a reconciliação só as lê quando recebe.
async function fillDlq(world: QueueWorld, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1)
    await sendRaw(world.emq, world.queues.dlqUrl, `{"n":${index}}`);
}

// Prende o primeiro recebimento do laço no portão antes de iniciá-lo e espera o laço chegar lá: dali em diante a
// fila não perde mensagens, e o `start()` já registrou o callback do gauge.
async function startHeld(
  loop: { start(): Promise<void> },
  queue: ObservedQueue,
): Promise<Gate> {
  const gate = createGate();
  queue.beforeReceive(() => gate.park());
  await loop.start();
  await within(gate.waitForParked(1), 'o laço pedir mensagens ao SQS');
  return gate;
}

describe('OBS-02 casecellshop.queue.messages no /metrics do worker', () => {
  it('OBS-02 antes do start() a série billing não aparece; com o worker iniciado mostra as mensagens da fila, a cada scrape', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    await submit(world);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    expect(
      queueMessages(await scrapeMetrics(telemetry), 'billing'),
      'antes do start()',
    ).toBeUndefined();

    const gate = await startHeld(worker, world.queue);

    const families = await scrapeMetrics(telemetry);
    expect(families.get('casecellshop_queue_messages')?.type).toBe('gauge');
    expect(queueMessages(families, 'billing')).toBe(2);
    expect(
      queueMessages(families, 'dlq'),
      'o worker não registra a série da DLQ',
    ).toBeUndefined();
    await submit(world);
    expect(queueMessages(await scrapeMetrics(telemetry), 'billing')).toBe(3);

    gate.releaseAll();
    await stopAdvancing(worker, world);
  });

  it('OBS-02 depois do stop() a série billing some do /metrics', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = await startHeld(worker, world.queue);
    expect(queueMessages(await scrapeMetrics(telemetry), 'billing')).toBe(1);

    gate.releaseAll();
    await stopAdvancing(worker, world);

    const families = await scrapeMetrics(telemetry);
    expect(queueMessages(families, 'billing')).toBeUndefined();
    expect(queueMessages(families, 'dlq')).toBeUndefined();
  });

  it('OBS-02 com o reconciliador iniciado a série dlq mostra as mensagens da DLQ, e depois do stop() ela some', async () => {
    const { telemetry, world } = await createRig();
    await fillDlq(world, 3);
    const { reconciler, dlq } = buildReconciler(world, { telemetry });
    // Depois do portão a rodada falha ao receber e não toca nas mensagens: o teste só lê a contagem da fila.
    dlq.inject('receive', 1);
    expect(
      queueMessages(await scrapeMetrics(telemetry), 'dlq'),
      'antes do start()',
    ).toBeUndefined();

    const gate = await startHeld(reconciler, dlq);

    const families = await scrapeMetrics(telemetry);
    expect(queueMessages(families, 'dlq')).toBe(3);
    expect(
      queueMessages(families, 'billing'),
      'o reconciliador não registra a série da fila de origem',
    ).toBeUndefined();

    gate.releaseAll();
    await driveClock(reconciler.stop(), world);

    expect(
      queueMessages(await scrapeMetrics(telemetry), 'dlq'),
    ).toBeUndefined();
  });

  it('OBS-02 as séries billing e dlq convivem e saem cada uma com o stop() do seu dono, sem misturar as contagens', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    await submit(world);
    await fillDlq(world, 3);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const { reconciler, dlq } = buildReconciler(world, { telemetry });
    dlq.inject('receive', 1);

    const workerGate = await startHeld(worker, world.queue);
    const reconcilerGate = await startHeld(reconciler, dlq);

    const both = await scrapeMetrics(telemetry);
    expect(queueMessages(both, 'billing')).toBe(2);
    expect(queueMessages(both, 'dlq')).toBe(3);

    workerGate.releaseAll();
    await stopAdvancing(worker, world);
    const afterWorker = await scrapeMetrics(telemetry);
    expect(queueMessages(afterWorker, 'billing')).toBeUndefined();
    expect(queueMessages(afterWorker, 'dlq')).toBe(3);

    reconcilerGate.releaseAll();
    await driveClock(reconciler.stop(), world);
    expect(
      queueMessages(await scrapeMetrics(telemetry), 'dlq'),
    ).toBeUndefined();
  });
});
