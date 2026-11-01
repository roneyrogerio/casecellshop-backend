import { sql, type Kysely } from 'kysely';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { BillingMessage } from '../contract/billing-message.ts';
import { createDb, type StoreDb } from '../db/database.ts';
import type { ErpClient } from '../erp/erp-client.ts';
import {
  MAX_RECEIVE_BATCH,
  type Queue,
  type ReceivedMessage,
} from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import type { Semaphore } from '../shared/semaphore.ts';
import { runConsumerSpan, type Telemetry } from '../shared/telemetry.ts';
import { MIN_CALL_DELAY_MS, takeCallPermit } from './call-permit.ts';
import { concludeOrder } from './conclude.ts';
import { parseBillingMessage } from './message.ts';

// Reconciliação periódica da DLQ do SQS (AD-003, AD-021; design.md, "Worker:
// reconciliação e runbook").

export interface ReconcilerConfig {
  intervalMs: number;
  maxMessages: number;
  visibilitySeconds: number;
  minDelayMs: number;
}

export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
  intervalMs: 300_000,
  maxMessages: 100,
  visibilitySeconds: 300,
  minDelayMs: MIN_CALL_DELAY_MS,
};

export interface ReconcilerDependencies {
  pool: Pool;
  dlq: Queue;
  erp: ErpClient;
  semaphore: Semaphore;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<ReconcilerConfig>;
}

export interface ReconcileResult {
  seen: number;
  invoiced: number;
  closed: number;
}

export interface Reconciler {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcileOnce(): Promise<ReconcileResult>;
}

type Settled = 'invoiced' | 'closed' | 'kept';

interface Context {
  db: Kysely<StoreDb>;
  dlq: Queue;
  erp: ErpClient;
  semaphore: Semaphore;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  settings: ReconcilerConfig;
  isStopping: () => boolean;
}

// Uma consulta ao ERP por vez, sob uma permissão do semáforo: o limite vale para todo o processo.
async function withSemaphore<T>(
  semaphore: Semaphore,
  fn: () => Promise<T>,
): Promise<T> {
  const permits = await semaphore.acquireFree();
  semaphore.release(permits - 1);
  try {
    return await fn();
  } finally {
    semaphore.release(1);
  }
}

// O dead_at marca a chegada à DLQ uma vez; a permissão de chamada do worker o zera.
async function markDead(
  { db, telemetry }: Context,
  orderId: string,
  log: Logger,
): Promise<void> {
  const marked = await db
    .updateTable('outbox')
    .set({ dead_at: sql<Date>`now()` })
    .where('order_id', '=', orderId)
    .where('dead_at', 'is', null)
    .returning('order_id')
    .executeTakeFirst();
  if (!marked) return;
  log.error(
    { event: 'outbox.dead' },
    'a mensagem chegou à DLQ: o pedido segue pendente com a reserva',
  );
  telemetry.outboxAttemptOutcome.add(1, { outcome: 'dead' });
}

// Confirma no ERP que o pedido existe e então o fatura; 'kept' deixa a mensagem para o runbook.
async function invoiceIfFound(
  ctx: Context,
  received: ReceivedMessage,
  message: BillingMessage,
  log: Logger,
): Promise<Settled> {
  const { db, dlq, erp, telemetry, settings } = ctx;
  // Sem a permissão (outra chamada há menos que o atraso mínimo), a mensagem fica para o runbook.
  const permit = await takeCallPermit(db, message.orderId, {
    minDelayMs: settings.minDelayMs,
    clearDead: false,
  });
  if (!permit.granted) return 'kept';
  const found = await erp.findOrderByReference(message.orderId);
  if (found.kind !== 'found') return 'kept';

  const result = await concludeOrder(db, message.orderId, { kind: 'invoiced' });
  if (result.orderChanged) {
    telemetry.outboxAttemptOutcome.add(1, { outcome: 'invoiced' });
    log.info({ event: 'order.invoiced' }, 'pedido faturado pela reconciliação');
    if (result.acceptToOutcomeSeconds !== undefined)
      telemetry.orderAcceptToInvoice.record(result.acceptToOutcomeSeconds);
  }
  await dlq.delete(received.receiptHandle);
  return 'invoiced';
}

