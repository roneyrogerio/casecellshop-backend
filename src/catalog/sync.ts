// A sincronização de preço e estoque com o ERP, no worker (AD-009; design.md, "Sincronização").
import { SpanKind } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { Kysely } from 'kysely';
import { createDb, type StoreDb } from '../db/database.ts';
import type { ErpCatalogItem, ErpClient } from '../erp/erp-client.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import { withPermit, type Semaphore } from '../shared/semaphore.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import type { CatalogSyncConfig } from './config.ts';
import {
  markCompleted,
  readSnapshot,
  upsertInventory,
  upsertProduct,
  zeroMissing,
  type StoreSnapshot,
} from './sync-store.ts';
import { CATALOG_LOG_EVENTS, catalogMetrics } from './telemetry.ts';

export interface CatalogSyncDependencies {
  pool: Pool;
  erp: ErpClient;
  // O semáforo das chamadas ao ERP do processo, o mesmo do envio e da reconciliação.
  semaphore: Semaphore;
  clock: Clock;
  logger: AppLogger;
  telemetry: Telemetry;
  config: CatalogSyncConfig;
}

export interface SyncRoundResult {
  // Todas as páginas do ERP lidas: só então os ausentes são zerados e o last_completed_at é gravado.
  complete: boolean;
  // SKUs lidos do ERP nesta rodada.
  skuCount: number;
  // SKUs ausentes do ERP zerados nesta rodada (0 numa rodada incompleta).
  missingCount: number;
}

export interface CatalogSync {
  // Uma rodada na subida e depois uma por intervalo, uma de cada vez; idempotente.
  start(): Promise<void>;
  // Espera a rodada em andamento.
  stop(): Promise<void>;
  // Uma rodada direta, para os testes; nunca em paralelo com outra.
  runRound(): Promise<SyncRoundResult>;
}

interface Context extends CatalogSyncDependencies {
  db: Kysely<StoreDb>;
}

type CatalogRead =
  | { kind: 'complete'; items: ErpCatalogItem[] }
  | { kind: 'partial'; items: ErpCatalogItem[]; cause: string; page: number };

function listPage(
  { erp, semaphore }: Context,
  page: number,
): ReturnType<ErpClient['listCatalog']> {
  return withPermit(semaphore, () => erp.listCatalog(page));
}

async function readCatalog(ctx: Context): Promise<CatalogRead> {
  const items: ErpCatalogItem[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listPage(ctx, page);
    if (result.kind !== 'ok') {
      const cause =
        result.kind === 'transient' ? result.cause : `http_${result.status}`;
      return { kind: 'partial', items, cause, page };
    }
    items.push(...result.page.items);
    if (!result.page.hasNext) return { kind: 'complete', items };
  }
}

// Conta o campo que o ERP corrigiu: só quando divergia do valor guardado no t0 e o comando gravou a linha.
function countCorrections(
  { telemetry, logger }: Context,
  snapshot: StoreSnapshot,
  item: ErpCatalogItem,
  written: { product: boolean; inventory: boolean },
): void {
  const metrics = catalogMetrics(telemetry);
  const field = 'casecellshop.catalog.sync.field';
  const name = 'casecellshop.catalog.sync.corrections';
  const product = snapshot.products.get(item.sku);
  const stock = snapshot.inventory.get(item.sku);
  const fields: ('price' | 'name' | 'on_hand')[] = [];
  if (written.product && product) {
    if (product.priceCents !== item.priceCents) fields.push('price');
    if (product.name !== item.name) fields.push('name');
  }
  if (written.inventory && stock && stock.onHand !== item.onHand)
    fields.push('on_hand');
  for (const corrected of fields) metrics.add(name, 1, { [field]: corrected });
  // O sku só vai ao log (cardinalidade): uma linha por SKU cuja correção entrou no counter.
  if (fields.length > 0)
    eventLogger(logger, CATALOG_LOG_EVENTS).info(
      'casecellshop.catalog.sync.sku.corrected',
      { sku: item.sku, fields },
      'SKU corrigido pela sincronização',
    );
}

// Um comando por SKU e por tabela, em ordem de SKU: duas réplicas travam as linhas na mesma ordem.
async function writeItems(
  ctx: Context,
  snapshot: StoreSnapshot,
  items: ErpCatalogItem[],
): Promise<void> {
  const sorted = items.toSorted((a, b) => (a.sku < b.sku ? -1 : 1));
  for (const item of sorted) {
    // Só o que mudou: com o ERP igual ao guardado em t0, o valor da fórmula é o que a loja já tem depois das
    // próprias baixas, então o comando não mudaria nada e só custaria uma escrita.
    const storedProduct = snapshot.products.get(item.sku);
    const storedStock = snapshot.inventory.get(item.sku);
    const productChanged =
      storedProduct === undefined ||
      storedProduct.priceCents !== item.priceCents ||
      storedProduct.name !== item.name;
    const inventoryChanged =
      storedStock === undefined || storedStock.onHand !== item.onHand;
    const product =
      productChanged && (await upsertProduct(ctx.db, snapshot.t0, item));
    const inventory =
      inventoryChanged &&
      (await upsertInventory(
        ctx.db,
        snapshot.t0,
        item,
        storedStock?.soldTotal ?? 0,
      ));
    countCorrections(ctx, snapshot, item, { product, inventory });
  }
}

