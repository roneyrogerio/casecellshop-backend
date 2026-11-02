import type { SQSClient } from '@aws-sdk/client-sqs';
import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb, runInTransaction } from '../db/database.ts';
import { outbox, SETTLE_WINDOW_MS, takeCallPermit } from './call-permit.ts';
import { applyConclusion } from './conclude.ts';
import type { ErpClient } from '../erp/erp-client.ts';
import { createQueue, startRedrive } from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';

// Runbook da DLQ (design.md, "Worker: reconciliação e runbook").

const DEFAULT_REDRIVE_TIMEOUT_MS = 60_000;
const REDRIVE_POLL_MS = 1_000;

export interface RedriveOptions {
  client: SQSClient;
  dlqUrl: string;
  clock: Clock;
  // Até quando esperar a DLQ esvaziar.
  timeoutMs?: number;
}

export interface RedriveResult {
  before: number;
  remaining: number;
}

// Devolve as mensagens da DLQ à fila de origem e acompanha pela contagem da DLQ,
// sem o ListMessageMoveTasks, que derruba o ElasticMQ nativo (R12).
export async function redriveDlq({
  client,
  dlqUrl,
  clock,
  timeoutMs = DEFAULT_REDRIVE_TIMEOUT_MS,
}: RedriveOptions): Promise<RedriveResult> {
  const dlq = createQueue(client, dlqUrl);
  const before = await dlq.approximateCount();
  await startRedrive(client, dlqUrl);
  const deadline = clock.now() + timeoutMs;
  let remaining = await dlq.approximateCount();
  while (remaining > 0 && clock.now() < deadline) {
    await clock.sleep(REDRIVE_POLL_MS);
    remaining = await dlq.approximateCount();
  }
  return { before, remaining };
}

export interface CancelOrderDependencies {
  pool: Pool;
  erp: ErpClient;
  // Padrão: SETTLE_WINDOW_MS; o teste pode encurtar.
  settleWindowMs?: number;
}

// Resultado do cancelamento seguro (AD-031): só `cancelled` muda o pedido.
export type CancelOrderResult =
  | { kind: 'cancelled' }
  // O pedido já tinha desfecho.
  | { kind: 'unchanged' }
  // A última chamada ao ERP é mais nova que a janela de assentamento.
  | { kind: 'too_recent'; retryInMs: number }
  | { kind: 'erp_has_order' }
  | { kind: 'erp_unavailable' }
  // Outra tentativa tomou a permissão de chamada entre a consulta e o cancelamento.
  | { kind: 'permit_lost' };

// Cancela o pedido ainda pendente que o ERP não tem, só fora da janela de assentamento (AD-031).
export async function cancelOrder(
  { pool, erp, settleWindowMs = SETTLE_WINDOW_MS }: CancelOrderDependencies,
  orderId: string,
): Promise<CancelOrderResult> {
  const db = createDb(pool);
  // A janela no lugar do atraso mínimo: o mesmo UPDATE confere que a última chamada é antiga e impede
  // outra tentativa de chamar o ERP enquanto o cancelamento consulta. Sem somar create_calls nem zerar dead_at.
  const permit = await takeCallPermit(db, orderId, {
    minDelayMs: settleWindowMs,
    clearDead: false,
  });
  if (!permit.granted)
    return { kind: 'too_recent', retryInMs: permit.retryInMs };

  // Fora de transação: o ERP nunca é chamado com a transação aberta.
  const found = await erp.findOrderByReference(orderId);
  if (found.kind === 'found') return { kind: 'erp_has_order' };
  if (found.kind !== 'not_found') return { kind: 'erp_unavailable' };

  return runInTransaction(db, async (trx): Promise<CancelOrderResult> => {
    // Ordem de lock: a linha da outbox primeiro. O token confere que ninguém tomou a permissão depois da consulta.
    const row = await trx
      .selectFrom('outbox')
      .select('order_id')
      .where('order_id', '=', orderId)
      .where('call_token', '=', permit.token)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { kind: 'permit_lost' };
    // Publicada, o relay para de tentar uma linha que já não passa no schema da mensagem.
    await trx
      .updateTable('outbox')
      .set({
        published_at: outbox.fn.coalesce('published_at', sql<Date>`now()`),
      })
      .where('order_id', '=', orderId)
      .execute();
    const conclusion = await applyConclusion(trx, orderId, {
      kind: 'failed',
      reason: 'cancelled',
    });
    return { kind: conclusion.orderChanged ? 'cancelled' : 'unchanged' };
  });
}

// A mensagem ao operador de cada resultado, e se o comando sai com erro (as recusas).
export function describeCancel(
  orderId: string,
  result: CancelOrderResult,
): { message: string; failed: boolean } {
  switch (result.kind) {
    case 'cancelled':
      return {
        message: `Pedido ${orderId} cancelado: o ERP não o tem e a reserva de estoque foi liberada.`,
        failed: false,
      };
    case 'unchanged':
      return {
        message: `Pedido ${orderId} já tinha desfecho: nada mudou.`,
        failed: false,
      };
    case 'too_recent':
      return {
        message: `Pedido ${orderId} não cancelado: a última chamada ao ERP é recente; tente de novo em cerca de ${Math.max(1, Math.ceil(result.retryInMs / 60_000))} min.`,
        failed: true,
      };
    case 'erp_has_order':
      return {
        message: `Pedido ${orderId} não cancelado: o ERP já tem o pedido; use o redrive ou espere a reconciliação.`,
        failed: true,
      };
    case 'erp_unavailable':
      return {
        message: `Pedido ${orderId} não cancelado: a consulta ao ERP falhou e conta como chamada ao ERP; a nova tentativa só passa depois da janela de assentamento (15 min).`,
        failed: true,
      };
    case 'permit_lost':
      return {
        message: `Pedido ${orderId} não cancelado: outra tentativa chamou o ERP durante o cancelamento, e a consulta conta como chamada ao ERP; a nova tentativa só passa depois da janela de assentamento (15 min).`,
        failed: true,
      };
  }
}
