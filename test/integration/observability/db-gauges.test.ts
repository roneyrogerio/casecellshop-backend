import type pg from 'pg';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { AppLogger } from '../../../src/shared/logging.ts';
import { captureLogs, type LogLine } from '../../helpers/logs.ts';
import { registerOutboxAgeGauge } from '../../../src/billing/outbox-age.ts';
import { registerInventoryGauges } from '../../../src/checkout/inventory-gauges.ts';
import {
  seedProduct,
  startCheckoutHarness,
  type CheckoutHarness,
} from '../../helpers/checkout.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import {
  metricValue,
  parseExposition,
  type Exposition,
} from '../../helpers/metrics.ts';
import {
  resetStore,
  seedOrder,
  seedOutboxRow,
} from '../../helpers/store-seed.ts';
import { interceptPool } from '../../helpers/worker.ts';

// Gauges lidos do banco e expostos pela API, não pelo processo monitorado (AD-008; design.md, "Observabilidade"):
// o furo de estoque (OBS-06) e a idade da linha mais antiga da outbox. Cada leitura acontece no scrape do /metrics
// da API, e cada teste cria os dados que usa.

let database: TestDatabase;
let harness: CheckoutHarness;
let removers: (() => void)[] = [];

beforeAll(async () => {
  database = await startMigratedDatabase();
  harness = await startCheckoutHarness(database);
}, 180_000);

afterAll(async () => {
  await harness?.close();
  await database?.stop();
});

beforeEach(async () => {
  await resetStore(database.pool);
});

afterEach(() => {
  for (const remove of removers) remove();
  removers = [];
});

// Os testes que não leem o log da API não querem ruído dele.
const SILENT: AppLogger = captureLogs('casecellshop-api', 'silent').logger;

function registerInventory(logger: AppLogger = SILENT): void {
  removers.push(
    registerInventoryGauges({
      pool: harness.pool,
      telemetry: harness.telemetry,
      logger,
    }),
  );
}

function registerOutboxAge(logger: AppLogger = SILENT): void {
  removers.push(
    registerOutboxAgeGauge({
      pool: harness.pool,
      telemetry: harness.telemetry,
      logger,
    }),
  );
}

// O /metrics da API, como o Prometheus o recebe.
async function scrapeApi(): Promise<Exposition> {
  const res = await request(harness.app).get('/metrics');
  expect(res.status).toBe(200);
  return parseExposition(res.text);
}

async function oversold(): Promise<number | undefined> {
  return metricValue(await scrapeApi(), 'casecellshop.inventory.oversold_skus');
}

async function reserved(): Promise<number | undefined> {
  return metricValue(await scrapeApi(), 'casecellshop.inventory.reserved');
}

async function oldestAge(): Promise<number | undefined> {
  return metricValue(
    await scrapeApi(),
    'casecellshop.outbox.oldest_pending.age',
  );
}

// Uma sincronização que baixa o `on_hand` (o ERP tem menos do que a loja prometeu).
async function syncOnHand(sku: string, onHand: number): Promise<void> {
  await database.pool.query(
    'update inventory set on_hand = $2 where sku = $1',
    [sku, onHand],
  );
}

