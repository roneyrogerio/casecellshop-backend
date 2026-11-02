import http from 'node:http';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app.ts';
import type { CatalogConfig } from '../../src/catalog/config.ts';
import { productsRoute } from '../../src/contract/index.ts';
import { createTelemetry, type Telemetry } from '../../src/shared/telemetry.ts';
import { createAppPool } from './checkout.ts';
import type { ManualClock } from './clock.ts';
import { createManualClock } from './clock.ts';
import { expectMatchesContract } from './contract.ts';
import { startMigratedDatabase, type TestDatabase } from './database.ts';
import { captureLogs, type CapturedLogs } from './logs.ts';
import {
  scrapeMetrics,
  type Attributes,
  type Exposition,
  type MetricName,
  metricValue,
} from './metrics.ts';
import { overriding } from './telemetry-intercept.ts';

// ---------------------------------------------------------------- dados

export interface CatalogSeed {
  sku: string;
  name?: string;
  priceCents?: number;
  onHand?: number;
  reserved?: number;
}

// O catálogo é uma tabela só e cada arquivo tem o próprio banco: cada teste zera as linhas e a marca da
// sincronização antes de semear, para uma vitrine de outro teste não aparecer na página.
// Os pedidos que um teste de checkout deixou referenciam `products` (order_items.sku) e `orders`: saem primeiro,
// na ordem das chaves estrangeiras, sem desligar nenhuma delas.
export async function resetCatalog(pool: pg.Pool): Promise<void> {
  await pool.query('delete from order_items');
  await pool.query('delete from outbox');
  await pool.query('delete from idempotency_keys');
  await pool.query('delete from orders');
  await pool.query('delete from inventory');
  await pool.query('delete from products');
  await setSyncCompletedAt(pool, null);
}

// Produtos e estoque direto nas tabelas, numa instrução cada; `reserved` pode passar de `on_hand` (OBS-06).
export async function seedCatalog(
  pool: pg.Pool,
  rows: readonly CatalogSeed[],
): Promise<void> {
  await pool.query(
    'insert into products (sku, name, price_cents) select * from unnest($1::text[], $2::text[], $3::int[])',
    [
      rows.map((row) => row.sku),
      rows.map((row) => row.name ?? `Capinha ${row.sku}`),
      rows.map((row) => row.priceCents ?? 4990),
    ],
  );
  await pool.query(
    'insert into inventory (sku, on_hand, reserved) select * from unnest($1::text[], $2::int[], $3::int[])',
    [
      rows.map((row) => row.sku),
      rows.map((row) => row.onHand ?? 10),
      rows.map((row) => row.reserved ?? 0),
    ],
  );
}

// A linha única do sync_state: `null` é o catálogo ainda não sincronizado (CAT-05). O UPDATE vale se a migração
// já criou a linha; senão, o INSERT a cria.
export async function setSyncCompletedAt(
  pool: pg.Pool,
  at: Date | null,
): Promise<void> {
  const updated = await pool.query(
    'update sync_state set last_completed_at = $1',
    [at],
  );
  if (updated.rowCount === 0) {
    await pool.query('insert into sync_state (last_completed_at) values ($1)', [
      at,
    ]);
  }
}

// Marca o catálogo como sincronizado, como a rodada completa do worker faz.
export function markSynced(pool: pg.Pool): Promise<void> {
  return setSyncCompletedAt(pool, new Date());
}

