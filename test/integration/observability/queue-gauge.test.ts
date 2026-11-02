import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createTelemetry,
  type Telemetry,
} from '../../../src/shared/telemetry.ts';
import { waitAdvancing } from '../../helpers/async.ts';
import { buildReconciler, driveClock, moveToDlq } from '../../helpers/dlq.ts';
import { captureLogs, type CapturedLogs } from '../../helpers/logs.ts';
import {
  metricValue,
  scrapeMetrics,
  type Exposition,
} from '../../helpers/metrics.ts';
import { countsOf, sendRaw, type ObservedQueue } from '../../helpers/sqs.ts';
import {
  buildWorker,
  createGate,
  createWorld,
  markSentBefore,
  readOrder,
  stopAdvancing,
  submitOrder,
  useWorkerSuite,
  within,
  type Gate,
  type QueueWorld,
} from '../../helpers/worker.ts';

// `casecellshop.queue.messages` (design.md, "Observabilidade (AD-008)"): as mensagens visíveis mais as em voo
// (`ApproximateNumberOfMessages` e `ApproximateNumberOfMessagesNotVisible` do SQS, OBS-09) lidas a cada scrape no
// /metrics do worker, com `billing` (callback do worker) e `dlq` (callback da reconciliação). Cada callback entra no
// `start()` e sai no `stop()`.
//
// O laço do worker e o da reconciliação consomem a fila assim que começam. Para a contagem ficar estável, o
// primeiro recebimento de cada um fica preso num portão do teste, e as mensagens esperam na fila do ElasticMQ.
// Nesses testes nada fica em voo (o portão fica antes do recebimento), então visíveis e total coincidem; as mensagens
// em voo são o assunto dos testes OBS-09 mais abaixo.

const suiteOf = useWorkerSuite();
const telemetries: Telemetry[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

// O laço do start() usa o long polling de 1 s do design; sem ele giraria sem parar contra o ElasticMQ.
const LOOP_CONFIG = { receiveWaitSeconds: 1 };

interface Rig {
  telemetry: Telemetry;
  world: QueueWorld;
}

async function createRig(
  options: { maxReceiveCount?: number } = {},
): Promise<Rig> {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  const world = await createWorld(suiteOf(), { telemetry, ...options });
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

// Os testes do stop() contam as consultas do gauge à fila com `vi.spyOn(fila, 'approximateCount')`, que delega à
// implementação real (a leitura segue indo ao ElasticMQ). O critério é que o gauge deixe de consultar a fila; o que o
// /metrics mostra de uma série sem callback (o exportador do Prometheus é cumulativo e pode manter o último valor) é
// detalhe do SDK, e por isso os testes não o afirmam.

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

  it('OBS-02 depois do stop() o gauge billing deixa de consultar a fila, por mais scrapes e mensagens novas que haja', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const spy = vi.spyOn(world.queue, 'approximateCount');
    await scrapeMetrics(telemetry);
    expect(spy, 'scrape antes do start()').not.toHaveBeenCalled();
    const gate = await startHeld(worker, world.queue);
    expect(queueMessages(await scrapeMetrics(telemetry), 'billing')).toBe(1);
    expect(spy, 'um scrape com o worker iniciado').toHaveBeenCalledTimes(1);

    gate.releaseAll();
    await stopAdvancing(worker, world);

    spy.mockClear();
    await submit(world);
    await scrapeMetrics(telemetry);
    await submit(world);
    await scrapeMetrics(telemetry);
    expect(spy, 'scrapes depois do stop()').not.toHaveBeenCalled();
  });

  it('OBS-02 com o reconciliador iniciado a série dlq mostra as mensagens da DLQ, e depois do stop() o gauge deixa de consultar a DLQ', async () => {
    const { telemetry, world } = await createRig();
    await fillDlq(world, 3);
    const { reconciler, dlq } = buildReconciler(world, { telemetry });
    // Depois do portão a rodada falha ao receber e não toca nas mensagens: o teste só lê a contagem da fila.
    dlq.inject('receive', 1);
    const spy = vi.spyOn(dlq, 'approximateCount');
    expect(
      queueMessages(await scrapeMetrics(telemetry), 'dlq'),
      'antes do start()',
    ).toBeUndefined();
    expect(spy, 'scrape antes do start()').not.toHaveBeenCalled();

    const gate = await startHeld(reconciler, dlq);

    const families = await scrapeMetrics(telemetry);
    expect(queueMessages(families, 'dlq')).toBe(3);
    expect(spy, 'um scrape com o reconciliador iniciado').toHaveBeenCalledTimes(
      1,
    );
    expect(
      queueMessages(families, 'billing'),
      'o reconciliador não registra a série da fila de origem',
    ).toBeUndefined();

    gate.releaseAll();
    await driveClock(reconciler.stop(), world);

    spy.mockClear();
    await fillDlq(world, 2);
    await scrapeMetrics(telemetry);
    await scrapeMetrics(telemetry);
    expect(spy, 'scrapes depois do stop()').not.toHaveBeenCalled();
  });

  it('OBS-02 as séries billing e dlq convivem e cada gauge deixa de consultar a fila com o stop() do seu dono, sem misturar as contagens', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    await submit(world);
    await fillDlq(world, 3);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const { reconciler, dlq } = buildReconciler(world, { telemetry });
    dlq.inject('receive', 1);
    const billingSpy = vi.spyOn(world.queue, 'approximateCount');
    const dlqSpy = vi.spyOn(dlq, 'approximateCount');

    const workerGate = await startHeld(worker, world.queue);
    const reconcilerGate = await startHeld(reconciler, dlq);

    const both = await scrapeMetrics(telemetry);
    expect(queueMessages(both, 'billing')).toBe(2);
    expect(queueMessages(both, 'dlq')).toBe(3);
    expect(billingSpy).toHaveBeenCalledTimes(1);
    expect(dlqSpy).toHaveBeenCalledTimes(1);

    workerGate.releaseAll();
    await stopAdvancing(worker, world);
    billingSpy.mockClear();
    dlqSpy.mockClear();
    const afterWorker = await scrapeMetrics(telemetry);
    expect(queueMessages(afterWorker, 'dlq')).toBe(3);
    expect(
      billingSpy,
      'o worker parou: billing não é consultada',
    ).not.toHaveBeenCalled();
    expect(
      dlqSpy,
      'o reconciliador segue: dlq é consultada',
    ).toHaveBeenCalledTimes(1);

    reconcilerGate.releaseAll();
    await driveClock(reconciler.stop(), world);
    dlqSpy.mockClear();
    await scrapeMetrics(telemetry);
    expect(
      dlqSpy,
      'o reconciliador parou: dlq não é consultada',
    ).not.toHaveBeenCalled();
    expect(billingSpy).not.toHaveBeenCalled();
  });
});