describe('OBS-06 gauges de estoque lidos do banco no /metrics da API', () => {
  it('OBS-06 um SKU com o on_hand baixado para menos que o reserved entra no gauge de SKUs com reserved > on_hand', async () => {
    registerInventory();
    const product = await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 4,
    });
    expect(await oversold(), 'sem furo antes da sincronização').toBe(0);

    await syncOnHand(product.sku, 3);

    expect(await oversold()).toBe(1);
  });

  it('OBS-06 só os SKUs com reserved estritamente maior que o on_hand contam: igual não é furo', async () => {
    registerInventory();
    const hole = await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 9,
      reserved: 5,
    });
    const hole2 = await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 9,
      reserved: 2,
    });
    const equal = await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 6,
      reserved: 6,
    });
    await seedProduct(database.pool, { priceCents: 1000, onHand: 8 });
    await syncOnHand(hole.sku, 4);
    await syncOnHand(hole2.sku, 0);
    await syncOnHand(equal.sku, 6);

    expect(await oversold()).toBe(2);
  });

  it('OBS-06 sem furo o gauge de SKUs vale 0, e a série existe', async () => {
    registerInventory();
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 3,
    });
    await seedProduct(database.pool, { priceCents: 1000, onHand: 5 });

    const families = await scrapeApi();

    expect(families.get('casecellshop_inventory_oversold_skus')?.type).toBe(
      'gauge',
    );
    expect(metricValue(families, 'casecellshop.inventory.oversold_skus')).toBe(
      0,
    );
  });

  it('OBS-06 o gauge de unidades reservadas mostra a soma do reserved de todos os SKUs', async () => {
    registerInventory();
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 4,
    });
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 7,
    });
    await seedProduct(database.pool, { priceCents: 1000, onHand: 10 });

    const families = await scrapeApi();

    expect(families.get('casecellshop_inventory_reserved')?.type).toBe('gauge');
    expect(metricValue(families, 'casecellshop.inventory.reserved')).toBe(11);
  });

  it('OBS-06 sem nenhum estoque os dois gauges valem 0, e as séries existem', async () => {
    registerInventory();

    const families = await scrapeApi();

    expect(metricValue(families, 'casecellshop.inventory.reserved')).toBe(0);
    expect(metricValue(families, 'casecellshop.inventory.oversold_skus')).toBe(
      0,
    );
  });

  it('OBS-06 os gauges são lidos a cada scrape: acompanham o furo que aparece e o que se fecha', async () => {
    registerInventory();
    const product = await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 6,
    });
    expect(await oversold()).toBe(0);
    expect(await reserved()).toBe(6);

    await syncOnHand(product.sku, 2);
    expect(await oversold()).toBe(1);

    await syncOnHand(product.sku, 8);
    expect(await oversold()).toBe(0);
    await database.pool.query(
      'update inventory set reserved = 1 where sku = $1',
      [product.sku],
    );
    expect(await reserved()).toBe(1);
  });

  it('OBS-06 os dois gauges saem de uma consulta só ao banco por scrape', async () => {
    const probe = interceptPool(harness.pool, { match: /inventory/i });
    removers.push(
      registerInventoryGauges({
        pool: probe.pool,
        telemetry: harness.telemetry,
        logger: SILENT,
      }),
    );
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 2,
    });

    const families = await scrapeApi();

    expect(metricValue(families, 'casecellshop.inventory.reserved')).toBe(2);
    expect(metricValue(families, 'casecellshop.inventory.oversold_skus')).toBe(
      0,
    );
    expect(probe.matched).toBe(1);
  });

  // O requisito é a fonte deixar de ser consultada. O que o /metrics mostra depois não serve de prova: o
  // PrometheusExporter é cumulativo e o SDK segue exportando o último valor de um gauge sem callback.
  it('OBS-06 a função devolvida remove os callbacks: o banco deixa de ser consultado nos scrapes seguintes', async () => {
    const probe = interceptPool(harness.pool, { match: /inventory/i });
    const remove = registerInventoryGauges({
      pool: probe.pool,
      telemetry: harness.telemetry,
      logger: SILENT,
    });
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 2,
    });
    expect(await reserved()).toBe(2);
    expect(probe.matched, 'uma consulta no primeiro scrape').toBe(1);
    await scrapeApi();
    expect(probe.matched, 'uma consulta por scrape antes da remoção').toBe(2);

    remove();
    await scrapeApi();
    await scrapeApi();

    expect(probe.matched, 'nenhuma consulta depois de remove()').toBe(2);
  });
});

