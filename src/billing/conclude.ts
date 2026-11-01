import { expressionBuilder, type Kysely, sql } from 'kysely';
import { runInTransaction, type StoreDb } from '../db/database.ts';

// Construtor de expressão sobre a tabela, para o `set` receber um objeto (AI-19).
const inventory = expressionBuilder<StoreDb, 'inventory'>();

// O desfecho que muda o pedido; o retry não passa por aqui, porque só mexe na visibilidade no SQS.
export type OrderConclusion =
  | { kind: 'invoiced' }
  | {
      kind: 'failed';
      reason: 'erp_rejected' | 'erp_out_of_stock' | 'cancelled';
    };

export interface ConclusionResult {
  // O pedido mudou de estado nesta transação; se não, o desfecho já era outro.
  orderChanged: boolean;
  // outcome_at - accepted_at, ambos do banco e da mesma transação; só quando o pedido mudou.
  acceptToOutcomeSeconds?: number;
}

// Compare-and-set do pedido, e o estoque só muda se esta transação mudou o pedido. Quem protege
// contra duas conclusões simultâneas é esse UPDATE condicional, não o receipt handle do SQS.
// Ordem de lock: mensagem da outbox, pedido, estoque por SKU, um UPDATE por linha.
export async function concludeOrder(
  db: Kysely<StoreDb>,
  orderId: string,
  conclusion: OrderConclusion,
): Promise<ConclusionResult> {
  return runInTransaction(db, async (trx): Promise<ConclusionResult> => {
    // A linha da outbox abre a ordem de lock (AGENTS.md): serializa com o relay e com a reconciliação,
    // que também a tocam, e não deixa duas conclusões do mesmo pedido entrelaçarem os locks.
    await trx
      .selectFrom('outbox')
      .select('order_id')
      .where('order_id', '=', orderId)
      .forUpdate()
      .execute();
    return applyConclusion(trx, orderId, conclusion);
  });
}

// Pedido e estoque, para quem já travou a linha da outbox na própria transação (o cancelamento do runbook).
export async function applyConclusion(
  trx: Kysely<StoreDb>,
  orderId: string,
  conclusion: OrderConclusion,
): Promise<ConclusionResult> {
  const order = await trx
    .updateTable('orders')
    .set(
      conclusion.kind === 'invoiced'
        ? { status: 'invoiced', outcome_at: sql<Date>`now()` }
        : {
            status: 'failed',
            failure_reason: conclusion.reason,
            outcome_at: sql<Date>`now()`,
          },
    )
    .where('id', '=', orderId)
    .where('status', '=', 'pending')
    .returning(['accepted_at', 'outcome_at'])
    .executeTakeFirst();
  if (!order) return { orderChanged: false };

  const items = await trx
    .selectFrom('order_items')
    .select(['sku', 'quantity'])
    .where('order_id', '=', orderId)
    .orderBy('sku')
    .execute();
  for (const { sku, quantity } of items) {
    await trx
      .updateTable('inventory')
      .set(
        conclusion.kind === 'invoiced'
          ? {
              // O GREATEST segura o on_hand quando a sincronização já descontou esta venda.
              on_hand: inventory.fn<number>('greatest', [
                inventory('on_hand', '-', quantity),
                inventory.val(0),
              ]),
              reserved: inventory('reserved', '-', quantity),
              sold_total: inventory('sold_total', '+', quantity),
            }
          : { reserved: inventory('reserved', '-', quantity) },
      )
      .where('sku', '=', sku)
      .execute();
  }
  const acceptToOutcomeSeconds = order.outcome_at
    ? (order.outcome_at.getTime() - order.accepted_at.getTime()) / 1000
    : undefined;
  return acceptToOutcomeSeconds === undefined
    ? { orderChanged: true }
    : { orderChanged: true, acceptToOutcomeSeconds };
}
