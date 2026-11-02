// Os comandos da sincronização contra o banco da loja (AD-009; design.md, "Sincronização"): cada SKU é um comando
// próprio, fora de transação, para nenhuma rodada segurar o lock de uma linha enquanto lê o ERP ou grava a vizinha.
import { sql, type Kysely } from 'kysely';
import type { StoreDb } from '../db/database.ts';
import type { ErpCatalogItem } from '../erp/erp-client.ts';

// O que a loja guardava de cada SKU no início da rodada: a base da correção por campo e do desconto da baixa local.
export interface StoreSnapshot {
  // Texto do banco, com os microssegundos: um `Date` do JavaScript os perderia e o `synced_at` não bateria com o t0.
  t0: string;
  products: Map<string, { name: string; priceCents: number }>;
  inventory: Map<string, { onHand: number; soldTotal: number }>;
}

// O t0 como parâmetro tipado do banco: o texto mantém os microssegundos que a comparação precisa.
const instant = (t0: string) => sql<Date>`${t0}::timestamptz`;

export async function readSnapshot(
  db: Kysely<StoreDb>,
): Promise<StoreSnapshot> {
  // O t0 é o relógio do banco (AGENTS.md): é ele que ordena as réplicas, não o relógio do processo.
  const { t0 } = await db
    .selectNoFrom(sql<string>`now()::text`.as('t0'))
    .executeTakeFirstOrThrow();
  const products = await db
    .selectFrom('products')
    .select(['sku', 'name', 'price_cents'])
    .execute();
  const inventory = await db
    .selectFrom('inventory')
    .select(['sku', 'on_hand', 'sold_total'])
    .execute();
  return {
    t0,
    products: new Map(
      products.map((row) => [
        row.sku,
        { name: row.name, priceCents: row.price_cents },
      ]),
    ),
    inventory: new Map(
      inventory.map((row) => [
        row.sku,
        { onHand: row.on_hand, soldTotal: row.sold_total },
      ]),
    ),
  };
}

// A condição `synced_at < t0` impede que a rodada mais antiga, que leu o ERP antes, sobrescreva a mais nova.
// Devolve se o comando gravou a linha.
export async function upsertProduct(
  db: Kysely<StoreDb>,
  t0: string,
  item: ErpCatalogItem,
): Promise<boolean> {
  const row = await db
    .insertInto('products')
    .values({
      sku: item.sku,
      name: item.name,
      price_cents: item.priceCents,
      synced_at: t0,
    })
    .onConflict((oc) =>
      oc
        .column('sku')
        .doUpdateSet({
          name: (eb) => eb.ref('excluded.name'),
          price_cents: (eb) => eb.ref('excluded.price_cents'),
          synced_at: t0,
        })
        .where('products.synced_at', '<', instant(t0)),
    )
    .returning('sku')
    .executeTakeFirst();
  return row !== undefined;
}

// O on_hand do ERP já não conta as vendas faturadas aqui depois do t0: desconta-se o que o sold_total subiu desde
// então, com piso em zero. O `reserved` nunca entra: é da loja.
export async function upsertInventory(
  db: Kysely<StoreDb>,
  t0: string,
  item: ErpCatalogItem,
  soldTotalAtT0: number,
): Promise<boolean> {
  const row = await db
    .insertInto('inventory')
    .values({ sku: item.sku, on_hand: item.onHand, synced_at: t0 })
    .onConflict((oc) =>
      oc
        .column('sku')
        .doUpdateSet({
          on_hand: (eb) =>
            eb.fn<number>('greatest', [
              // (ERP − sold_total) + sold_total no t0: escrito assim porque o Kysely não parentetiza a subtração aninhada.
              eb(
                eb(
                  eb.ref('excluded.on_hand'),
                  '-',
                  eb.ref('inventory.sold_total'),
                ),
                '+',
                soldTotalAtT0,
              ),
              eb.val(0),
            ]),
          synced_at: t0,
        })
        .where('inventory.synced_at', '<', instant(t0)),
    )
    .returning('sku')
    .executeTakeFirst();
  return row !== undefined;
}

// Produto ausente do ERP numa rodada completa: sai da vitrine como esgotado, sem apagar a linha (há pedidos nela).
export async function zeroMissing(
  db: Kysely<StoreDb>,
  t0: string,
  sku: string,
): Promise<boolean> {
  const row = await db
    .updateTable('inventory')
    .set({ on_hand: 0, synced_at: t0 })
    .where('sku', '=', sku)
    .where('synced_at', '<', instant(t0))
    .returning('sku')
    .executeTakeFirst();
  return row !== undefined;
}

// Só avança: uma réplica mais antiga que termina depois não faz a marca voltar.
export async function markCompleted(
  db: Kysely<StoreDb>,
  t0: string,
): Promise<void> {
  await db
    .updateTable('sync_state')
    .set({ last_completed_at: t0 })
    .where((eb) =>
      eb.or([
        eb('last_completed_at', 'is', null),
        eb('last_completed_at', '<', instant(t0)),
      ]),
    )
    .execute();
}