describe('OBS-02 gauge da idade da linha mais antiga da outbox no /metrics da API', () => {
  async function pendingOrderWithOutbox(
    createdAgoSeconds: number,
    options: { dead?: boolean; published?: boolean } = {},
  ): Promise<string> {
    const orderId = await seedOrder(database.pool, { acceptedAgoSeconds: 1 });
    await seedOutboxRow(database.pool, orderId, {
      createdAgoSeconds,
      ...options,
    });
    return orderId;
  }

  it('OBS-02 o gauge mostra a idade da linha mais antiga de um pedido pendente, no relógio do banco', async () => {
    registerOutboxAge();
    await pendingOrderWithOutbox(120);

    const age = await oldestAge();

    expect(age).toBeGreaterThanOrEqual(120);
    expect(age).toBeLessThan(150);
  });

  it('OBS-02 entre várias linhas vale a mais antiga, publicada ou não', async () => {
    registerOutboxAge();
    await pendingOrderWithOutbox(30);
    await pendingOrderWithOutbox(600, { published: true });
    await pendingOrderWithOutbox(90);

    const age = await oldestAge();

    expect(age).toBeGreaterThanOrEqual(600);
    expect(age).toBeLessThan(630);
  });

  it('OBS-02 a linha morta (dead_at) fica de fora, mesmo mais antiga: o gauge da DLQ já a mostra', async () => {
    registerOutboxAge();
    await pendingOrderWithOutbox(3600, { dead: true });
    await pendingOrderWithOutbox(60);

    const age = await oldestAge();

    expect(age).toBeGreaterThanOrEqual(60);
    expect(age).toBeLessThan(90);
  });

  it.each(['invoiced', 'failed'] as const)(
    'OBS-02 a linha de um pedido %s fica de fora',
    async (status) => {
      registerOutboxAge();
      const orderId = await seedOrder(database.pool, {
        acceptedAgoSeconds: 3600,
        outcomeAfterSeconds: 10,
        status,
      });
      await seedOutboxRow(database.pool, orderId, { createdAgoSeconds: 3600 });
      await pendingOrderWithOutbox(45);

      const age = await oldestAge();

      expect(age).toBeGreaterThanOrEqual(45);
      expect(age).toBeLessThan(75);
    },
  );

  it('OBS-02 sem nenhuma linha elegível o gauge vale 0, e a série existe', async () => {
    registerOutboxAge();
    await pendingOrderWithOutbox(3600, { dead: true });
    const invoiced = await seedOrder(database.pool, {
      acceptedAgoSeconds: 3600,
      outcomeAfterSeconds: 5,
    });
    await seedOutboxRow(database.pool, invoiced, { createdAgoSeconds: 3600 });

    const families = await scrapeApi();

    expect(families.get('casecellshop_outbox_oldest_pending_age')?.type).toBe(
      'gauge',
    );
    expect(
      metricValue(families, 'casecellshop.outbox.oldest_pending.age'),
    ).toBe(0);
  });

  it('OBS-02 sem nenhuma linha na outbox o gauge vale 0', async () => {
    registerOutboxAge();

    expect(await oldestAge()).toBe(0);
  });

  // Como no OBS-06: a prova é o banco deixar de ser consultado, não o que o /metrics mostra depois.
  it('OBS-02 o gauge é lido a cada scrape e a função devolvida remove o callback: o banco deixa de ser consultado', async () => {
    const probe = interceptPool(harness.pool, { match: /outbox/i });
    const remove = registerOutboxAgeGauge({
      pool: probe.pool,
      telemetry: harness.telemetry,
      logger: SILENT,
    });
    expect(await oldestAge()).toBe(0);
    expect(probe.matched, 'uma consulta no primeiro scrape').toBe(1);
    const orderId = await pendingOrderWithOutbox(200);
    expect(await oldestAge()).toBeGreaterThanOrEqual(200);
    await database.pool.query(
      "update orders set status = 'invoiced', outcome_at = now() where id = $1",
      [orderId],
    );
    expect(await oldestAge()).toBe(0);
    expect(probe.matched, 'uma consulta por scrape antes da remoção').toBe(3);

    remove();
    await scrapeApi();
    await scrapeApi();

    expect(probe.matched, 'nenhuma consulta depois de remove()').toBe(3);
  });
});

// Leitura que falha (design.md, "Leitura que falha"): com a temporalidade cumulativa o SDK segue exportando o último
// valor do gauge, então o /metrics não denuncia a falha. O sinal é o counter de falhas e o log de erro. O que o
// /metrics mostra do próprio gauge no scrape que falhou é detalhe do SDK e não é afirmado.
const INJECTED_FAILURE = 'banco indisponível (injetado)';

interface ReadFailureCase {
  gauge: 'outbox_oldest_pending_age' | 'inventory';
  event:
    | 'casecellshop.billing.gauge.read_failed'
    | 'casecellshop.checkout.gauge.read_failed';
  // O texto do comando que a leitura manda ao banco.
  match: RegExp;
  register(pool: pg.Pool, logger: AppLogger): () => void;
  seed(): Promise<void>;
  // O valor do gauge no /metrics e o total do counter de falhas dele.
  value(families: Exposition): number | undefined;
  failures(families: Exposition): number;
}

interface Observation {
  value: number | undefined;
  failures: number;
  events: LogLine[];
}

const OUTBOX_CASE: ReadFailureCase = {
  gauge: 'outbox_oldest_pending_age',
  event: 'casecellshop.billing.gauge.read_failed',
  match: /outbox/i,
  register: (pool, logger) =>
    registerOutboxAgeGauge({ pool, telemetry: harness.telemetry, logger }),
  async seed() {
    const orderId = await seedOrder(database.pool, { acceptedAgoSeconds: 1 });
    await seedOutboxRow(database.pool, orderId, { createdAgoSeconds: 120 });
  },
  value: (families) =>
    metricValue(families, 'casecellshop.outbox.oldest_pending.age'),
  failures: (families) =>
    metricValue(families, 'casecellshop.billing.gauge.read_failures', {
      'casecellshop.gauge.name': 'outbox_oldest_pending_age',
    }) ?? 0,
};