// SKUs em ordem lexicográfica de `prefix-001` a `prefix-<count>`.
export function skuRange(prefix: string, count: number, from = 1): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(from + index).padStart(3, '0')}`,
  );
}

// ---------------------------------------------------------------- fronteira do pool

export interface PoolBoundary {
  // O pool que o app recebe: o real, embrulhado.
  pool: pg.Pool;
  // Daqui em diante toda consulta e toda conexão é recusada, como um banco fora do ar.
  fail(): void;
  restore(): void;
  // As consultas e conexões pedidas depois daqui esperam o `release`: uma janela forçada para as leituras
  // concorrentes se juntarem.
  hold(): void;
  release(): void;
  // Quantas vezes o app pediu uma consulta ou uma conexão ao pool, recusadas ou não.
  readonly calls: number;
  // Quantas o `fail` recusou: o teste confere que a injeção disparou.
  readonly injected: number;
}

export function injectBoundary(real: pg.Pool): PoolBoundary {
  let failing = false;
  let calls = 0;
  let injected = 0;
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  function guarded(run: (...args: unknown[]) => Promise<unknown>) {
    return async (...args: unknown[]): Promise<unknown> => {
      calls += 1;
      if (failing) {
        injected += 1;
        throw new Error('conexão recusada (falha injetada pelo teste)');
      }
      if (gate) await gate;
      return run(...args);
    };
  }

  const pool = overriding(real, {
    query: (target) =>
      guarded((...args) =>
        (target.query as (...a: unknown[]) => Promise<unknown>)(...args),
      ),
    connect: (target) => guarded(() => target.connect()),
  });
  return {
    pool,
    fail: () => {
      failing = true;
    },
    restore: () => {
      failing = false;
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    release: () => {
      openGate?.();
      gate = undefined;
      openGate = undefined;
    },
    get calls() {
      return calls;
    },
    get injected() {
      return injected;
    },
  };
}

// ---------------------------------------------------------------- a vitrine de um teste

export interface CatalogHarnessOptions {
  catalog?: Partial<CatalogConfig>;
  // Padrão 0,5: o TTL sai exato (o jitter é ±10% em torno dele).
  random?: () => number;
}

export interface CatalogHarness {
  app: Express;
  server: http.Server;
  clock: ManualClock;
  boundary: PoolBoundary;
  telemetry: Telemetry;
  exporter: InMemorySpanExporter;
  logs: CapturedLogs;
  // Requisições que o servidor já recebeu, para o teste saber que as N leituras estão em voo.
  readonly received: number;
  // GET /products com a query pronta (`?page=2`); confere o status, o tipo, o corpo e os cabeçalhos pelo contrato.
  get(query?: string): Promise<request.Response>;
  scrape(): Promise<Exposition>;
  // Os spans já terminados, depois do flush do processador em lote.
  spans(): Promise<ReadableSpan[]>;
  close(): Promise<void>;
}

// Um app com a própria vitrine (e, portanto, o próprio cache vazio), o relógio manual, o pool embrulhado e a
// telemetria em memória. O banco é o do arquivo (Testcontainers).
export async function startCatalogHarness(
  database: TestDatabase,
  options: CatalogHarnessOptions = {},
): Promise<CatalogHarness> {
  const clock = createManualClock();
  const realPool = createAppPool(database.uri);
  const boundary = injectBoundary(realPool);
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry({ spanExporter: exporter });
  const logs = captureLogs('casecellshop-api');
  const app = createApp({
    pool: boundary.pool,
    logger: logs.logger,
    telemetry,
    clock,
    random: options.random ?? (() => 0.5),
    ...(options.catalog ? { catalog: options.catalog } : {}),
  });
  const server = http.createServer(app);
  let received = 0;
  server.on('request', () => {
    received += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    app,
    server,
    clock,
    boundary,
    telemetry,
    exporter,
    logs,
    get received() {
      return received;
    },
    async get(query = '') {
      const res = await request(server).get(`/products${query}`);
      expectMatchesContract(productsRoute, res);
      return res;
    },
    scrape: () => scrapeMetrics(telemetry),
    async spans() {
      await telemetry.forceFlush();
      return exporter.getFinishedSpans();
    },
    async close() {
      boundary.release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await telemetry.shutdown();
      await realPool.end();
    },
  };
}

export interface CatalogDatabase {
  // O pool do banco do arquivo, para semear e ler direto.
  readonly pool: pg.Pool;
  // A vitrine do teste, fechada no fim dele; semeie o catálogo antes ou depois, a carga é preguiçosa.
  start(options?: CatalogHarnessOptions): Promise<CatalogHarness>;
}

// O ciclo de vida de um arquivo de teste da vitrine: um banco por arquivo, o catálogo zerado antes de cada teste
// e a vitrine do teste fechada depois dele.
export function useCatalogDatabase(): CatalogDatabase {
  let database: TestDatabase | undefined;
  let harness: CatalogHarness | undefined;
  const current = (): TestDatabase => {
    if (!database) throw new Error('o banco do arquivo ainda não subiu');
    return database;
  };
  beforeAll(async () => {
    database = await startMigratedDatabase();
  }, 120_000);
  afterAll(async () => {
    await database?.stop();
  });
  beforeEach(async () => {
    await resetCatalog(current().pool);
  });
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });
  return {
    get pool() {
      return current().pool;
    },
    async start(options) {
      harness = await startCatalogHarness(current(), options);
      return harness;
    },
  };
}

// O valor de um contador do catálogo no /metrics; zero enquanto a série não existe.
export function counterValue<N extends MetricName>(
  families: Exposition,
  name: N,
  attributes: Attributes<N> = {},
): number {
  return metricValue(families, name, attributes) ?? 0;
}
