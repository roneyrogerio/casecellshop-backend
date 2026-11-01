import type { Kysely, Transaction } from 'kysely';
import { runInTransaction, type ErpSimDb } from '../../db/database.ts';
import type {
  ErpCatalogItem,
  ErpOrderItem,
  ErpOrderRequest,
} from '../erp-client.ts';
import type { ErpRequest, ErpResponse } from '../transport.ts';

const CATALOG_PAGE_SIZE = 50;

// O que o acesso ao schema erp_sim precisa do simulador.
export interface ErpStore {
  db: Kysely<ErpSimDb>;
  withoutH1b: boolean;
}

// Aborta a transação de criação para desfazer a fatura e os itens já baixados; o
// invólucro devolve a conexão sã ao pool. Nunca sai deste módulo.
class InvoiceRefused extends Error {
  readonly code: 'out_of_stock' | 'unknown_product';
  readonly sku: string;

  constructor(code: 'out_of_stock' | 'unknown_product', sku: string) {
    super(`Fatura recusada pelo ERP simulado: ${code}`);
    this.code = code;
    this.sku = sku;
  }
}

function orderFromRow(row: { id: string; reference: string }) {
  return { erpOrderId: row.id, reference: row.reference };
}

async function listCatalog(
  { db }: ErpStore,
  page: number,
): Promise<ErpResponse> {
  const offset = (Math.max(page, 1) - 1) * CATALOG_PAGE_SIZE;
  // Uma linha a mais que a página diz se existe a próxima.
  const rows = await db
    .selectFrom('erp_sim.products')
    .select(['sku', 'name', 'price_cents', 'on_hand'])
    .orderBy('sku')
    .limit(CATALOG_PAGE_SIZE + 1)
    .offset(offset)
    .execute();
  const items: ErpCatalogItem[] = rows
    .slice(0, CATALOG_PAGE_SIZE)
    .map((row) => ({
      sku: row.sku,
      name: row.name,
      priceCents: row.price_cents,
      onHand: row.on_hand,
    }));
  return {
    status: 200,
    body: { items, hasNext: rows.length > CATALOG_PAGE_SIZE },
  };
}

async function findOrder(
  { db }: ErpStore,
  reference: string,
): Promise<ErpResponse> {
  // Sem a H1b pode haver várias faturas na referência: a mais antiga é a que vale.
  const row = await db
    .selectFrom('erp_sim.invoices')
    .select(['id', 'reference'])
    .where('reference', '=', reference)
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return row
    ? { status: 200, body: orderFromRow(row) }
    : { status: 404, body: { code: 'order_not_found' } };
}

// H2: baixa o estoque uma linha por UPDATE, em ordem de SKU para não haver deadlock.
async function decrementStock(
  trx: Transaction<ErpSimDb>,
  items: ErpOrderItem[],
): Promise<void> {
  const ordered = [...items].sort((a, b) => a.sku.localeCompare(b.sku));
  for (const item of ordered) {
    const updated = await trx
      .updateTable('erp_sim.products')
      .set({ on_hand: (eb) => eb('on_hand', '-', item.quantity) })
      .where('sku', '=', item.sku)
      .where('on_hand', '>=', item.quantity)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      const known = await trx
        .selectFrom('erp_sim.products')
        .select('sku')
        .where('sku', '=', item.sku)
        .executeTakeFirst();
      throw new InvoiceRefused(
        known ? 'out_of_stock' : 'unknown_product',
        item.sku,
      );
    }
  }
}

async function invoice(
  { withoutH1b }: ErpStore,
  trx: Transaction<ErpSimDb>,
  request: ErpOrderRequest,
): Promise<ErpResponse> {
  const totalCents = request.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPriceCents,
    0,
  );
  // H1b: a unicidade da dedup_key decide; sem ela a chave é nula e nada conflita.
  const created = await trx
    .insertInto('erp_sim.invoices')
    .values({
      reference: request.reference,
      dedup_key: withoutH1b ? null : request.reference,
      items: JSON.stringify(request.items),
      total_cents: totalCents,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .returning(['id', 'reference'])
    .executeTakeFirst();
  if (!created) {
    // O ON CONFLICT espera a outra transação terminar, então a fatura já está visível aqui.
    const existing = await trx
      .selectFrom('erp_sim.invoices')
      .select(['id', 'reference'])
      .where('dedup_key', '=', request.reference)
      .executeTakeFirstOrThrow();
    return { status: 200, body: orderFromRow(existing) };
  }

  await decrementStock(trx, request.items);
  return { status: 201, body: orderFromRow(created) };
}

export async function createOrder(
  store: ErpStore,
  request: ErpOrderRequest,
): Promise<ErpResponse> {
  try {
    return await runInTransaction(store.db, (trx) =>
      invoice(store, trx, request),
    );
  } catch (error) {
    if (error instanceof InvoiceRefused) {
      return { status: 422, body: { code: error.code, sku: error.sku } };
    }
    throw error;
  }
}

export function handle(
  store: ErpStore,
  request: ErpRequest,
): Promise<ErpResponse> {
  if (request.op === 'createOrder') return createOrder(store, request.body);
  if (request.op === 'findOrder') return findOrder(store, request.reference);
  return listCatalog(store, request.page);
}