// Devolve o que a mensagem acrescenta ao resultado da rodada.
async function settleMessage(
  ctx: Context,
  received: ReceivedMessage,
  message: BillingMessage,
  log: Logger,
): Promise<Settled> {
  const { db, dlq, telemetry, semaphore } = ctx;
  await markDead(ctx, message.orderId, log);

  const order = await db
    .selectFrom('orders')
    .select('status')
    .where('id', '=', message.orderId)
    .executeTakeFirst();
  if (!order) return 'kept';
  if (order.status !== 'pending') {
    if ((await dlq.delete(received.receiptHandle)) !== 'ok') return 'kept';
    telemetry.outboxAttemptOutcome.add(1, { outcome: 'closed' });
    log.info(
      { event: 'outbox.closed' },
      'pedido já tinha desfecho: mensagem apagada da DLQ',
    );
    return 'closed';
  }

  return withSemaphore(semaphore, () =>
    invoiceIfFound(ctx, received, message, log),
  );
}

// Dentro do span de encerramento, no trace do checkout e com o correlationId dele nos logs.
function inSettleSpan(
  ctx: Context,
  received: ReceivedMessage,
  message: BillingMessage,
): Promise<Settled> {
  const options = {
    name: 'outbox.settle',
    traceparent: received.traceparent,
    correlationId: message.correlationId,
    attributes: { orderId: message.orderId },
  };
  return runConsumerSpan(ctx.telemetry, options, async () => {
    const log = ctx.logger.child({
      orderId: message.orderId,
      correlationId: message.correlationId,
    });
    try {
      return await settleMessage(ctx, received, message, log);
    } catch (error) {
      // Uma mensagem com problema não impede as outras da rodada; logada aqui, leva correlationId e trace.
      log.warn(
        { event: 'outbox.reconcile_error', err: error },
        'falha ao reconciliar a mensagem',
      );
      return 'kept';
    }
  });
}

async function reconcileOnce(ctx: Context): Promise<ReconcileResult> {
  const { dlq, settings } = ctx;
  const result: ReconcileResult = { seen: 0, invoiced: 0, closed: 0 };
  // Só o stop() marca 'stopping': uma chamada direta com o reconciliador parado processa tudo.
  while (result.seen < settings.maxMessages && !ctx.isStopping()) {
    const batch = await dlq.receive({
      max: Math.min(MAX_RECEIVE_BATCH, settings.maxMessages - result.seen),
      waitSeconds: 0,
      visibilitySeconds: settings.visibilitySeconds,
    });
    if (batch.length === 0) break;
    result.seen += batch.length;
    for (const received of batch) {
      if (ctx.isStopping()) return result;
      const parsed = parseBillingMessage(received.body);
      // Corpo fora do schema fica na DLQ para o runbook.
      if (!parsed.valid) continue;
      const outcome = await inSettleSpan(ctx, received, parsed.message);
      if (outcome !== 'kept') result[outcome] += 1;
    }
  }
  return result;
}

async function round(ctx: Context): Promise<void> {
  try {
    const result = await reconcileOnce(ctx);
    ctx.logger.info(
      { event: 'outbox.reconciled', ...result },
      'rodada de reconciliação concluída',
    );
  } catch (error) {
    ctx.logger.warn(
      { event: 'outbox.reconcile_error', err: error },
      'falha na rodada de reconciliação',
    );
  }
}

export function createReconciler({
  pool,
  dlq,
  erp,
  semaphore,
  logger,
  telemetry,
  clock,
  config,
}: ReconcilerDependencies): Reconciler {
  const settings: ReconcilerConfig = {
    ...DEFAULT_RECONCILER_CONFIG,
    ...config,
  };
  let wake: (() => void) | undefined;
  const ctx: Context = {
    db: createDb(pool),
    dlq,
    erp,
    semaphore,
    logger,
    telemetry,
    clock,
    settings,
    isStopping: () => runner.isStopping(),
  };

  const runner = createLoopRunner({
    async run(isRunning) {
      while (isRunning()) {
        await round(ctx);
        if (!isRunning()) break;
        // O stop() acorda a espera: sem isso, o encerramento aguardaria o intervalo inteiro (5 min).
        await Promise.race([
          clock.sleep(settings.intervalMs),
          new Promise<void>((resolve) => (wake = resolve)),
        ]);
      }
    },
    onStopping: () => wake?.(),
  });

  return {
    start: () => runner.start(),
    stop: () => runner.stop(),
    reconcileOnce: () => reconcileOnce(ctx),
  };
}
