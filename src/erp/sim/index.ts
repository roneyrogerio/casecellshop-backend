import type { Pool } from 'pg';
import type { Clock } from '../../clock.ts';
import { createErpDb, runInTransaction } from '../../db/database.ts';
import {
  ErpRejectedError,
  type ErpCatalogItem,
  type ErpClient,
  type ErpOrder,
  type ErpOrderRequest,
} from '../erp-client.ts';

const CATALOG_PAGE_SIZE = 50;

export interface SimulatedErpOptions {
  pool: Pool;
  // Reservado aos modos lento e de falha (M3); o modo normal responde na hora.
  clock: Clock;
}

interface InvoiceRow {
  id: string;
  reference: string;
}

function toOrder(row: InvoiceRow): ErpOrder {
  return { erpOrderId: row.id, reference: row.reference };
}

// ERP simulado só no modo normal: H1a (consulta pela referência), H1b (fatura
// idempotente pela referência), H2 (recusa sem estoque) e H3 (fatura pelo
// preço enviado). Tudo no schema erp_sim, que sobrevive ao reinício do worker.
export function createSimulatedErpClient({ pool }: SimulatedErpOptions): ErpClient {
  const db = createErpDb(pool);

  return {
    async listCatalog(page) {
      const offset = (Math.max(page, 1) - 1) * CATALOG_PAGE_SIZE;
      // Uma linha a mais que a página diz se existe a próxima.
      const rows = await db
        .selectFrom('erp_sim.products')
        .select(['sku', 'name', 'price_cents', 'on_hand'])
        .orderBy('sku')
        .limit(CATALOG_PAGE_SIZE + 1)
        .offset(offset)
        .execute();
      const items: ErpCatalogItem[] = rows.slice(0, CATALOG_PAGE_SIZE).map((row) => ({
        sku: row.sku,
        name: row.name,
        priceCents: row.price_cents,
        onHand: row.on_hand,
      }));
      return { items, hasNext: rows.length > CATALOG_PAGE_SIZE };
    },

    async createOrder(request: ErpOrderRequest) {
      return runInTransaction(db, async (trx) => {
        const totalCents = request.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
        // H1b: a unicidade da referência decide; quem perde a corrida lê a fatura que já existe.
        const created = await trx
          .insertInto('erp_sim.invoices')
          .values({ reference: request.reference, items: JSON.stringify(request.items), total_cents: totalCents })
          .onConflict((oc) => oc.column('reference').doNothing())
          .returning(['id', 'reference'])
          .executeTakeFirst();
        if (!created) {
          // O ON CONFLICT espera a outra transação terminar, então a fatura já está visível aqui.
          const existing = await trx
            .selectFrom('erp_sim.invoices')
            .select(['id', 'reference'])
            .where('reference', '=', request.reference)
            .executeTakeFirstOrThrow();
          return toOrder(existing);
        }

        // H2: baixa o estoque uma linha por UPDATE, em ordem de SKU para não haver deadlock.
        const ordered = [...request.items].sort((a, b) => a.sku.localeCompare(b.sku));
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
            // O invólucro desfaz a fatura e devolve a conexão sã ao pool.
            throw new ErpRejectedError(known ? 'out_of_stock' : 'unknown_product', item.sku);
          }
        }
        return toOrder(created);
      });
    },

    async findOrderByReference(reference) {
      const row = await db
        .selectFrom('erp_sim.invoices')
        .select(['id', 'reference'])
        .where('reference', '=', reference)
        .executeTakeFirst();
      return row ? toOrder(row) : null;
    },
  };
}
