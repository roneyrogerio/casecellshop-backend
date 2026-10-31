import { randomUUID } from 'node:crypto';
import { expressionBuilder, type Kysely, sql } from 'kysely';
import { runInTransaction, type StoreDb } from '../db/database.ts';
import type { ErpOrderItem } from '../erp/erp-client.ts';

export interface ClaimedMessage {
  orderId: string;
  token: string;
  // Já contada com esta reivindicação.
  attempts: number;
  // A mensagem já foi enviada numa reivindicação anterior: consulta antes de criar.
  sentBefore: boolean;
  items: ErpOrderItem[];
  // Gravados pelo checkout: a tentativa continua o trace e o log da requisição.
  correlationId: string;
  traceparent: string | null;
}

export interface ClaimSettled {
  orderId: string;
  attempts: number;
  correlationId: string;
  traceparent: string | null;
}

export interface ClaimResult {
  claimed: ClaimedMessage[];
  // Encerradas na reivindicação, sem chamar o ERP.
  closed: ClaimSettled[];
  dead: ClaimSettled[];
}

export interface ClaimOptions {
  limit: number;
  leaseMs: number;
  minDelayMs: number;
  maxAttempts: number;
}

// Construtor de expressões sobre a tabela, para o `set` receber um objeto (AI-19).
const outbox = expressionBuilder<StoreDb, 'outbox'>();

export function intervalOf(ms: number) {
  return sql<Date>`make_interval(secs => ${ms / 1000})`;
}

// Transação curta, com commit antes de qualquer chamada ao ERP: uma mensagem que derruba o
// processo já tem a tentativa contada e chega à DLQ.
export async function claimMessages(db: Kysely<StoreDb>, { limit, leaseMs, minDelayMs, maxAttempts }: ClaimOptions): Promise<ClaimResult> {
  return runInTransaction(db, async (trx) => {
    const now = sql<Date>`now()`;
    const rows = await trx
      .selectFrom('outbox')
      .innerJoin('orders', 'orders.id', 'outbox.order_id')
      .select(['outbox.order_id', 'outbox.attempts', 'outbox.first_sent_at', 'outbox.lease_until', 'outbox.correlation_id', 'outbox.traceparent', 'orders.status as order_status'])
      .where('outbox.status', '=', 'pending')
      .where('outbox.next_attempt_at', '<=', now)
      .where((eb) => eb.or([eb('outbox.lease_until', 'is', null), eb('outbox.lease_until', '<=', now)]))
      // O atraso mínimo conta do início da última chamada (H4), também para lease vencido.
      .where((eb) => eb.or([eb('outbox.last_call_at', 'is', null), eb(eb('outbox.last_call_at', '+', intervalOf(minDelayMs)), '<=', now)]))
      // Mensagens novas antes das de lease vencido, que vão sozinhas.
      .orderBy((eb) => eb('outbox.lease_until', 'is not', null))
      .orderBy('outbox.next_attempt_at')
      .limit(limit)
      .forUpdate('outbox')
      .skipLocked()
      .execute();

    const result: ClaimResult = { claimed: [], closed: [], dead: [] };
    const candidates: typeof rows = [];
    for (const row of rows) {
      // Não gasta chamada nem tentativa com pedido que já tem desfecho, nem com mensagem sem tentativas.
      const settle = row.order_status !== 'pending' ? ('done' as const) : row.attempts >= maxAttempts ? ('dead' as const) : undefined;
      if (!settle) {
        candidates.push(row);
        continue;
      }
      await trx.updateTable('outbox').set({ status: settle, lease_until: null, claim_token: null }).where('order_id', '=', row.order_id).execute();
      (settle === 'done' ? result.closed : result.dead).push({ orderId: row.order_id, attempts: row.attempts, correlationId: row.correlation_id, traceparent: row.traceparent });
    }

    const [first] = candidates;
    if (!first) return result;
    const chosen = first.lease_until === null ? candidates.filter((row) => row.lease_until === null) : [first];

    for (const row of chosen) {
      const token = randomUUID();
      const updated = await trx
        .updateTable('outbox')
        .set({
          attempts: outbox('attempts', '+', 1),
          claim_token: token,
          lease_until: sql<Date>`now() + ${intervalOf(leaseMs)}`,
          first_sent_at: outbox.fn.coalesce('first_sent_at', now),
        })
        .where('order_id', '=', row.order_id)
        .returning('attempts')
        .executeTakeFirstOrThrow();
      result.claimed.push({
        orderId: row.order_id,
        token,
        attempts: updated.attempts,
        sentBefore: row.first_sent_at !== null,
        items: [],
        correlationId: row.correlation_id,
        traceparent: row.traceparent,
      });
    }

    // Itens com o preço aceito no checkout (H3), lidos junto para a tentativa não ocupar outra conexão.
    const items = await trx
      .selectFrom('order_items')
      .select(['order_id', 'sku', 'quantity', 'unit_price_cents'])
      .where('order_id', 'in', chosen.map((row) => row.order_id))
      .orderBy('sku')
      .execute();
    for (const message of result.claimed) {
      message.items = items
        .filter((item) => item.order_id === message.orderId)
        .map((item) => ({ sku: item.sku, quantity: item.quantity, unitPriceCents: item.unit_price_cents }));
    }
    return result;
  });
}
