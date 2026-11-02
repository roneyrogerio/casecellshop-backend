import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import {
  DEFAULT_CATALOG_SYNC_CONFIG,
  type CatalogSyncConfig,
} from '../../src/catalog/config.ts';
import {
  createCatalogSync,
  type CatalogSync,
  type CatalogSyncDependencies,
} from '../../src/catalog/sync.ts';
import type { ErpClient } from '../../src/erp/erp-client.ts';
import { createSemaphore, type Semaphore } from '../../src/shared/semaphore.ts';
import { createTelemetry, type Telemetry } from '../../src/shared/telemetry.ts';
import { track, WAIT_GUARD_MS } from './async.ts';
import {
  resetCatalog,
  seedCatalog,
  skuRange,
  startCatalogHarness,
  type CatalogHarness,
  type CatalogHarnessOptions,
} from './catalog.ts';
import { createAppPool } from './checkout.ts';
import { createManualClock, type ManualClock } from './clock.ts';
import { startMigratedDatabase, type TestDatabase } from './database.ts';
import { captureLogs, type CapturedLogs } from './logs.ts';
import { scrapeMetrics, type Exposition } from './metrics.ts';
import { createErpWorld, createGate, type ErpWorld } from './worker.ts';

// ---------------------------------------------------------------- o ERP simulado

export interface ErpSeed {
  sku: string;
  name?: string;
  priceCents?: number;
  onHand?: number;
}

// Insere ou troca o produto no ERP simulado: o teste muda o ERP entre as rodadas como o ERP real mudaria.
export async function putErpProducts(
  erpPool: pg.Pool,
  rows: readonly ErpSeed[],
): Promise<void> {
  await erpPool.query(
    `insert into erp_sim.products (sku, name, price_cents, on_hand)
     select * from unnest($1::text[], $2::text[], $3::int[], $4::int[])
     on conflict (sku) do update
       set name = excluded.name, price_cents = excluded.price_cents, on_hand = excluded.on_hand`,
    [
      rows.map((row) => row.sku),
      rows.map((row) => row.name ?? `Capinha ${row.sku}`),
      rows.map((row) => row.priceCents ?? 4990),
      rows.map((row) => row.onHand ?? 10),
    ],
  );
}

// `count` produtos no ERP com SKUs `prefix-001` em diante (50 por página do ERP simulado).
export function putErpCatalog(
  erpPool: pg.Pool,
  prefix: string,
  count: number,
  base: Omit<ErpSeed, 'sku'> = {},
): Promise<void> {
  return putErpProducts(
    erpPool,
    skuRange(prefix, count).map((sku) => ({ ...base, sku })),
  );
}

export async function removeErpProduct(
  erpPool: pg.Pool,
  sku: string,
): Promise<void> {
  await erpPool.query('delete from erp_sim.products where sku = $1', [sku]);
}

// A leitura do catálogo falha na rede (o ERP fora do ar) na página seguinte às `goodPages` que passam.
export function failErpPageAfter(world: ErpWorld, goodPages = 0): void {
  for (let page = 0; page < goodPages; page += 1)
    world.sim.script.enqueue({ mode: 'normal' }, { op: 'listCatalog' });
  world.sim.script.enqueue({ mode: 'unavailable' }, { op: 'listCatalog' });
}

// ---------------------------------------------------------------- a loja

export interface StoreRow {
  name: string;
  priceCents: number;
  onHand: number;
  reserved: number;
  soldTotal: number;
  // Texto do banco, com os microssegundos: o `Date` do JavaScript os perderia.
  productSyncedAt: string;
  inventorySyncedAt: string;
}

export async function readStoreRow(
  pool: pg.Pool,
  sku: string,
): Promise<StoreRow> {
  const result = await pool.query<{
    name: string;
    price_cents: number;
    on_hand: number;
    reserved: number;
    sold_total: number;
    product_synced_at: string;
    inventory_synced_at: string;
  }>(
    `select p.name, p.price_cents, i.on_hand, i.reserved, i.sold_total,
            p.synced_at::text as product_synced_at, i.synced_at::text as inventory_synced_at
       from products p join inventory i on i.sku = p.sku
      where p.sku = $1`,
    [sku],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`o SKU ${sku} não existe na loja`);
  return {
    name: row.name,
    priceCents: row.price_cents,
    onHand: row.on_hand,
    reserved: row.reserved,
    soldTotal: row.sold_total,
    productSyncedAt: row.product_synced_at,
    inventorySyncedAt: row.inventory_synced_at,
  };
}

