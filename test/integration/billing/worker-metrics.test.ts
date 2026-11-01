import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerConfig } from '../../../src/billing/worker.ts';
import {
  createTelemetry,
  type Telemetry,
} from '../../../src/shared/telemetry.ts';
import { captureLogs } from '../../helpers/logs.ts';
import {
  familyOf,
  histogramCount,
  labelNames,
  metricValue,
  promLabel,
  scrapeMetrics,
  type Exposition,
  type MetricName,
  type MetricType,
} from '../../helpers/metrics.ts';
import {
  ageLastCall,
  buildWorker,
  createWorld,
  makeClaimable,
  markSentBefore,
  startWorkerSuite,
  stealMessage,
  submitOrder,
  waitForDlq,
  type AcceptedOrder,
  type QueueWorld,
  type SubmitOptions,
  type WorkerSuite,
  type WorldOptions,
} from '../../helpers/worker.ts';

// /metrics do worker (OBS-02 do M3) e o alerta de configuração do ERP (ORD-10), com o worker sobre o SQS.

let suite: WorkerSuite;
const telemetries: Telemetry[] = [];

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await suite?.stop();
});

afterEach(async () => {
  suite.releaseWorlds();
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
});

interface Rig {
  telemetry: Telemetry;
  world: QueueWorld;
  submit(options?: SubmitOptions): Promise<AcceptedOrder>;
  run(config?: Partial<WorkerConfig>): Promise<number>;
  scrape(): Promise<Exposition>;
}

// Telemetria própria de cada teste, para o worker e a camada anticorrupção do ERP: os contadores
// começam do zero e os valores lidos são os do cenário. A fila também é só dele.
async function createRig(options: WorldOptions = {}): Promise<Rig> {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  const world = await createWorld(suite, { ...options, telemetry });
  return {
    telemetry,
    world,
    submit: (submitOptions) => submitOrder(suite, world, submitOptions),
    run: (config) => buildWorker(world, config ? { config } : {}).pollOnce(),
    scrape: () => scrapeMetrics(telemetry),
  };
}

// `dead` fica de fora: quem o conta é a reconciliação, ao ver a mensagem na DLQ (Fatia 3), e não o worker.
const ATTEMPT_OUTCOMES = [
  'invoiced',
  'failed',
  'retry',
  'closed',
  'lease_short',
  'deferred',
];
const ERP_OPERATIONS = ['create_order', 'find_order', 'list_catalog'];
const ERP_OUTCOMES = [
  'ok',
  'found',
  'not_found',
  'permanent',
  'transient',
  'ambiguous',
  'config_error',
];

function attemptOutcome(
  families: Exposition,
  outcome: string,
): number | undefined {
  return metricValue(families, 'casecellshop.outbox.attempts', {
    'casecellshop.outbox.attempt.outcome': outcome,
  });
}

// As chamadas ao ERP por operação e desfecho são o `_count` do histograma de duração (AD-029): não há mais um
// contador à parte, e o erro de configuração é um dos desfechos.
function erpRequests(
  families: Exposition,
  operation: string,
  outcome: string,
): number | undefined {
  return histogramCount(
    families,
    'casecellshop.erp.client.operation.duration',
    {
      'casecellshop.erp.operation': operation,
      'casecellshop.erp.outcome': outcome,
    },
  );
}

function acceptCount(families: Exposition): number {
  return (
    histogramCount(families, 'casecellshop.order.accept_to_invoice.duration') ??
    0
  );
}

function orphanConclusions(families: Exposition): number | undefined {
  return metricValue(families, 'casecellshop.outbox.orphan_conclusions');
}

function activeOperations(families: Exposition): number | undefined {
  return metricValue(families, 'casecellshop.erp.client.active_operations');
}

// Um pedido cuja criação no ERP falha uma vez por indisponibilidade, uma rodada do worker e o /metrics depois dela.
async function scrapeAfterTransientCreateError(): Promise<Exposition> {
  const rig = await createRig();
  const order = await rig.submit();
  rig.world.sim.script.enqueue(
    { mode: 'unavailable' },
    { op: 'createOrder', reference: order.orderId },
  );

  await rig.run();

  return rig.scrape();
}

