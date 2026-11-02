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

function registerInventory(): void {
  removers.push(
    registerInventoryGauges({
      pool: harness.pool,
      telemetry: harness.telemetry,
    }),
  );
}

function registerOutboxAge(): void {
  removers.push(
    registerOutboxAgeGauge({
      pool: harness.pool,
      telemetry: harness.telemetry,
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

  it('OBS-06 a função devolvida remove os callbacks: as séries saem do /metrics', async () => {
    const remove = registerInventoryGauges({
      pool: harness.pool,
      telemetry: harness.telemetry,
    });
    await seedProduct(database.pool, {
      priceCents: 1000,
      onHand: 10,
      reserved: 2,
    });
    expect(await reserved()).toBe(2);

    remove();

    const families = await scrapeApi();
    expect(
      metricValue(families, 'casecellshop.inventory.reserved'),
    ).toBeUndefined();
    expect(
      metricValue(families, 'casecellshop.inventory.oversold_skus'),
    ).toBeUndefined();
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

  it('OBS-02 o gauge é lido a cada scrape e a função devolvida remove o callback', async () => {
    const remove = registerOutboxAgeGauge({
      pool: harness.pool,
      telemetry: harness.telemetry,
    });
    expect(await oldestAge()).toBe(0);
    const orderId = await pendingOrderWithOutbox(200);
    expect(await oldestAge()).toBeGreaterThanOrEqual(200);
    await database.pool.query(
      "update orders set status = 'invoiced', outcome_at = now() where id = $1",
      [orderId],
    );
    expect(await oldestAge()).toBe(0);

    remove();

    expect(await oldestAge()).toBeUndefined();
  });
});