// A baixa que o worker de faturamento faz (src/billing/conclude.ts): o on_hand desce com piso em zero, a reserva
// vira venda e o sold_total sobe.
export async function billLocally(
  pool: pg.Pool,
  sku: string,
  quantity: number,
): Promise<void> {
  await pool.query(
    `update inventory
        set on_hand = greatest(on_hand - $2, 0), reserved = reserved - $2, sold_total = sold_total + $2
      where sku = $1`,
    [sku, quantity],
  );
}

// `last_completed_at` como texto do banco (microssegundos inclusos); `null` antes da primeira rodada completa.
export async function readLastCompleted(pool: pg.Pool): Promise<string | null> {
  const result = await pool.query<{ at: string | null }>(
    'select last_completed_at::text as at from sync_state',
  );
  return result.rows[0]?.at ?? null;
}

export async function setLastCompleted(
  pool: pg.Pool,
  at: string | null,
): Promise<void> {
  await pool.query('update sync_state set last_completed_at = $1', [at]);
}

// Quantas linhas da tabela têm o `synced_at` diferente do `last_completed_at` (o t0 da rodada).
export async function countRowsNotSyncedAtT0(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `select ((select count(*) from products where synced_at <> (select last_completed_at from sync_state))
           + (select count(*) from inventory where synced_at <> (select last_completed_at from sync_state)))::int as n`,
  );
  return result.rows[0]?.n ?? -1;
}

// `earlier` vem antes de `later`, pela comparação do banco (os dois textos são timestamps).
export async function isBefore(
  pool: pg.Pool,
  earlier: string,
  later: string,
): Promise<boolean> {
  const result = await pool.query<{ ok: boolean }>(
    'select $1::timestamptz < $2::timestamptz as ok',
    [earlier, later],
  );
  return result.rows[0]?.ok === true;
}

export async function databaseNow(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ now: string }>(
    'select clock_timestamp()::text as now',
  );
  return result.rows[0]?.now ?? '';
}

// ---------------------------------------------------------------- a sincronização de um teste

export type SyncFactory = (deps: CatalogSyncDependencies) => CatalogSync;

export interface SyncRigOptions {
  // O ERP simulado compartilhado: duas réplicas leem o mesmo ERP.
  world?: ErpWorld;
  // O ErpClient que a sincronização recebe; padrão, o da `world`. Recebe a telemetria da sincronização.
  erp?: (context: { world: ErpWorld; telemetry: Telemetry }) => ErpClient;
  // Padrão: um relógio novo, só da sincronização. O do ERP é outro, para avançar a sincronização sem estourar o
  // timeout de 10 s de uma chamada em voo.
  clock?: ManualClock;
  pool?: pg.Pool;
  semaphore?: Semaphore;
  intervalMs?: number;
  factory?: SyncFactory;
}

export interface SyncRig {
  sync: CatalogSync;
  world: ErpWorld;
  clock: ManualClock;
  semaphore: Semaphore;
  telemetry: Telemetry;
  logs: CapturedLogs;
  scrape(): Promise<Exposition>;
  spans(): Promise<ReadableSpan[]>;
  // Espera `count` rodadas terminadas (completas ou não): cada rodada escreve o evento de fim no log do worker.
  untilRounds(count: number): Promise<void>;
}

// Repete a conferência até passar: espera um efeito do laço em segundo plano, sem sleep.
export function until(check: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(check, { timeout: WAIT_GUARD_MS, interval: 10 });
}

export const ROUND_COMPLETED = 'casecellshop.catalog.sync.round.completed';
export const ROUND_FAILED = 'casecellshop.catalog.sync.round.failed';

export function roundsFinished(logs: CapturedLogs): number {
  return (
    logs.eventsOf(ROUND_COMPLETED).length + logs.eventsOf(ROUND_FAILED).length
  );
}