describe('OBS-02 /metrics do worker: nomes, tipos e labels do design', () => {
  it('OBS-02 depois de cenários que exercitam cada métrica, o /metrics expõe todas com o tipo do design', async () => {
    const rig = await createRig();
    // Faturado: desfecho, aceite ao faturamento e chamada ao ERP.
    await rig.submit();
    await rig.run();
    // Falta de estoque no ERP: a rejeição permanente que a H2 conta.
    await rig.submit({ erpOnHand: 0 });
    await rig.run();
    // Erro de configuração do ERP: o alerta.
    const misconfigured = await rig.submit();
    rig.world.sim.script.enqueue(
      { mode: 'status', status: 401 },
      { op: 'createOrder', reference: misconfigured.orderId },
    );
    await rig.run();
    // Conclusão sem linha afetada: outro consumidor recebe a mensagem durante a chamada.
    const stolen = await rig.submit();
    rig.world.transport.afterErp(
      { op: 'createOrder', reference: stolen.orderId },
      () => stealMessage(rig.world, stolen.orderId),
    );
    await rig.run();

    const families = await rig.scrape();
    const expected: [MetricName, MetricType][] = [
      ['casecellshop.outbox.attempts', 'counter'],
      ['casecellshop.outbox.orphan_conclusions', 'counter'],
      ['casecellshop.order.accept_to_invoice.duration', 'histogram'],
      ['casecellshop.erp.client.operation.duration', 'histogram'],
      ['casecellshop.erp.client.active_operations', 'gauge'],
      ['casecellshop.erp.out_of_stock.rejections', 'counter'],
    ];
    for (const [name, type] of expected) {
      expect(
        familyOf(families, name)?.type,
        `métrica ${name} com o tipo ${type}`,
      ).toBe(type);
    }
    // Uma série por fato (AD-029): o `_count` do histograma do ERP substituiu os dois contadores.
    expect(families.has('erp_request_total')).toBe(false);
    expect(families.has('erp_config_error_total')).toBe(false);
    expect(
      erpRequests(families, 'create_order', 'config_error'),
      'o erro de configuração é um desfecho do histograma',
    ).toBe(1);
  });

  it('OBS-02 os atributos do desfecho da tentativa e da operação e do desfecho do ERP vêm das listas fechadas, e nenhuma série tem orderId nem sku', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    await rig.run();
    const retried = await rig.submit();
    rig.world.sim.script.enqueue(
      { mode: 'unavailable' },
      { op: 'createOrder', reference: retried.orderId },
    );
    await rig.run();

    const families = await rig.scrape();
    const outcomes =
      familyOf(families, 'casecellshop.outbox.attempts')?.samples ?? [];
    expect(outcomes.length).toBeGreaterThan(0);
    for (const sample of outcomes)
      expect(ATTEMPT_OUTCOMES).toContain(
        sample.labels[promLabel('casecellshop.outbox.attempt.outcome')],
      );
    const erpSamples =
      familyOf(families, 'casecellshop.erp.client.operation.duration')
        ?.samples ?? [];
    expect(erpSamples.length, 'a duração do ERP tem séries').toBeGreaterThan(0);
    for (const sample of erpSamples) {
      expect(ERP_OPERATIONS).toContain(
        sample.labels[promLabel('casecellshop.erp.operation')],
      );
      expect(ERP_OUTCOMES).toContain(
        sample.labels[promLabel('casecellshop.erp.outcome')],
      );
    }
    const labels = labelNames(families);
    for (const forbidden of ['orderId', 'order_id', 'sku'])
      expect(labels.has(forbidden), `label ${forbidden}`).toBe(false);
    // Os atributos próprios levam o prefixo do serviço, e nenhum nome de atributo cita pedido nem SKU.
    for (const name of labels) expect(name).not.toMatch(/order|sku/i);
    for (const family of families.values()) {
      for (const sample of family.samples) {
        for (const value of Object.values(sample.labels)) {
          expect(value).not.toContain(order.orderId);
          expect(value).not.toContain(order.sku);
        }
      }
    }
  });
});

