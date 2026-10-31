import type { SQSClient } from '@aws-sdk/client-sqs';
import { expressionBuilder, sql } from 'kysely';
import type { Pool } from 'pg';
import type { Clock } from './clock.ts';
import { createDb, runInTransaction, type StoreDb } from './db/database.ts';
import { applyConclusion } from './outbox/conclude.ts';
import { createQueue, startRedrive } from './queue/sqs.ts';

// Runbook da DLQ (design.md, "Worker: reconciliação e runbook").

// Fora do callback do set: a regra do Kysely exige o objeto, e o coalesce precisa citar a coluna.
const outbox = expressionBuilder<StoreDb, 'outbox'>();

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
export async function redriveDlq({ client, dlqUrl, clock, timeoutMs = DEFAULT_REDRIVE_TIMEOUT_MS }: RedriveOptions): Promise<RedriveResult> {
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

// Cancela o pedido ainda pendente, depois de o operador confirmar no ERP que ele
// não existe; devolve se o pedido mudou.
export async function cancelOrder(pool: Pool, orderId: string): Promise<{ changed: boolean }> {
  const db = createDb(pool);
  return runInTransaction(db, async (trx) => {
    // Ordem de lock: a linha da outbox, o pedido e o estoque. Marcar a linha como publicada faz o
    // relay parar de tentar uma linha que não passa no schema da mensagem (A12).
    await trx.updateTable('outbox').set({ published_at: outbox.fn.coalesce('published_at', sql<Date>`now()`) }).where('order_id', '=', orderId).execute();
    const result = await applyConclusion(trx, orderId, { kind: 'failed', reason: 'cancelled' });
    return { changed: result.orderChanged };
  });
}