export interface SyncDatabase {
  readonly database: TestDatabase;
  // O pool do worker, como em produção (10 conexões).
  readonly pool: pg.Pool;
  readonly erpPool: pg.Pool;
  rig(options?: SyncRigOptions): SyncRig;
  // A vitrine (GET /products) sobre o mesmo banco, fechada no fim do teste.
  storefront(options?: CatalogHarnessOptions): Promise<CatalogHarness>;
  // Roda no fim do teste, na ordem inversa da inscrição e antes de parar as sincronizações: quem prende uma
  // chamada registra aqui a soltura.
  teardown(action: () => void | Promise<void>): void;
}

// O ciclo de vida de um arquivo de teste da sincronização: um banco por arquivo; o catálogo da loja, o do ERP e a
// marca da sincronização zerados antes de cada teste; as sincronizações e as vitrines do teste fechadas depois.
export function useSyncDatabase(): SyncDatabase {
  let database: TestDatabase | undefined;
  let pool: pg.Pool | undefined;
  const teardowns: (() => void | Promise<void>)[] = [];
  const current = (): TestDatabase => {
    if (!database) throw new Error('o banco do arquivo ainda não subiu');
    return database;
  };
  beforeAll(async () => {
    database = await startMigratedDatabase();
    pool = createAppPool(database.uri, 10);
  }, 120_000);
  afterAll(async () => {
    await pool?.end();
    await database?.stop();
  });
  beforeEach(async () => {
    await resetCatalog(current().pool);
    await current().erpPool.query('delete from erp_sim.products');
  });
  afterEach(async () => {
    for (const action of teardowns.splice(0).reverse()) await action();
  });

  const self: SyncDatabase = {
    get database() {
      return current();
    },
    get pool() {
      if (!pool) throw new Error('o pool do worker ainda não subiu');
      return pool;
    },
    get erpPool() {
      return current().erpPool;
    },
    teardown: (action) => {
      teardowns.push(action);
    },
    async storefront(options) {
      const harness = await startCatalogHarness(current(), options);
      teardowns.push(() => harness.close());
      return harness;
    },
    rig(options = {}) {
      const world = options.world ?? createErpWorld(current().erpPool);
      const exporter = new InMemorySpanExporter();
      const telemetry = createTelemetry({ spanExporter: exporter });
      teardowns.push(() => telemetry.shutdown());
      const logs = captureLogs('casecellshop-worker');
      const clock = options.clock ?? createManualClock();
      const semaphore = options.semaphore ?? createSemaphore(30);
      const config: CatalogSyncConfig = {
        ...DEFAULT_CATALOG_SYNC_CONFIG,
        ...(options.intervalMs === undefined
          ? {}
          : { intervalMs: options.intervalMs }),
      };
      const factory = options.factory ?? createCatalogSync;
      const sync = factory({
        pool: options.pool ?? self.pool,
        erp: options.erp ? options.erp({ world, telemetry }) : world.erp,
        semaphore,
        clock,
        logger: logs.logger,
        telemetry,
        config,
      });
      teardowns.push(() => sync.stop());
      return {
        sync,
        world,
        clock,
        semaphore,
        telemetry,
        logs,
        scrape: () => scrapeMetrics(telemetry),
        async spans() {
          await telemetry.forceFlush();
          return exporter.getFinishedSpans();
        },
        untilRounds: (count) =>
          until(() => {
            expect(
              roundsFinished(logs),
              'rodadas terminadas',
            ).toBeGreaterThanOrEqual(count);
          }),
      };
    },
  };
  return self;
}

// ---------------------------------------------------------------- prender uma página do ERP

export interface PageHold {
  // Resolve quando a chamada presa já recebeu a resposta do ERP simulado e espera a soltura.
  parked(): Promise<void>;
  release(): void;
}

// Prende a próxima chamada à listagem do ERP depois de o simulado responder e antes de a resposta voltar à
// sincronização: a rodada fica parada no meio da leitura, sem nenhum comando ao banco em andamento.
export function holdErpPage(db: SyncDatabase, world: ErpWorld): PageHold {
  const gate = createGate();
  world.transport.afterErp({ op: 'listCatalog' }, () => gate.park());
  db.teardown(() => gate.releaseAll());
  return {
    parked: () => gate.waitForParked(1),
    release: () => gate.releaseAll(),
  };
}