describe('OBS-02 os valores sobem nos cenários certos', () => {
  it('OBS-02 uma fatura soma 1 em invoiced, 1 no aceite ao faturamento (fronteira em 60 s) e 1 na criação ok; a gauge de chamadas volta a 0', async () => {
    const rig = await createRig();
    await rig.submit();

    await rig.run();

    const families = await rig.scrape();
    expect(attemptOutcome(families, 'invoiced')).toBe(1);
    for (const other of ATTEMPT_OUTCOMES.filter(
      (name) => name !== 'invoiced',
    )) {
      expect(attemptOutcome(families, other) ?? 0, `desfecho ${other}`).toBe(0);
    }
    expect(acceptCount(families)).toBe(1);
    expect(
      metricValue(
        families,
        'casecellshop.order.accept_to_invoice.duration',
        { le: '60' },
        '_bucket',
      ),
      'fronteira em 60 s',
    ).toBeDefined();
    expect(erpRequests(families, 'create_order', 'ok')).toBe(1);
    expect(
      metricValue(
        families,
        'casecellshop.erp.client.operation.duration',
        {
          'casecellshop.erp.operation': 'create_order',
          'casecellshop.erp.outcome': 'ok',
          le: '30',
        },
        '_bucket',
      ),
      'fronteira em 30 s',
    ).toBeDefined();
    expect(activeOperations(families)).toBe(0);
    expect(orphanConclusions(families) ?? 0).toBe(0);
  });

  it('OBS-02 o up_down_counter casecellshop.erp.client.active_operations vale 1 enquanto a chamada ao ERP está em andamento', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    let during: number | undefined;
    rig.world.transport.afterErp(
      { op: 'createOrder', reference: order.orderId },
      async () => {
        during = activeOperations(await rig.scrape());
      },
    );

    await rig.run();

    expect(during).toBe(1);
    expect(activeOperations(await rig.scrape())).toBe(0);
  });

  it('OBS-02 a consulta antes de criar conta find_order: found quando o ERP já tem a fatura, not_found quando não tem', async () => {
    const rig = await createRig();
    const missing = await rig.submit();
    await markSentBefore(suite.pool, missing.orderId);
    await rig.run();
    // Um segundo pedido que o ERP já faturou antes: a consulta o encontra e não cria de novo.
    const known = await rig.submit();
    const created = await rig.world.erp.createOrder({
      reference: known.orderId,
      items: [
        {
          sku: known.sku,
          quantity: known.quantity,
          unitPriceCents: known.priceCents,
        },
      ],
    });
    expect(created.kind).toBe('ok');
    await markSentBefore(suite.pool, known.orderId);
    await rig.run();

    const families = await rig.scrape();
    expect(erpRequests(families, 'find_order', 'not_found')).toBe(1);
    expect(erpRequests(families, 'find_order', 'found')).toBe(1);
  });

  it('OBS-02 um erro transitório do ERP soma 1 em retry e 1 em transient na criação', async () => {
    const families = await scrapeAfterTransientCreateError();

    expect(attemptOutcome(families, 'retry')).toBe(1);
    expect(erpRequests(families, 'create_order', 'transient')).toBe(1);
    expect(acceptCount(families)).toBe(0);
  });

  it('OBS-02 a rejeição por falta de estoque soma 1 no counter dela e a rejeição comum não soma; as duas contam em failed e em permanent', async () => {
    const rig = await createRig();
    const outOfStock = await rig.submit({ quantity: 2, erpOnHand: 0 });
    const rejected = await rig.submit();
    rig.world.sim.script.enqueue(
      { mode: 'reject' },
      { op: 'createOrder', reference: rejected.orderId },
    );

    expect(await rig.run()).toBe(2);

    const families = await rig.scrape();
    expect(
      metricValue(families, 'casecellshop.erp.out_of_stock.rejections'),
      `rejeição por estoque de ${outOfStock.orderId}`,
    ).toBe(1);
    expect(attemptOutcome(families, 'failed')).toBe(2);
    expect(erpRequests(families, 'create_order', 'permanent')).toBe(2);
  });

  it('OBS-02 a mensagem que o SQS move para a DLQ pelo limite de recebimentos não soma dead nem loga outbox.dead no worker: isso é da reconciliação', async () => {
    const rig = await createRig({ maxReceiveCount: 1 });
    const logs = captureLogs();
    const order = await rig.submit();
    rig.world.sim.script.enqueue(
      { mode: 'unavailable' },
      { op: 'createOrder', reference: order.orderId },
    );
    const worker = buildWorker(rig.world, { logger: logs.logger });

    expect(await worker.pollOnce()).toBe(1);
    await makeClaimable(rig.world, order.orderId);
    // O recebimento seguinte ao limite: o SQS move a mensagem para a DLQ, e o worker não a vê.
    expect(await worker.pollOnce()).toBe(0);
    await waitForDlq(rig.world, 1);

    const families = await rig.scrape();
    expect(attemptOutcome(families, 'retry')).toBe(1);
    expect(attemptOutcome(families, 'dead') ?? 0).toBe(0);
    expect(logs.eventsOf('outbox.dead')).toEqual([]);
  });

  it('OBS-02 uma mensagem de pedido que já não está pending soma 1 em closed, sem chamar o ERP', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    await suite.pool.query(
      "update orders set status = 'invoiced', outcome_at = now() where id = $1",
      [order.orderId],
    );

    await rig.run();

    const families = await rig.scrape();
    expect(attemptOutcome(families, 'closed')).toBe(1);
    expect(rig.world.transport.sends).toHaveLength(0);
  });

  it('OBS-02 uma visibilidade curta demais para a chamada soma 1 em lease_short, sem chamar o ERP', async () => {
    const rig = await createRig();
    await rig.submit();

    await rig.run({ visibilitySeconds: 11 });

    const families = await rig.scrape();
    expect(attemptOutcome(families, 'lease_short')).toBe(1);
    expect(rig.world.transport.sends).toHaveLength(0);
  });

  it('OBS-02 a mensagem adiada por falta da permissão de chamada soma 1 em deferred, sem chamar o ERP', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    await markSentBefore(suite.pool, order.orderId);
    await ageLastCall(suite.pool, order.orderId, 10);

    await rig.run();

    const families = await rig.scrape();
    expect(attemptOutcome(families, 'deferred')).toBe(1);
    for (const other of ATTEMPT_OUTCOMES.filter(
      (name) => name !== 'deferred',
    )) {
      expect(attemptOutcome(families, other) ?? 0, `desfecho ${other}`).toBe(0);
    }
    expect(rig.world.transport.sends).toHaveLength(0);
  });

  it('OBS-02 o pedido que mudou de estado fora do fluxo entre a chamada e a conclusão não soma invoiced nem registra amostra no aceite ao faturamento', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    rig.world.transport.afterErp(
      { op: 'createOrder', reference: order.orderId },
      async () => {
        await suite.pool.query(
          "update orders set status = 'failed', failure_reason = 'cancelled', outcome_at = now() where id = $1",
          [order.orderId],
        );
      },
    );

    await rig.run();

    const families = await rig.scrape();
    expect(attemptOutcome(families, 'invoiced') ?? 0).toBe(0);
    expect(acceptCount(families)).toBe(0);
    // O ERP chegou a faturar, mas a loja não conta o pedido que já tinha outro desfecho.
    expect(erpRequests(families, 'create_order', 'ok')).toBe(1);
  });

  it.each([
    ['fatura', 'invoiced'],
    ['fatura', 'failed'],
    ['rejeição', 'invoiced'],
    ['rejeição', 'failed'],
  ] as const)(
    'OBS-02 conclusão por %s com o pedido já %s fora do fluxo: apaga a mensagem, soma 1 em closed e nada em invoiced, failed nem no aceite ao faturamento',
    async (result, externalStatus) => {
      // A conclusão da fatura e a da rejeição têm de reconhecer o mesmo pedido já concluído.
      const rig = await createRig();
      const order = await rig.submit();
      if (result === 'rejeição')
        rig.world.sim.script.enqueue(
          { mode: 'reject' },
          { op: 'createOrder', reference: order.orderId },
        );
      rig.world.transport.afterErp(
        { op: 'createOrder', reference: order.orderId },
        async () => {
          await suite.pool.query(
            externalStatus === 'invoiced'
              ? "update orders set status = 'invoiced', outcome_at = now() where id = $1"
              : "update orders set status = 'failed', failure_reason = 'cancelled', outcome_at = now() where id = $1",
            [order.orderId],
          );
        },
      );

      await rig.run();

      const families = await rig.scrape();
      expect(attemptOutcome(families, 'closed')).toBe(1);
      expect(attemptOutcome(families, 'invoiced') ?? 0).toBe(0);
      expect(attemptOutcome(families, 'failed') ?? 0).toBe(0);
      expect(acceptCount(families)).toBe(0);
      expect(
        rig.world.queue.deletesOf(order.orderId).map((call) => call.result),
      ).toEqual(['ok']);
    },
  );

  it('OBS-02 uma conclusão que o SQS recusa (receipt handle antigo) soma 1 em casecellshop.outbox.orphan_conclusions e nada no desfecho da tentativa além do que o banco gravou', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    rig.world.transport.afterErp(
      { op: 'createOrder', reference: order.orderId },
      () => stealMessage(rig.world, order.orderId),
    );

    await rig.run();

    const families = await rig.scrape();
    expect(orphanConclusions(families)).toBe(1);
    // O banco já estava protegido pelo compare-and-set: o pedido foi faturado, e o desfecho conta uma vez.
    expect(attemptOutcome(families, 'invoiced')).toBe(1);
    expect(
      rig.world.queue.deletesOf(order.orderId).map((call) => call.result),
    ).toEqual(['stale']);
  });

  it('OBS-02 o closed só conta quando o DeleteMessage sai ok: com o receipt handle antigo (stale), não soma closed e soma 1 em casecellshop.outbox.orphan_conclusions', async () => {
    const rig = await createRig();
    const logs = captureLogs();
    const order = await rig.submit();
    await suite.pool.query(
      "update orders set status = 'invoiced', outcome_at = now() where id = $1",
      [order.orderId],
    );
    // Outro consumidor recebe a mensagem entre o recebimento do worker e o DeleteMessage dele.
    rig.world.queue.afterReceive(() => stealMessage(rig.world, order.orderId));

    await buildWorker(rig.world, { logger: logs.logger }).pollOnce();

    const families = await rig.scrape();
    expect(
      rig.world.queue.deletesOf(order.orderId).map((call) => call.result),
    ).toEqual(['stale']);
    expect(attemptOutcome(families, 'closed') ?? 0).toBe(0);
    expect(orphanConclusions(families)).toBe(1);
    expect(
      logs.eventsOf('outbox.conclusion_no_row', order.orderId),
    ).toHaveLength(1);
    expect(rig.world.transport.sends).toHaveLength(0);
  });

  it('OBS-02 um retry que o SQS recusa (receipt handle antigo) soma em casecellshop.outbox.orphan_conclusions e não em retry', async () => {
    const rig = await createRig();
    const logs = captureLogs();
    const order = await rig.submit();
    rig.world.sim.script.enqueue(
      { mode: 'unavailable' },
      { op: 'createOrder', reference: order.orderId },
    );
    rig.world.transport.afterErp(
      { op: 'createOrder', reference: order.orderId },
      () => stealMessage(rig.world, order.orderId),
    );

    await buildWorker(rig.world, { logger: logs.logger }).pollOnce();

    const families = await rig.scrape();
    expect(orphanConclusions(families)).toBe(1);
    expect(attemptOutcome(families, 'retry') ?? 0).toBe(0);
    expect(
      rig.world.queue.changesOf(order.orderId).map((call) => call.result),
    ).toEqual(['stale']);
    // O retry só é logado quando a visibilidade de fato mudou.
    expect(logs.eventsOf('outbox.retry', order.orderId)).toEqual([]);
    expect(
      logs.eventsOf('outbox.conclusion_no_row', order.orderId),
    ).toHaveLength(1);
  });
});

