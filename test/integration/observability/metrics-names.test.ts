import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelay } from '../../../src/billing/relay.ts';
import { METRICS } from '../../../scripts/telemetry-catalog.ts';
import { createTelemetry } from '../../../src/shared/telemetry.ts';
import { createManualClock } from '../../helpers/clock.ts';
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
  submitOrder,
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
} as const satisfies Record<MetricName, ExportedMetric>;

const ENTRIES = Object.entries(EXPECTED) as [MetricName, ExportedMetric][];
// O exportador acrescenta a si mesmo a série `target_info` (os atributos do recurso): não é do catálogo.
const EXPORTER_OWN = ['target_info'];

let suite: WorkerSuite;
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
async function exercise(running: WorkerSuite): Promise<void> {
  const world = await createWorld(running, { telemetry: workerTelemetry });
  const poll = () => buildWorker(world).pollOnce();

  // Faturado, pelo relay: publicação, tentativa invoiced, aceite ao faturamento e chamada ao ERP.
  await acceptOrder(running);
  const relay = createRelay({
    pool: running.pool,
    queue: world.queues.queue,
    logger: pino({ level: 'silent' }),
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
}

beforeAll(async () => {
  suite = await startWorkerSuite();
  await exercise(suite);
  apiText = (await request(suite.checkout.app).get('/metrics')).text;
  workerText = await scrapeMetricsText(workerTelemetry);
  api = parseExposition(apiText);
  worker = parseExposition(workerText);
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

  it('OBS-02 o /metrics da API e o do worker juntos expõem toda métrica do catálogo, cada uma no processo que a produz', () => {
    for (const [name, expected] of ENTRIES) {
      const present = expositionOf(expected.process).has(expected.exported);
      expect(present, `${name} no /metrics de ${expected.process}`).toBe(true);
    }
  });
});