// Roda `action` entre a resposta do ERP simulado e a volta dela à sincronização: o instante entre o t0 da rodada e
// o UPDATE do SKU, onde a baixa local pode acontecer.
export function afterNextErpPage(
  world: ErpWorld,
  action: () => Promise<void>,
): void {
  world.transport.afterErp({ op: 'listCatalog' }, action);
}

export interface OlderAndNewer {
  older: SyncRig;
  newer: SyncRig;
  // O last_completed_at logo depois de a rodada mais nova terminar, antes de a mais antiga gravar.
  completedByNewer: string | null;
}

// Duas réplicas leem o mesmo ERP: a mais antiga (t0 menor) pega a página com o valor v1 e fica presa antes de
// gravar; o ERP passa a v2; a mais nova roda inteira; só então a mais antiga é solta. A loja começa em v0.
// A `olderFactory` troca a sincronização da mais antiga (o controle negativo usa a ingênua).
export async function olderReadFinishesAfterNewer(
  db: SyncDatabase,
  sku: string,
  olderFactory?: SyncFactory,
): Promise<OlderAndNewer> {
  await seedCatalog(db.pool, [
    { sku, name: 'v0', priceCents: 1000, onHand: 10 },
  ]);
  await putErpProducts(db.erpPool, [
    { sku, name: 'v1', priceCents: 1100, onHand: 9 },
  ]);
  const older = db.rig(olderFactory ? { factory: olderFactory } : {});
  const newer = db.rig({ world: older.world });
  const hold = holdErpPage(db, older.world);

  const slow = track(older.sync.runRound());
  await hold.parked();
  await putErpProducts(db.erpPool, [
    { sku, name: 'v2', priceCents: 1200, onHand: 8 },
  ]);
  await newer.sync.runRound();
  const completedByNewer = await readLastCompleted(db.pool);
  hold.release();
  await slow.result;
  return { older, newer, completedByNewer };
}

// ---------------------------------------------------------------- o controle negativo

export interface NaiveOptions {
  // Segura uma transação com as linhas do estoque travadas durante toda a rodada (o que o AD-009 evita).
  holdRowLocks?: boolean;
}

async function readWholeCatalog(erp: ErpClient) {
  const items: {
    sku: string;
    name: string;
    priceCents: number;
    onHand: number;
  }[] = [];
  for (let page = 1; ; page += 1) {
    const result = await erp.listCatalog(page);
    if (result.kind !== 'ok') return undefined;
    items.push(...result.page.items);
    if (!result.page.hasNext) return items;
  }
}

// A sincronização ingênua, que o desenho recusa: grava o valor do ERP sem descontar a baixa local e sem a
// condição de `synced_at`, não serializa as rodadas e, se pedido, segura as linhas travadas durante a leitura.
// Serve só aos controles negativos: cada cenário de concorrência precisa reprovar nela.
export function createNaiveCatalogSync(
  options: NaiveOptions = {},
): SyncFactory {
  return (deps) => {
    let stopped = false;
    async function runRound() {
      const client = await deps.pool.connect();
      try {
        if (options.holdRowLocks) {
          await client.query('begin');
          await client.query(
            'select sku from inventory order by sku for update',
          );
        }
        const items = await readWholeCatalog(deps.erp);
        for (const item of items ?? []) {
          await client.query(
            'update "products" set name = $1, price_cents = $2 where sku = $3',
            [item.name, item.priceCents, item.sku],
          );
          await client.query(
            'update "inventory" set on_hand = $1 where sku = $2',
            [item.onHand, item.sku],
          );
        }
        if (options.holdRowLocks) await client.query('commit');
        return {
          complete: items !== undefined,
          skuCount: items?.length ?? 0,
          missingCount: 0,
        };
      } catch (error) {
        if (options.holdRowLocks) await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    async function loop() {
      while (!stopped) {
        runRound().catch(() => undefined);
        await deps.clock.sleep(deps.config.intervalMs);
      }
    }
    return {
      runRound,
      start: () => {
        loop().catch(() => undefined);
        return Promise.resolve();
      },
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
    };
  };
}