// Só numa rodada completa: o que o ERP não listou deixa de ser vendável. Conta só quem tinha estoque.
async function zeroMissingSkus(
  ctx: Context,
  snapshot: StoreSnapshot,
  items: ErpCatalogItem[],
): Promise<number> {
  const listed = new Set(items.map((item) => item.sku));
  const missing = [...snapshot.inventory.keys()]
    .filter((sku) => !listed.has(sku))
    .toSorted();
  let counted = 0;
  for (const sku of missing) {
    const changed = await zeroMissing(ctx.db, snapshot.t0, sku);
    if ((snapshot.inventory.get(sku)?.onHand ?? 0) > 0 && changed) {
      counted += 1;
      eventLogger(ctx.logger, CATALOG_LOG_EVENTS).warn(
        'casecellshop.catalog.sync.sku.zeroed',
        { sku },
        'SKU ausente do ERP foi zerado',
      );
    }
  }
  catalogMetrics(ctx.telemetry).add(
    'casecellshop.catalog.sync.missing_skus',
    counted,
  );
  return counted;
}

async function roundBody(ctx: Context): Promise<SyncRoundResult> {
  const events = eventLogger(ctx.logger, CATALOG_LOG_EVENTS);
  const startedAt = ctx.clock.now();
  let snapshot: StoreSnapshot;
  let read: CatalogRead;
  let missingCount = 0;
  try {
    snapshot = await readSnapshot(ctx.db);
    read = await readCatalog(ctx);
    await writeItems(ctx, snapshot, read.items);
    if (read.kind === 'complete') {
      missingCount = await zeroMissingSkus(ctx, snapshot, read.items);
      await markCompleted(ctx.db, snapshot.t0);
    }
  } catch (err) {
    // Falha do banco (ou do próprio ERP, que não lança): a rodada fica incompleta e o laço segue.
    events.warn(
      'casecellshop.catalog.sync.round.failed',
      { err },
      'falha do banco na rodada de sincronização',
    );
    return { complete: false, skuCount: 0, missingCount: 0 };
  }
  if (read.kind === 'partial') {
    events.warn(
      'casecellshop.catalog.sync.round.failed',
      { cause: read.cause, page: read.page },
      'rodada de sincronização incompleta: o ERP falhou',
    );
    return { complete: false, skuCount: read.items.length, missingCount: 0 };
  }
  // Depois de gravar: quem vê o evento já encontra o banco no estado final.
  events.info(
    'casecellshop.catalog.sync.round.completed',
    {
      skuCount: read.items.length,
      missingCount,
      duration_ms: ctx.clock.now() - startedAt,
    },
    'rodada de sincronização concluída',
  );
  return { complete: true, skuCount: read.items.length, missingCount };
}

function createRoundLoop(
  { clock, config }: CatalogSyncDependencies,
  runRound: () => Promise<SyncRoundResult>,
) {
  const runner = createLoopRunner({
    clock,
    async run(isRunning) {
      while (isRunning()) {
        const startedAt = clock.now();
        await runRound();
        // A próxima começa um intervalo depois do início desta; se a rodada passou disso, começa logo.
        const remaining = config.intervalMs - (clock.now() - startedAt);
        // O pause do runner acorda no stop(), sem depender de o relógio avançar.
        if (remaining > 0 && isRunning()) await runner.pause(remaining);
      }
    },
  });
  return runner;
}

export function createCatalogSync(deps: CatalogSyncDependencies): CatalogSync {
  const ctx: Context = { ...deps, db: createDb(deps.pool) };

  // Rodadas encadeadas: nunca duas ao mesmo tempo no processo, venham do laço ou de uma chamada direta.
  let tail: Promise<unknown> = Promise.resolve();
  const runRound = (): Promise<SyncRoundResult> => {
    const next = tail.then(() =>
      deps.telemetry.withSpan(
        'catalog.sync.round',
        { kind: SpanKind.INTERNAL },
        () => roundBody(ctx),
      ),
    );
    tail = next.catch(() => undefined);
    return next;
  };

  const runner = createRoundLoop(deps, runRound);

  return {
    async start() {
      await runner.start();
    },
    async stop() {
      await runner.stop();
    },
    runRound,
  };
}
