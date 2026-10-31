import { expressionBuilder, type Kysely, sql } from 'kysely';
import { runInTransaction, type StoreDb } from '../db/database.ts';
import { intervalOf } from './claim.ts';

// Construtores de expressão sobre a tabela, para o `set` receber um objeto (AI-19).
const outbox = expressionBuilder<StoreDb, 'outbox'>();
const inventory = expressionBuilder<StoreDb, 'inventory'>();

export type Conclusion =
  | { kind: 'invoiced' }
  | { kind: 'failed'; reason: 'erp_rejected' | 'erp_out_of_stock' }
  // Atraso mínimo mais jitter, contado do início da última chamada.
  | { kind: 'retry'; delayMs: number }
  | { kind: 'dead' };

// Toda transição da outbox exige o token da reivindicação: um worker atrasado não sobrescreve
// o desfecho de outro. Devolve false quando o token já não vale (nada muda).
// Ordem de lock: outbox, pedido, estoque por SKU, um UPDATE por linha.
export async function concludeMessage(db: Kysely<StoreDb>, orderId: string, token: string, conclusion: Conclusion): Promise<boolean> {
  return runInTransaction(db, async (trx) => {
    const message = trx.updateTable('outbox').where('order_id', '=', orderId).where('claim_token', '=', token).where('status', '=', 'pending');

    if (conclusion.kind === 'retry') {
      const retried = await message
        .set({
          next_attempt_at: sql<Date>`${outbox.fn.coalesce('last_call_at', sql<Date>`now()`)} + ${intervalOf(conclusion.delayMs)}`,
          lease_until: null,
          claim_token: null,
        })
        .executeTakeFirst();
      return retried.numUpdatedRows > 0n;
    }
    if (conclusion.kind === 'dead') {
      // O pedido segue pending e a reserva fica, para o runbook decidir.
      const buried = await message.set({ status: 'dead', lease_until: null, claim_token: null }).executeTakeFirst();
      return buried.numUpdatedRows > 0n;
    }

    const closed = await message.set({ status: 'done', lease_until: null, claim_token: null }).executeTakeFirst();
    if (closed.numUpdatedRows === 0n) return false;

    // Compare-and-set: o estoque só muda se esta transação mudou o pedido.
    const order = await trx
      .updateTable('orders')
      .set(
        conclusion.kind === 'invoiced'
          ? { status: 'invoiced', outcome_at: sql<Date>`now()` }
          : { status: 'failed', failure_reason: conclusion.reason, outcome_at: sql<Date>`now()` },
      )
      .where('id', '=', orderId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (order.numUpdatedRows === 0n) return true;

    const items = await trx.selectFrom('order_items').select(['sku', 'quantity']).where('order_id', '=', orderId).orderBy('sku').execute();
    for (const { sku, quantity } of items) {
      await trx
        .updateTable('inventory')
        .set(
          conclusion.kind === 'invoiced'
            ? {
                // O GREATEST segura o on_hand quando a sincronização já descontou esta venda.
                on_hand: inventory.fn<number>('greatest', [inventory('on_hand', '-', quantity), inventory.val(0)]),
                reserved: inventory('reserved', '-', quantity),
                sold_total: inventory('sold_total', '+', quantity),
              }
            : { reserved: inventory('reserved', '-', quantity) },
        )
        .where('sku', '=', sku)
        .execute();
    }
    return true;
  });
}

// Pelo relógio do banco: enquanto o lease vale, a conclusão que falhou pode ser repetida.
export async function holdsLease(db: Kysely<StoreDb>, orderId: string, token: string): Promise<boolean> {
  const row = await db
    .selectFrom('outbox')
    .select((eb) => eb(eb.ref('lease_until'), '>', sql<Date>`now()`).as('valid'))
    .where('order_id', '=', orderId)
    .where('claim_token', '=', token)
    .executeTakeFirst();
  return row?.valid === true;
}
