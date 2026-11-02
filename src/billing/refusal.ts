import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { StoreDb } from '../db/database.ts';
import { outbox, SETTLE_WINDOW_MS } from './call-permit.ts';
import type { OrderConclusion } from './conclude.ts';

// Recusa definitiva depois de um envio sem resposta (AD-031): a criação anterior pode ainda estar em
// processamento no ERP, então a recusa só vira desfecho depois da janela de assentamento.

export type RefusalReason = 'erp_rejected' | 'erp_out_of_stock';

// A recusa já gravada, com o que falta da janela pelo relógio do banco (<= 0 quando já venceu).
export interface StoredRefusal {
  reason: RefusalReason;
  leftMs: number;
}

export function refusalReasonOf(
  reason: 'rejected' | 'out_of_stock',
): RefusalReason {
  return reason === 'rejected' ? 'erp_rejected' : 'erp_out_of_stock';
}

// O refused_at não é regravado: a janela conta da primeira recusa, e cada consulta regrava o last_call_at.
export async function recordRefusal(
  db: Kysely<StoreDb>,
  orderId: string,
  reason: RefusalReason,
): Promise<void> {
  await db
    .updateTable('outbox')
    .set({
      refusal_reason: reason,
      refused_at: outbox.fn.coalesce('refused_at', sql<Date>`now()`),
    })
    .where('order_id', '=', orderId)
    .execute();
}

// Segundos até a mensagem voltar: o que falta da janela mais 1 s, contra a consulta que chega cedo.
export function settleWaitSeconds(leftMs: number): number {
  return Math.ceil(leftMs / 1000) + 1;
}

export const FULL_SETTLE_SECONDS = SETTLE_WINDOW_MS / 1000;

export function settledFailure(
  refusal: StoredRefusal,
  skus: string[],
): OrderConclusion {
  return { kind: 'failed', reason: refusal.reason, skus };
}