// OBS-09: o gauge soma as mensagens visíveis e as em voo. O ElasticMQ real conta cada uma; os testes provam, com os
// atributos crus do GetQueueAttributes, que a mensagem estava mesmo escondida na hora do scrape, para o valor do
// gauge não coincidir por acaso com a contagem das visíveis.
async function expectTwoVisibleOneInFlight(
  world: QueueWorld,
  telemetry: Telemetry,
): Promise<void> {
  expect(
    await countsOf(world.emq, world.queues.queueUrl),
    'no SQS: 2 visíveis e 1 em voo',
  ).toEqual({ visible: 2, notVisible: 1 });
  expect(queueMessages(await scrapeMetrics(telemetry), 'billing')).toBe(3);
}

describe('OBS-09 casecellshop.queue.messages conta as mensagens visíveis e as em voo', () => {
  it('OBS-09 a mensagem da DLQ que a reconciliação recebeu e segura invisível (visibilidade de 300 s) segue contada: o gauge dlq mostra 1, durante a rodada e depois dela', async () => {
    const { telemetry, world } = await createRig({ maxReceiveCount: 1 });
    const order = await submitOrder(suiteOf(), world);
    await markSentBefore(suiteOf().pool, order.orderId);
    await moveToDlq(world, 1, 1);
    // Sem o ERP a rodada não conclui o pedido: a mensagem fica na DLQ, escondida pelo recebimento.
    world.sim.script.setDefault({ mode: 'unavailable' });
    const logs = captureLogs('casecellshop-worker');
    const { reconciler, dlq } = buildReconciler(world, {
      telemetry,
      logger: logs.logger,
    });
    // A rodada para depois de o SQS responder e antes de tratar a mensagem: ela já está em voo.
    const gate = createGate();
    dlq.afterReceive(() => gate.park());

    await reconciler.start();
    try {
      await within(gate.waitForParked(1), 'a rodada receber a mensagem da DLQ');

      expect(
        await countsOf(world.emq, world.queues.dlqUrl),
        'a mensagem está invisível no SQS na hora do scrape',
      ).toEqual({ visible: 0, notVisible: 1 });
      expect(queueMessages(await scrapeMetrics(telemetry), 'dlq')).toBe(1);

      gate.releaseAll();
      await waitAdvancing(world.advanceIdle, () => {
        expect(
          logs.eventsOf('casecellshop.outbox.reconciliation.completed').length,
          'a rodada terminou',
        ).toBeGreaterThanOrEqual(1);
      });

      expect(
        await countsOf(world.emq, world.queues.dlqUrl),
        'a rodada deixou a mensagem na DLQ, ainda escondida',
      ).toEqual({ visible: 0, notVisible: 1 });
      expect((await readOrder(suiteOf().pool, order.orderId)).status).toBe(
        'pending',
      );
      expect(queueMessages(await scrapeMetrics(telemetry), 'dlq')).toBe(1);
    } finally {
      gate.releaseAll();
      await driveClock(reconciler.stop(), world);
    }
  });

  it('OBS-09 na fila billing, uma mensagem recebida e ainda em voo soma às visíveis: 2 visíveis e 1 em voo mostram 3', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    await submit(world);
    await submit(world);
    const held = await world.queues.queue.receive({
      max: 1,
      waitSeconds: 0,
      visibilitySeconds: 300,
    });
    expect(held, 'uma mensagem recebida e não apagada').toHaveLength(1);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    const gate = await startHeld(worker, world.queue);
    try {
      await expectTwoVisibleOneInFlight(world, telemetry);
    } finally {
      gate.releaseAll();
      await stopAdvancing(worker, world);
    }
  });

  it('OBS-09 a mensagem que o próprio worker recebeu e segura em voo conta no gauge billing, junto das visíveis que chegam depois', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    const worker = buildWorker(world, { config: LOOP_CONFIG });
    // O recebimento volta do SQS e o laço para antes de tratar a mensagem: ela está em voo, nas mãos do worker.
    const gate = createGate();
    world.queue.afterReceive(() => gate.park());
    await worker.start();
    try {
      await within(gate.waitForParked(1), 'o worker receber a mensagem');
      await submit(world);
      await submit(world);

      await expectTwoVisibleOneInFlight(world, telemetry);
    } finally {
      gate.releaseAll();
      await stopAdvancing(worker, world);
    }
  });

  it('OBS-09 a mensagem em retry, escondida pelo backoff depois de o ERP falhar, segue contada no gauge billing', async () => {
    const { telemetry, world } = await createRig();
    await submit(world);
    world.sim.script.setDefault({ mode: 'unavailable' });
    const worker = buildWorker(world, { config: LOOP_CONFIG });

    await worker.start();
    try {
      await waitAdvancing(world.advanceIdle, () => {
        expect(
          world.queue.visibilityChanges.some((call) => call.result === 'ok'),
          'o worker escondeu a mensagem com o backoff',
        ).toBe(true);
      });

      expect(
        await countsOf(world.emq, world.queues.queueUrl),
        'no SQS: nenhuma visível, 1 em voo (escondida)',
      ).toEqual({ visible: 0, notVisible: 1 });
      expect(queueMessages(await scrapeMetrics(telemetry), 'billing')).toBe(1);
    } finally {
      await stopAdvancing(worker, world);
    }
  });
});