const INVENTORY_CASE: ReadFailureCase = {
  gauge: 'inventory',
  event: 'casecellshop.checkout.gauge.read_failed',
  match: /inventory/i,
  register: (pool, logger) =>
    registerInventoryGauges({ pool, telemetry: harness.telemetry, logger }),
  async seed() {
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 4,
    });
  },
  value: (families) => metricValue(families, 'casecellshop.inventory.reserved'),
  failures: (families) =>
    metricValue(families, 'casecellshop.checkout.gauge.read_failures', {
      'casecellshop.gauge.name': 'inventory',
    }) ?? 0,
};

// Uma leitura boa, uma que falha na fronteira do banco (um único comando) e uma de recuperação, cada uma um scrape do
// /metrics da API. O counter é cumulativo e compartilhado pelo arquivo: o que vale é a diferença para a leitura inicial.
async function readGaugeThroughAFailure(c: ReadFailureCase) {
  const logs = captureLogs('casecellshop-api');
  const probe = interceptPool(harness.pool, {
    match: c.match,
    fail: () => new Error(INJECTED_FAILURE),
    times: 1,
  });
  probe.armed = false;
  removers.push(c.register(probe.pool, logs.logger));
  const takeReading = async (): Promise<Observation> => {
    const families = await scrapeApi();
    return {
      value: c.value(families),
      failures: c.failures(families),
      events: logs.eventsOf(c.event),
    };
  };

  const initial = await takeReading();
  await c.seed();
  const good = await takeReading();
  probe.armed = true;
  const failed = await takeReading();
  probe.armed = false;
  const recovered = await takeReading();
  return { probe, initial, good, failed, recovered };
}

type ReadFailureRun = Awaited<ReturnType<typeof readGaugeThroughAFailure>>;

// A falha deixa o sinal: um evento de erro com o gauge e o erro, e 1 a mais no counter, visto na leitura seguinte (a
// ordem entre o callback e o counter dentro do mesmo scrape é do SDK). A recuperação não loga de novo.
function expectFailureSignal(run: ReadFailureRun, gauge: string): void {
  expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
  expect(run.failed.events).toHaveLength(1);
  const [event] = run.failed.events;
  expect(event?.['level']).toBe('error');
  expect(event?.['gauge']).toBe(gauge);
  expect(JSON.stringify(event?.['err'])).toContain(INJECTED_FAILURE);
  expect(run.recovered.failures - run.initial.failures).toBe(1);
  expect(run.recovered.events, 'a recuperação não loga de novo').toHaveLength(
    1,
  );
}

// A leitura que dá certo não deixa sinal nenhum.
function expectGoodReadsSilent(run: ReadFailureRun): void {
  expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
  expect(run.initial.events).toHaveLength(0);
  expect(run.good.events).toHaveLength(0);
  expect(run.good.failures - run.initial.failures).toBe(0);
}

describe('OBS-02 a leitura da idade da outbox que falha é contada e logada', () => {
  it('OBS-02 a leitura que falha depois de uma boa soma 1 em billing.gauge.read_failures com o gauge outbox_oldest_pending_age e escreve gauge.read_failed com o gauge e o erro', async () => {
    const run = await readGaugeThroughAFailure(OUTBOX_CASE);

    expect(run.good.value).toBeGreaterThanOrEqual(120);
    expectFailureSignal(run, 'outbox_oldest_pending_age');
  });

  it('OBS-02 a leitura que dá certo não soma em billing.gauge.read_failures nem escreve gauge.read_failed', async () => {
    expectGoodReadsSilent(await readGaugeThroughAFailure(OUTBOX_CASE));
  });

  it('OBS-02 depois da falha a leitura seguinte volta a mostrar a idade da outbox', async () => {
    const run = await readGaugeThroughAFailure(OUTBOX_CASE);

    expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
    expect(run.recovered.value).toBeGreaterThanOrEqual(120);
    expect(run.recovered.value).toBeLessThan(150);
  });
});

describe('OBS-06 a leitura dos gauges do estoque que falha é contada e logada', () => {
  it('OBS-06 a leitura que falha depois de uma boa soma 1 em checkout.gauge.read_failures com o gauge inventory, uma só vez para os dois gauges, e escreve gauge.read_failed com o gauge e o erro', async () => {
    const run = await readGaugeThroughAFailure(INVENTORY_CASE);

    expect(run.good.value).toBe(4);
    expectFailureSignal(run, 'inventory');
  });

  it('OBS-06 a leitura que dá certo não soma em checkout.gauge.read_failures nem escreve gauge.read_failed', async () => {
    expectGoodReadsSilent(await readGaugeThroughAFailure(INVENTORY_CASE));
  });

  it('OBS-06 depois da falha a leitura seguinte volta a mostrar as unidades reservadas', async () => {
    const run = await readGaugeThroughAFailure(INVENTORY_CASE);

    expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
    expect(run.recovered.value).toBe(4);
  });
});
