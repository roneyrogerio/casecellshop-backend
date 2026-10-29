import type { Pool } from 'pg';
import type { Clock } from '../../clock.ts';
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
  return {
    async listCatalog(page) {
      const offset = (Math.max(page, 1) - 1) * CATALOG_PAGE_SIZE;
      // Uma linha a mais que a página diz se existe a próxima.
      const { rows } = await pool.query<{ sku: string; name: string; price_cents: number; on_hand: number }>(
        'SELECT sku, name, price_cents, on_hand FROM erp_sim.products ORDER BY sku LIMIT $1 OFFSET $2',
        [CATALOG_PAGE_SIZE + 1, offset],
      );
      const items: ErpCatalogItem[] = rows.slice(0, CATALOG_PAGE_SIZE).map((row) => ({
        sku: row.sku,
        name: row.name,
        priceCents: row.price_cents,
        onHand: row.on_hand,
      }));
      return { items, hasNext: rows.length > CATALOG_PAGE_SIZE };
    },

    async createOrder(request: ErpOrderRequest) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const totalCents = request.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
        // H1b: a unicidade da referência decide; quem perde a corrida lê a fatura que já existe.
        const inserted = await client.query<InvoiceRow>(
          `INSERT INTO erp_sim.invoices (reference, items, total_cents)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (reference) DO NOTHING
           RETURNING id::text AS id, reference`,
          [request.reference, JSON.stringify(request.items), totalCents],
        );
        const created = inserted.rows[0];
        if (!created) {
          await client.query('COMMIT');
          const existing = await client.query<InvoiceRow>(
            'SELECT id::text AS id, reference FROM erp_sim.invoices WHERE reference = $1',
            [request.reference],
          );
          return toOrder(existing.rows[0] as InvoiceRow);
        }

        // H2: baixa o estoque uma linha por UPDATE, em ordem de SKU para não haver deadlock.
        const ordered = [...request.items].sort((a, b) => a.sku.localeCompare(b.sku));
        for (const item of ordered) {
          const updated = await client.query(
            'UPDATE erp_sim.products SET on_hand = on_hand - $2 WHERE sku = $1 AND on_hand >= $2',
            [item.sku, item.quantity],
          );
          if (updated.rowCount === 0) {
            const known = await client.query('SELECT 1 FROM erp_sim.products WHERE sku = $1', [item.sku]);
            await client.query('ROLLBACK');
            throw new ErpRejectedError(known.rowCount === 0 ? 'unknown_product' : 'out_of_stock', item.sku);
          }
        }
        await client.query('COMMIT');
        return toOrder(created);
      } catch (error) {
        // Falha fora do ROLLBACK acima (conexão, timeout): desfaz o que sobrou aberto.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async findOrderByReference(reference) {
      const { rows } = await pool.query<InvoiceRow>(
        'SELECT id::text AS id, reference FROM erp_sim.invoices WHERE reference = $1',
        [reference],
      );
      const row = rows[0];
      return row ? toOrder(row) : null;
    },
  };
}
