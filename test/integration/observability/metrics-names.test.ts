import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerOutboxAgeGauge } from '../../../src/billing/outbox-age.ts';
import { createRelay } from '../../../src/billing/relay.ts';
import { createStuckOrderMonitor } from '../../../src/billing/stuck-orders.ts';
import { DEFAULT_CATALOG_SYNC_CONFIG } from '../../../src/catalog/config.ts';
import { registerSyncAgeGauge } from '../../../src/catalog/sync-age.ts';
import { createCatalogSync } from '../../../src/catalog/sync.ts';
import { registerInventoryGauges } from '../../../src/checkout/inventory-gauges.ts';
import { METRICS } from '../../../scripts/telemetry-catalog.ts';
import { fromPino } from '../../../src/shared/logging.ts';
import { createSemaphore } from '../../../src/shared/semaphore.ts';
import { createTelemetry } from '../../../src/shared/telemetry.ts';
import { markSynced, seedCatalog } from '../../helpers/catalog.ts';
import { createManualClock } from '../../helpers/clock.ts';
import { buildReconciler, driveClock } from '../../helpers/dlq.ts';
import { seedErpProduct } from '../../helpers/erp.ts';
import { buildLateCheck } from '../../helpers/late-check.ts';
import {
  parseExposition,
  parseUnits,
  scrapeMetricsText,
  type Exposition,
  type MetricName,
  type MetricType,
} from '../../helpers/metrics.ts';
import {
  acceptOrder,
  buildWorker,
  createWorld,
  startWorkerSuite,
  stealMessage,
  stopAdvancing,
  submitOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// OBS-07 (AD-029; R13 do STATE.md): os nomes que o /metrics exporta, já traduzidos pelo exportador do Prometheus.
// Os nomes, os tipos, as unidades e os atributos esperados estão escritos por extenso, e não calculados pela mesma
// regra do código: se o exportador mudar a tradução (por exemplo, passar a acrescentar `_seconds` ao nome), o
// teste reprova e a troca vira uma decisão.

interface ExportedMetric {
  // O nome da série no /metrics; no histograma, o nome base, sem `_bucket`, `_sum` nem `_count`.
  exported: string;
  type: MetricType;
  // Aparece só na linha `# UNIT`, nunca no nome.
  unit: string;
  // Os atributos que toda série leva, como o exportador os escreve (ponto vira `_`).
  labels: readonly string[];
  // Os que só algumas séries levam.
  optionalLabels: readonly string[];
  // O processo cujo /metrics expõe a métrica: a API ou o worker.
  process: 'api' | 'worker';
}

const EXPECTED = {
  'http.server.request.duration': {
    exported: 'http_server_request_duration',
    type: 'histogram',
    unit: 's',
    labels: [
      'http_request_method',
      'http_route',
      'http_response_status_code',
      'url_scheme',
    ],
    optionalLabels: ['error_type'],
    process: 'api',
  },
  'casecellshop.catalog.cache.lookups': {
    exported: 'casecellshop_catalog_cache_lookups_total',
    type: 'counter',
    unit: '{lookup}',
    labels: ['casecellshop_catalog_cache_result'],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.catalog.origin.loads': {
    exported: 'casecellshop_catalog_origin_loads_total',
    type: 'counter',
    unit: '{load}',
    labels: ['casecellshop_catalog_origin_outcome'],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.catalog.origin.active_loads': {
    exported: 'casecellshop_catalog_origin_active_loads',
    type: 'gauge',
    unit: '{load}',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.catalog.served_entry.age': {
    exported: 'casecellshop_catalog_served_entry_age',
    type: 'histogram',
    unit: 's',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  // A idade da sincronização é da API (CAT-15, AD-008): lida do banco a cada coleta, para seguir crescendo com o
  // worker parado. As duas outras da sincronização são do worker: o `exercise` roda uma rodada com uma correção e
  // um SKU ausente.
  'casecellshop.catalog.sync.age': {
    exported: 'casecellshop_catalog_sync_age',
    type: 'gauge',
    unit: 's',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.catalog.gauge.read_failures': {
    exported: 'casecellshop_catalog_gauge_read_failures_total',
    type: 'counter',
    unit: '{read}',
    labels: ['casecellshop_gauge_name'],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.catalog.sync.corrections': {
    exported: 'casecellshop_catalog_sync_corrections_total',
    type: 'counter',
    unit: '{correction}',
    labels: ['casecellshop_catalog_sync_field'],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.catalog.sync.missing_skus': {
    exported: 'casecellshop_catalog_sync_missing_skus_total',
    type: 'counter',
    unit: '{sku}',
    labels: [],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.checkout.requests': {
    exported: 'casecellshop_checkout_requests_total',
    type: 'counter',
    unit: '{request}',
    labels: ['casecellshop_checkout_outcome'],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.outbox.attempts': {
    exported: 'casecellshop_outbox_attempts_total',
    type: 'counter',
    unit: '{attempt}',
    labels: ['casecellshop_outbox_attempt_outcome'],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.outbox.orphan_conclusions': {
    exported: 'casecellshop_outbox_orphan_conclusions_total',
    type: 'counter',
    unit: '{conclusion}',
    labels: [],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.outbox.published.messages': {
    exported: 'casecellshop_outbox_published_messages_total',
    type: 'counter',
    unit: '{message}',
    labels: [],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.order.accept_to_invoice.duration': {
    exported: 'casecellshop_order_accept_to_invoice_duration',
    type: 'histogram',
    unit: 's',
    labels: [],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.erp.client.operation.duration': {
    exported: 'casecellshop_erp_client_operation_duration',
    type: 'histogram',
    unit: 's',
    labels: ['casecellshop_erp_operation', 'casecellshop_erp_outcome'],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.erp.client.active_operations': {
    exported: 'casecellshop_erp_client_active_operations',
    type: 'gauge',
    unit: '{operation}',
    labels: [],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.erp.out_of_stock.rejections': {
    exported: 'casecellshop_erp_out_of_stock_rejections_total',
    type: 'counter',
    unit: '{order}',
    labels: [],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.order.stuck': {
    exported: 'casecellshop_order_stuck_total',
    type: 'counter',
    unit: '{order}',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  // A verificação tardia (AD-031) roda no worker: o counter nasce com 0 para as duas causas no `start()`.
  'casecellshop.order.late_invoices': {
    exported: 'casecellshop_order_late_invoices_total',
    type: 'counter',
    unit: '{order}',
    labels: ['casecellshop_order_late_invoice_cause'],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.queue.messages': {
    exported: 'casecellshop_queue_messages',
    type: 'gauge',
    unit: '{message}',
    labels: ['casecellshop_queue_name'],
    optionalLabels: [],
    process: 'worker',
  },
  'casecellshop.outbox.oldest_pending.age': {
    exported: 'casecellshop_outbox_oldest_pending_age',
    type: 'gauge',
    unit: 's',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.inventory.reserved': {
    exported: 'casecellshop_inventory_reserved',
    type: 'gauge',
    unit: '{unit}',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.inventory.oversold_skus': {
    exported: 'casecellshop_inventory_oversold_skus',
    type: 'gauge',
    unit: '{sku}',
    labels: [],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.billing.gauge.read_failures': {
    exported: 'casecellshop_billing_gauge_read_failures_total',
    type: 'counter',
    unit: '{read}',
    labels: ['casecellshop_gauge_name'],
    optionalLabels: [],
    process: 'api',
  },
  'casecellshop.checkout.gauge.read_failures': {
    exported: 'casecellshop_checkout_gauge_read_failures_total',
    type: 'counter',
    unit: '{read}',
    labels: ['casecellshop_gauge_name'],
    optionalLabels: [],
    process: 'api',
  },
} as const satisfies Record<MetricName, ExportedMetric>;

const ENTRIES = Object.entries(EXPECTED) as [MetricName, ExportedMetric][];
// O exportador acrescenta a si mesmo a série `target_info` (os atributos do recurso): não é do catálogo.
const EXPORTER_OWN = ['target_info'];

let suite: WorkerSuite;
let lateCheckStarted = false;
let lateCheckStartError: unknown;
let apiText: string;
let workerText: string;
let api: Exposition;
let worker: Exposition;

const workerTelemetry = createTelemetry({
  spanExporter: new InMemorySpanExporter(),
});

// Exercita o que grava um ponto em cada métrica do catálogo, pelos mesmos caminhos de produção:
// a API (checkout e duração HTTP) e o worker (relay, tentativa, ERP, aceite ao faturamento, rejeição por
// estoque e conclusão sem efeito). O ERP e o worker usam a telemetria própria do worker.
async function exercise(running: WorkerSuite): Promise<QueueWorld> {
  // Vitrine, na API: a primeira leitura carrega o cache (miss, carga ok, idade servida) e a segunda é hit.
  await seedCatalog(running.pool, [{ sku: 'METRICS-NAMES-1' }]);
  await markSynced(running.pool);
  for (let read = 0; read < 2; read += 1) {
    const res = await request(running.checkout.app).get('/products');
    expect(res.status, 'a vitrine respondeu').toBe(200);
  }

  const world = await createWorld(running, { telemetry: workerTelemetry });
  const poll = () => buildWorker(world).pollOnce();

  // Faturado, pelo relay: publicação, tentativa invoiced, aceite ao faturamento e chamada ao ERP.
  await acceptOrder(running);
  const relay = createRelay({
    pool: running.pool,
    queue: world.queues.queue,
    logger: fromPino(pino({ level: 'silent' })),
    telemetry: workerTelemetry,
    clock: createManualClock(),
  });
  expect(await relay.publishOnce(), 'o relay publicou o pedido').toBe(1);
  expect(await poll()).toBe(1);

  // Falta de estoque no ERP: a rejeição que o alerta de furo de estoque conta.
  await submitOrder(running, world, { erpOnHand: 0 });
  expect(await poll()).toBe(1);

  // Conclusão sem linha afetada: outro consumidor recebe a mensagem durante a chamada.
  const stolen = await submitOrder(running, world);
  world.transport.afterErp(
    { op: 'createOrder', reference: stolen.orderId },
    () => stealMessage(world, stolen.orderId),
  );
  expect(await poll()).toBe(1);

  // Sincronização, no processo do worker: uma correção de preço (o ERP cobra mais que a loja guardou) e um SKU da
  // loja ausente do ERP, para as três métricas casecellshop.catalog.sync.* terem ponto.
  await seedCatalog(running.pool, [{ sku: 'METRICS-NAMES-GONE', onHand: 3 }]);
  await seedErpProduct(running.database.erpPool, {
    sku: 'METRICS-NAMES-1',
    name: 'Capinha METRICS-NAMES-1',
    priceCents: 5990,
    onHand: 10,
  });
  const sync = createCatalogSync({
    pool: running.pool,
    erp: world.erp,
    semaphore: createSemaphore(30),
    clock: world.clock,
    logger: fromPino(pino({ level: 'silent' })),
    telemetry: workerTelemetry,
    config: DEFAULT_CATALOG_SYNC_CONFIG,
  });
  const round = await sync.runRound();
  expect(round.complete, 'a sincronização leu o catálogo todo').toBe(true);
  expect(
    round.missingCount,
    'a sincronização zerou o SKU ausente',
  ).toBeGreaterThanOrEqual(1);
  return world;
}

// Os gauges da fila só existem com o laço do worker e o da reconciliação iniciados (design.md, "Quando as métricas
// de fila e de estoque (M5) sobem"): o /metrics do worker é lido com os dois de pé.
async function startQueueLoops(
  world: QueueWorld,
): Promise<{ stop(): Promise<void> }> {
  const worker = buildWorker(world, { config: { receiveWaitSeconds: 1 } });
  const { reconciler } = buildReconciler(world, { telemetry: workerTelemetry });
  const lateCheck = buildLateCheck(world, { telemetry: workerTelemetry });
  await worker.start();
  await reconciler.start();
  // O counter da verificação tardia nasce no `start()`. O erro fica guardado e é afirmado num teste próprio, para
  // a falta do comportamento reprovar a tabela dos nomes por asserção e não derrubar o arranjo de todos os testes.
  try {
    await lateCheck.start();
    lateCheckStarted = true;
  } catch (error) {
    lateCheckStartError = error;
  }
  return {
    async stop() {
      await stopAdvancing(worker, world);
      await driveClock(reconciler.stop(), world);
      if (lateCheckStarted) await driveClock(lateCheck.stop(), world);
    },
  };
}

// O que a API grava por conta própria: a verificação dos pedidos sem desfecho em 60 s (o counter só nasce quando
// marca um pedido) e os gauges lidos do banco, no scrape. Devolve a função que remove os callbacks.
async function exerciseApi(running: WorkerSuite): Promise<() => void> {
  const { pool, checkout } = running;
  const delayed = await acceptOrder(running);
  await pool.query(
    "update orders set accepted_at = now() - interval '5 minutes' where id = $1",
    [delayed.orderId],
  );
  const monitor = createStuckOrderMonitor({
    pool,
    logger: fromPino(pino({ level: 'silent' })),
    telemetry: checkout.telemetry,
    clock: createManualClock(),
  });
  expect(await monitor.checkOnce(), 'o pedido atrasado foi marcado').toBe(1);
  const logger = fromPino(pino({ level: 'silent' }));
  // A idade da sincronização só tem ponto com uma rodada completa gravada: a do `exercise`, no processo do worker.
  const completed = await pool.query<{ done: boolean }>(
    'select last_completed_at is not null as done from sync_state',
  );
  expect(completed.rows[0]?.done, 'há uma rodada completa gravada').toBe(true);
  const gauges = {
    'idade da outbox': () =>
      registerOutboxAgeGauge({ pool, telemetry: checkout.telemetry, logger }),
    estoque: () =>
      registerInventoryGauges({ pool, telemetry: checkout.telemetry, logger }),
    'idade da sincronização': () =>
      registerSyncAgeGauge({ pool, telemetry: checkout.telemetry, logger }),
  };

  // Uma leitura que falha depois de uma boa, uma por gauge, para o counter de falhas de cada pasta ter o ponto. A
  // falha é uma conexão do pool que rejeita uma vez; cada gauge falha sozinho, para a falha cair nele.
  const connect = vi.spyOn(pool, 'connect');
  for (const [label, register] of Object.entries(gauges)) {
    const remove = register();
    expect((await request(checkout.app).get('/metrics')).status).toBe(200);
    connect.mockRejectedValueOnce(
      new Error(`falha injetada no gauge: ${label}`),
    );
    expect((await request(checkout.app).get('/metrics')).status).toBe(200);
    remove();
  }
  expect(
    connect.mock.settledResults.filter((result) => result.type === 'rejected'),
    'as três falhas injetadas dispararam',
  ).toHaveLength(3);
  connect.mockRestore();

  const removers = Object.values(gauges).map((register) => register());
  return () => {
    for (const remove of removers) remove();
  };
}

beforeAll(async () => {
  suite = await startWorkerSuite();
  const world = await exercise(suite);
  const loops = await startQueueLoops(world);
  const removeApiGauges = await exerciseApi(suite);
  apiText = (await request(suite.checkout.app).get('/metrics')).text;
  workerText = await scrapeMetricsText(workerTelemetry);
  api = parseExposition(apiText);
  worker = parseExposition(workerText);
  removeApiGauges();
  await loops.stop();
}, 240_000);

afterAll(async () => {
  await workerTelemetry.shutdown();
  await suite?.stop();
});

function expositionOf(process: 'api' | 'worker'): Exposition {
  return process === 'api' ? api : worker;
}

describe('OBS-07 nomes que o /metrics exporta, traduzidos pelo exportador do Prometheus', () => {
  it('OBS-07 a tabela dos nomes exportados cobre exatamente as métricas do catálogo, com a mesma unidade e os mesmos atributos', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(METRICS).sort());
    for (const [name, expected] of ENTRIES) {
      const spec = METRICS[name];
      expect(expected.unit, `unidade de ${name}`).toBe(spec.unit);
      const attributes = Object.keys(spec.attributes)
        .map((attribute) => attribute.replaceAll('.', '_'))
        .sort();
      expect(
        [...expected.labels, ...expected.optionalLabels].sort(),
        `atributos de ${name}`,
      ).toEqual(attributes);
    }
  });

  it.each(ENTRIES)(
    'OBS-07 %s sai como o nome escrito por extenso, com o tipo e a unidade só na linha # UNIT',
    (_name, expected) => {
      const text = expected.process === 'api' ? apiText : workerText;
      const family = expositionOf(expected.process).get(expected.exported);
      expect(family?.type, `# TYPE de ${expected.exported}`).toBe(
        expected.type,
      );
      expect(parseUnits(text).get(expected.exported)).toBe(expected.unit);
      expect(family?.samples.length ?? 0).toBeGreaterThan(0);
    },
  );

  it.each(ENTRIES.filter(([, expected]) => expected.type === 'histogram'))(
    'OBS-07 %s sai com as séries _bucket, _sum e _count',
    (_name, expected) => {
      const family = expositionOf(expected.process).get(expected.exported);
      const suffixes = new Set(
        (family?.samples ?? []).map((sample) =>
          sample.name.slice(expected.exported.length),
        ),
      );
      expect([...suffixes].sort()).toEqual(['_bucket', '_count', '_sum']);
    },
  );

  it.each(ENTRIES.filter(([, expected]) => expected.type !== 'histogram'))(
    'OBS-07 %s sai como uma série só com o nome da família, sem sufixo de histograma',
    (_name, expected) => {
      const family = expositionOf(expected.process).get(expected.exported);
      for (const sample of family?.samples ?? [])
        expect(sample.name).toBe(expected.exported);
    },
  );

  it.each(ENTRIES)(
    'OBS-07 %s sai só com os atributos do catálogo, escritos com sublinhado',
    (_name, expected) => {
      const family = expositionOf(expected.process).get(expected.exported);
      const allowed = new Set([...expected.labels, ...expected.optionalLabels]);
      for (const sample of family?.samples ?? []) {
        const labels = Object.keys(sample.labels).filter(
          (label) => label !== 'le',
        );
        for (const required of expected.labels)
          expect(labels, `${sample.name} leva ${required}`).toContain(required);
        for (const label of labels)
          expect(allowed.has(label), `${sample.name} com ${label}`).toBe(true);
      }
    },
  );

  it('OBS-07 nenhuma métrica fora do catálogo aparece no /metrics da API nem no do worker (fora a target_info do exportador)', () => {
    const exported = new Set<string>(
      ENTRIES.map(([, expected]) => expected.exported),
    );
    for (const [process, families] of [
      ['api', api],
      ['worker', worker],
    ] as const) {
      const outside = [...families.keys()].filter(
        (name) => !exported.has(name) && !EXPORTER_OWN.includes(name),
      );
      expect(outside, `fora do catálogo no /metrics de ${process}`).toEqual([]);
    }
  });

  it('OBS-07 só o contador termina em _total, uma vez só, e nenhum nome exportado traz a unidade', () => {
    for (const [, expected] of ENTRIES) {
      expect(expected.exported.endsWith('_total')).toBe(
        expected.type === 'counter',
      );
      expect(expected.exported).not.toMatch(/_total_total$/);
      expect(expected.exported).not.toMatch(/_(seconds|ms|bytes)(_total)?$/);
    }
    for (const families of [api, worker]) {
      for (const name of families.keys()) {
        expect(name).not.toMatch(/_(seconds|ms|bytes)(_total)?$/);
      }
    }
  });

  it('OBS-07 as linhas # UNIT do /metrics são exatamente as unidades do catálogo, e nenhuma outra', () => {
    const expectedUnits = new Map(
      ENTRIES.map(([, expected]) => [expected.exported, expected.unit]),
    );
    for (const text of [apiText, workerText]) {
      for (const [name, unit] of parseUnits(text)) {
        if (EXPORTER_OWN.includes(name)) continue;
        expect(expectedUnits.get(name), `unidade de ${name}`).toBe(unit);
      }
    }
  });

  it('OBS-02 o start() da verificação tardia sobe sem erro e deixa o counter casecellshop_order_late_invoices_total com 0 para as duas causas, sem orderId', () => {
    expect(lateCheckStartError, 'erro do start() da verificação tardia').toBe(
      undefined,
    );
    const samples = worker.get(
      'casecellshop_order_late_invoices_total',
    )?.samples;
    const byCause: Record<string, number> = {};
    for (const sample of samples ?? [])
      byCause[sample.labels['casecellshop_order_late_invoice_cause'] ?? ''] =
        sample.value;
    expect(byCause).toEqual({ failed_order: 0, duplicate: 0 });
    expect(
      (samples ?? []).flatMap((sample) => Object.keys(sample.labels)),
    ).not.toContain('orderId');
  });

  it('OBS-02 o /metrics da API e o do worker juntos expõem toda métrica do catálogo, cada uma no processo que a produz', () => {
    for (const [name, expected] of ENTRIES) {
      const present = expositionOf(expected.process).has(expected.exported);
      expect(present, `${name} no /metrics de ${expected.process}`).toBe(true);
    }
  });
});