describe('ORD-10 erro de configuração do ERP conta no alerta', () => {
  it.each([400, 401])(
    'ORD-10 um %i na criação soma 1 no _count da duração do ERP com operation=create_order e outcome=config_error, e em retry, sem falhar o pedido',
    async (status) => {
      const rig = await createRig();
      const order = await rig.submit();
      rig.world.sim.script.enqueue(
        { mode: 'status', status },
        { op: 'createOrder', reference: order.orderId },
      );

      await rig.run();

      const families = await rig.scrape();
      expect(erpRequests(families, 'create_order', 'config_error')).toBe(1);
      expect(attemptOutcome(families, 'retry')).toBe(1);
      expect(attemptOutcome(families, 'failed') ?? 0).toBe(0);
    },
  );

  it('ORD-10 um 401 na consulta soma 1 no _count da duração do ERP com operation=find_order e outcome=config_error', async () => {
    const rig = await createRig();
    const order = await rig.submit();
    rig.world.sim.script.enqueue(
      { mode: 'status', status: 401 },
      { op: 'findOrder', reference: order.orderId },
    );
    await markSentBefore(suite.pool, order.orderId);

    await rig.run();

    const families = await rig.scrape();
    expect(erpRequests(families, 'find_order', 'config_error')).toBe(1);
    expect(erpRequests(families, 'create_order', 'config_error') ?? 0).toBe(0);
  });

  it('ORD-10 um erro transitório comum não soma o desfecho config_error', async () => {
    const families = await scrapeAfterTransientCreateError();

    expect(attemptOutcome(families, 'retry')).toBe(1);
    expect(erpRequests(families, 'create_order', 'transient')).toBe(1);
    expect(erpRequests(families, 'create_order', 'config_error') ?? 0).toBe(0);
  });
});
