import type { Pool } from 'pg';
import type { Clock } from '../../clock.ts';
import { createErpDb, runInTransaction } from '../../db/database.ts';
import type { ErpCatalogItem, ErpCatalogPage, ErpOrder, ErpOrderRequest } from '../erp-client.ts';
import type { ErpRequest, ErpTransport } from '../transport.ts';

const CATALOG_PAGE_SIZE = 50;

export interface SimulatedErpOptions {
  pool: Pool;
  // Atrasos do roteiro (lento, fatura adiada) correm neste relógio, fora de transação.
  clock: Clock;
  // Sem a H1b, cada criação vira uma fatura nova, mesmo com a referência repetida.
  withoutH1b?: boolean;
}

export type ErpSimOperation = ErpRequest['op'];

// Cada comportamento vale para uma chamada só (design.md, "Roteiro do ERP simulado").
export type ErpSimBehavior =
  | { mode: 'normal' }
  | { mode: 'slow'; delayMs: number }
  | { mode: 'unavailable' }
  | { mode: 'reject' }
  | { mode: 'status'; status: number; body?: unknown }
  | { mode: 'invoice_no_response' }
  | { mode: 'invoice_after'; delayMs: number }
  | { mode: 'fast_502_then_invoice'; delayMs: number }
  | { mode: 'hang' };

export interface ErpSimMatch {
  op?: ErpSimOperation;
  // Só na criação e na consulta, que têm referência.
  reference?: string;
}

export interface ErpSimScript {
  enqueue(behavior: ErpSimBehavior, match?: ErpSimMatch): void;
  // Vale quando nenhum comportamento da fila casa com a chamada; começa em `normal`.
  setDefault(behavior: ErpSimBehavior): void;
  // Espera as faturas adiadas cujo prazo o relógio já alcançou terminarem de gravar.
  drain(): Promise<void>;
}

export interface SimulatedErp {
  transport: ErpTransport;
  script: ErpSimScript;
}

// ERP simulado com transporte e roteiro de falhas (M3).
export function createSimulatedErp(_options: SimulatedErpOptions): SimulatedErp {
  throw new Error('não implementado');
}

// --- Cliente direto do M1, mantido só até a Fatia 1 do M3 migrar o teste do FND-04
// para createSimulatedErp; a porta ErpClient não lança mais exceção de negócio. ---

class ErpRejectedError extends Error {
  readonly reason: 'out_of_stock' | 'unknown_product';
  readonly sku: string;

  constructor(reason: 'out_of_stock' | 'unknown_product', sku: string) {
    super(reason === 'out_of_stock' ? `Sem estoque no ERP: ${sku}` : `Produto desconhecido no ERP: ${sku}`);
    this.reason = reason;
    this.sku = sku;
  }
}

interface LegacySimulatedErpClient {
  listCatalog(page: number): Promise<ErpCatalogPage>;
  createOrder(request: ErpOrderRequest): Promise<ErpOrder>;
  findOrderByReference(reference: string): Promise<ErpOrder | null>;
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
export function createSimulatedErpClient({ pool }: SimulatedErpOptions): LegacySimulatedErpClient {
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