// Leitura que falha (design.md, "Leitura que falha"): o SDK segue exportando o último valor do gauge, então o
// /metrics não denuncia a falha. O sinal é o counter de falhas e o log de erro; o valor do gauge no scrape que falhou
// é detalhe do SDK e não é afirmado. A falha entra na fronteira: o `approximateCount` da fila rejeita uma vez.
function queueReadFailures(families: Exposition): number {
  return (
    metricValue(families, 'casecellshop.billing.gauge.read_failures', {
      'casecellshop.gauge.name': 'queue_messages',
    }) ?? 0
  );
}

const READ_FAILED = 'casecellshop.billing.gauge.read_failed';

interface FailureRig {
  telemetry: Telemetry;
  logs: CapturedLogs;
  // Delega à fila de verdade; o teste faz só a próxima chamada rejeitar.
  count: MockInstance<() => Promise<number>>;
  stop(): Promise<void>;
}

// O worker iniciado sobre a fila de origem com uma mensagem, e o logger que captura as linhas.
async function startBillingRig(): Promise<FailureRig> {
  const { telemetry, world } = await createRig();
  await submit(world);
  const logs = captureLogs('casecellshop-worker');
  const worker = buildWorker(world, {
    config: LOOP_CONFIG,
    logger: logs.logger,
  });
  const gate = await startHeld(worker, world.queue);
  const count = vi.spyOn(world.queue, 'approximateCount');
  return {
    telemetry,
    logs,
    count,
    async stop() {
      gate.releaseAll();
      await stopAdvancing(worker, world);
    },
  };
}

