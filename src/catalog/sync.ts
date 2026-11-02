// A sincronização de preço e estoque com o ERP, no worker (AD-009; design.md, "Sincronização").
import { SpanKind } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { Kysely } from 'kysely';
import { createDb, type StoreDb } from '../db/database.ts';
import type { ErpCatalogItem, ErpClient } from '../erp/erp-client.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import type { Semaphore } from '../shared/semaphore.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import type { CatalogSyncConfig } from './config.ts';
import {
  markCompleted,
  readSnapshot,
  readStoredAgeMs,
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
  // O início da última rodada completa no relógio do processo; base do gauge de idade.
  completedMark: { value: number | undefined };
}

type CatalogRead =
  | { kind: 'complete'; items: ErpCatalogItem[] }
  | { kind: 'partial'; items: ErpCatalogItem[]; cause: string; page: number };

// Uma chamada ao ERP por vez, sob uma permissão do semáforo: o limite vale para o processo todo.
async function listPage(
  { erp, semaphore }: Context,
  page: number,
): ReturnType<ErpClient['listCatalog']> {
  const permits = await semaphore.acquireFree();
  semaphore.release(permits - 1);
  try {
    return await erp.listCatalog(page);
  } finally {
    semaphore.release(1);
  }
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
  { telemetry }: Context,
  snapshot: StoreSnapshot,
  item: ErpCatalogItem,
  written: { product: boolean; inventory: boolean },
): void {
  const metrics = catalogMetrics(telemetry);
  const field = 'casecellshop.catalog.sync.field';
  const name = 'casecellshop.catalog.sync.corrections';
  const product = snapshot.products.get(item.sku);
  const stock = snapshot.inventory.get(item.sku);
  if (written.product && product) {
    if (product.priceCents !== item.priceCents)
      metrics.add(name, 1, { [field]: 'price' });
    if (product.name !== item.name) metrics.add(name, 1, { [field]: 'name' });
  }
  if (written.inventory && stock && stock.onHand !== item.onHand)
    metrics.add(name, 1, { [field]: 'on_hand' });
}

// Um comando por SKU e por tabela, em ordem de SKU: duas réplicas travam as linhas na mesma ordem.
async function writeItems(
  ctx: Context,
  snapshot: StoreSnapshot,
  items: ErpCatalogItem[],
): Promise<void> {
  const sorted = items.toSorted((a, b) => (a.sku < b.sku ? -1 : 1));
  for (const item of sorted) {
    const product = await upsertProduct(ctx.db, snapshot.t0, item);
    const inventory = await upsertInventory(
      ctx.db,
      snapshot.t0,
      item,
      snapshot.inventory.get(item.sku)?.soldTotal ?? 0,
    );
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
    if ((snapshot.inventory.get(sku)?.onHand ?? 0) > 0 && changed) counted += 1;
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
  ctx.completedMark.value = startedAt;
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

// Antes da primeira rodada: com o ERP fora desde a subida, a idade parte da última rodada gravada.
async function seedCompletedMark(ctx: Context): Promise<void> {
  if (ctx.completedMark.value !== undefined) return;
  const ageMs = await readStoredAgeMs(ctx.db);
  if (ageMs !== undefined && ctx.completedMark.value === undefined)
    ctx.completedMark.value = ctx.clock.now() - ageMs;
}

function createRoundLoop(
  { clock, config }: CatalogSyncDependencies,
  runRound: () => Promise<SyncRoundResult>,
) {
  // Acorda o laço que dorme, sem depender de o relógio avançar.
  let wake: (() => void) | undefined;
  return createLoopRunner({
    async run(isRunning) {
      while (isRunning()) {
        const startedAt = clock.now();
        await runRound();
        // A próxima começa um intervalo depois do início desta; se a rodada passou disso, começa logo.
        const remaining = config.intervalMs - (clock.now() - startedAt);
        if (remaining > 0 && isRunning()) {
          await Promise.race([
            clock.sleep(remaining),
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
          ]);
        }
      }
    },
    onStopping: () => wake?.(),
  });
}

export function createCatalogSync(deps: CatalogSyncDependencies): CatalogSync {
  const ctx: Context = {
    ...deps,
    db: createDb(deps.pool),
    completedMark: { value: undefined },
  };
  catalogMetrics(deps.telemetry).observe('casecellshop.catalog.sync.age', () =>
    ctx.completedMark.value === undefined
      ? undefined
      : (deps.clock.now() - ctx.completedMark.value) / 1000,
  );

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
      await seedCompletedMark(ctx);
      await runner.start();
    },
    stop: () => runner.stop(),
    runRound,
  };
}
