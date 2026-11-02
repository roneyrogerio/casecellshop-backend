import { sql, type Kysely } from 'kysely';
import type { StoreDb } from '../db/database.ts';
import { intervalOf } from './call-permit.ts';

// Acesso ao banco da verificação tardia (AD-031): quais pedidos checar e a marca do resultado.

export type LateFinding = 'failed_order' | 'duplicate';

export interface LateCandidate {
  orderId: string;
  correlationId: string;
  status: 'invoiced' | 'failed';
}

// Tudo pelo relógio do banco. Um envio só com resposta conclusiva nunca entra: tem no máximo uma fatura.
// O `create_calls >= 1` do cancelado repete o predicado do índice parcial, para o planejador usá-lo.
export async function selectCandidates(
  db: Kysely<StoreDb>,
  settleWindowMs: number,
  limit: number,
): Promise<LateCandidate[]> {
  const rows = await db
    .selectFrom('outbox')
    .innerJoin('orders', 'orders.id', 'outbox.order_id')
    .select(['outbox.order_id', 'outbox.correlation_id', 'orders.status'])
    .where('outbox.late_checked_at', 'is', null)
    .where('outbox.create_calls', '>=', 1)
    .where(
      (eb) =>
        eb(eb.ref('outbox.last_call_at'), '+', intervalOf(settleWindowMs)),
      '<=',
      sql<Date>`now()`,
    )
    .where('orders.status', 'in', ['invoiced', 'failed'])
    .where((eb) =>
      eb.or([
        eb('outbox.create_calls', '>=', 2),
        eb.and([
          eb('orders.status', '=', 'failed'),
          eb('orders.failure_reason', '=', 'cancelled'),
        ]),
      ]),
    )
    .orderBy('outbox.last_call_at')
    .limit(limit)
    .execute();
  return rows.flatMap((row) =>
    row.status === 'invoiced' || row.status === 'failed'
      ? [
          {
            orderId: row.order_id,
            correlationId: row.correlation_id,
            status: row.status,
          },
        ]
      : [],
  );
}

// Grava a marca; o `late_checked_at IS NULL` repetido faz só uma réplica ganhar o mesmo pedido. Devolve
// false quando outra já gravou, para o alerta sair uma vez só.
export async function markChecked(
  db: Kysely<StoreDb>,
  orderId: string,
  finding: LateFinding | undefined,
): Promise<boolean> {
  const marked = await db
    .updateTable('outbox')
    .set({ late_checked_at: sql<Date>`now()`, late_finding: finding ?? null })
    .where('order_id', '=', orderId)
    .where('late_checked_at', 'is', null)
    .returning('order_id')
    .executeTakeFirst();
  return marked !== undefined;
}