// O reconciliador iniciado sobre a DLQ com duas mensagens.
async function startDlqRig(): Promise<FailureRig> {
  const { telemetry, world } = await createRig();
  await fillDlq(world, 2);
  const logs = captureLogs('casecellshop-worker');
  const { reconciler, dlq } = buildReconciler(world, {
    telemetry,
    logger: logs.logger,
  });
  // Depois do portão a rodada falha ao receber e não toca nas mensagens: o teste só lê a contagem da fila.
  dlq.inject('receive', 1);
  const gate = await startHeld(reconciler, dlq);
  const count = vi.spyOn(dlq, 'approximateCount');
  return {
    telemetry,
    logs,
    count,
    async stop() {
      gate.releaseAll();
      await driveClock(reconciler.stop(), world);
    },
  };
}

// Uma leitura boa, uma que rejeita (injetada na fronteira) e uma de recuperação: a boa não deixa sinal, a que falha
// deixa o evento de erro e o counter, este visto no scrape seguinte porque a ordem entre o callback e o counter dentro
// do mesmo scrape é do SDK.
async function expectReadFailureSignal(
  rig: FailureRig,
  queue: 'billing' | 'dlq',
  messages: number,
): Promise<void> {
  const { telemetry, logs, count } = rig;
  const good = await scrapeMetrics(telemetry);
  expect(queueMessages(good, queue)).toBe(messages);
  expect(queueReadFailures(good), 'a leitura boa não soma').toBe(0);
  expect(logs.eventsOf(READ_FAILED), 'a leitura boa não loga').toEqual([]);

  count.mockRejectedValueOnce(new Error('SQS indisponível (injetado)'));
  await scrapeMetrics(telemetry);

  expect(
    count.mock.settledResults.filter((result) => result.type === 'rejected'),
    'a falha injetada disparou',
  ).toHaveLength(1);
  const events = logs.eventsOf(READ_FAILED);
  expect(events).toHaveLength(1);
  expect(events[0]?.['level']).toBe('error');
  expect(events[0]?.['gauge']).toBe('queue_messages');
  expect(JSON.stringify(events[0]?.['err'])).toContain('SQS indisponível');
  const recovered = await scrapeMetrics(telemetry);
  expect(queueReadFailures(recovered)).toBe(1);
  expect(queueMessages(recovered, queue)).toBe(messages);
  expect(
    logs.eventsOf(READ_FAILED),
    'a leitura que se recupera não loga de novo',
  ).toHaveLength(1);
}

describe('OBS-02 a leitura da fila que falha é contada e logada', () => {
  it('OBS-02 o GetQueueAttributes do worker que falha depois de uma leitura boa soma 1 em billing.gauge.read_failures com queue_messages e escreve gauge.read_failed', async () => {
    const rig = await startBillingRig();

    await expectReadFailureSignal(rig, 'billing', 1);

    await rig.stop();
  });

  it('OBS-02 o GetQueueAttributes da DLQ que falha no reconciliador também soma em queue_messages e escreve gauge.read_failed', async () => {
    const rig = await startDlqRig();

    await expectReadFailureSignal(rig, 'dlq', 2);

    await rig.stop();
  });

  it('OBS-02 a leitura da fila que dá certo, scrape após scrape, não soma em billing.gauge.read_failures nem escreve gauge.read_failed', async () => {
    const rig = await startBillingRig();

    await scrapeMetrics(rig.telemetry);
    await scrapeMetrics(rig.telemetry);
    const families = await scrapeMetrics(rig.telemetry);

    expect(rig.count, 'três leituras').toHaveBeenCalledTimes(3);
    expect(queueReadFailures(families)).toBe(0);
    expect(rig.logs.eventsOf(READ_FAILED)).toEqual([]);
    await rig.stop();
  });
});
