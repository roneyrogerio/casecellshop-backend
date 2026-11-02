import { sql, type Kysely } from 'kysely';
import type { Pool } from 'pg';
import type { BillingMessage } from '../contract/billing-message.ts';
import { createDb, type StoreDb } from '../db/database.ts';
import type { ErpClient } from '../erp/erp-client.ts';
import {
  MAX_RECEIVE_BATCH,
  type Queue,
  type ReceivedMessage,
} from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import { withPermit, type Semaphore } from '../shared/semaphore.ts';
import { runConsumerSpan, type Telemetry } from '../shared/telemetry.ts';
import { MIN_CALL_DELAY_MS, takeCallPermit } from './call-permit.ts';
import { concludeOrder } from './conclude.ts';
import { parseBillingMessage } from './message.ts';
import { queueGaugeLifecycle } from './queue-gauge.ts';
import { BILLING_LOG_EVENTS, billingMetrics } from './telemetry.ts';

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
  logger: AppLogger;
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
  logger: AppLogger;
  telemetry: Telemetry;
  clock: Clock;
  settings: ReconcilerConfig;
  isStopping: () => boolean;
}

// O dead_at marca a chegada à DLQ uma vez; a permissão de chamada do worker o zera.
async function markDead(
  { db, telemetry }: Context,
  orderId: string,
  log: AppLogger,
): Promise<void> {
  const marked = await db
    .updateTable('outbox')
    .set({ dead_at: sql<Date>`now()` })
    .where('order_id', '=', orderId)
    .where('dead_at', 'is', null)
    .returning('order_id')
    .executeTakeFirst();
  if (!marked) return;
  eventLogger(log, BILLING_LOG_EVENTS).error(
    'casecellshop.outbox.dead',
    {},
    'a mensagem chegou à DLQ: o pedido segue pendente com a reserva',
  );
  billingMetrics(telemetry).add('casecellshop.outbox.attempts', 1, {
    'casecellshop.outbox.attempt.outcome': 'dead',
  });
}

// Confirma no ERP que o pedido existe e então o fatura; 'kept' deixa a mensagem para o runbook.
async function invoiceIfFound(
  ctx: Context,
  received: ReceivedMessage,
  message: BillingMessage,
  log: AppLogger,
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
    const metrics = billingMetrics(telemetry);
    metrics.add('casecellshop.outbox.attempts', 1, {
      'casecellshop.outbox.attempt.outcome': 'invoiced',
    });
    eventLogger(log, BILLING_LOG_EVENTS).info(
      'casecellshop.order.invoiced',
      {},
      'pedido faturado pela reconciliação',
    );
    if (result.acceptToOutcomeSeconds !== undefined)
      metrics.record(
        'casecellshop.order.accept_to_invoice.duration',
        result.acceptToOutcomeSeconds,
      );
  }
  await dlq.delete(received.receiptHandle);
  return 'invoiced';
}

// Devolve o que a mensagem acrescenta ao resultado da rodada.
async function settleMessage(
  ctx: Context,
  received: ReceivedMessage,
  message: BillingMessage,
  log: AppLogger,
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
    billingMetrics(telemetry).add('casecellshop.outbox.attempts', 1, {
      'casecellshop.outbox.attempt.outcome': 'closed',
    });
    eventLogger(log, BILLING_LOG_EVENTS).info(
      'casecellshop.outbox.closed',
      {},
      'pedido já tinha desfecho: mensagem apagada da DLQ',
    );
    return 'closed';
  }

  return withPermit(semaphore, () =>
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
    // O correlationId já vai no logContext do runConsumerSpan; repeti-lo aqui duplicaria a chave.
    const log = ctx.logger.child({ orderId: message.orderId });
    try {
      return await settleMessage(ctx, received, message, log);
    } catch (error) {
      // Uma mensagem com problema não impede as outras da rodada; logada aqui, leva correlationId e trace.
      eventLogger(log, BILLING_LOG_EVENTS).warn(
        'casecellshop.outbox.reconciliation.failed',
        { err: error },
        'falha ao reconciliar a mensagem',
      );
      return 'kept';
    }
  });
}

// Devolve a visibilidade (0) do que ficou na DLQ: sem isso a mensagem segue em voo até a
// rodada seguinte, o redrive não a move e, no ElasticMQ, a perde (risco R12).
async function releaseHeld(dlq: Queue, held: Set<string>): Promise<void> {
  for (const handle of held) {
    try {
      // O resultado 'stale' é ignorado: a mensagem já mudou de dono e o laço segue.
      await dlq.changeVisibility(handle, 0);
    } catch {
      // Não esconde o erro original da rodada. Para no primeiro erro: com o SQS fora, cada
      // chamada esperaria o timeout de 5 s e 100 mensagens passariam do prazo de 25 s do
      // encerramento; a visibilidade de 5 min vence sozinha.
      return;
    }
  }
}

async function receiveAndSettle(
  ctx: Context,
  result: ReconcileResult,
  held: Set<string>,
): Promise<void> {
  const { dlq, settings } = ctx;
  // Só o stop() marca 'stopping': uma chamada direta com o reconciliador parado processa tudo.
  while (result.seen < settings.maxMessages && !ctx.isStopping()) {
    const batch = await dlq.receive({
      max: Math.min(MAX_RECEIVE_BATCH, settings.maxMessages - result.seen),
      waitSeconds: 0,
      visibilitySeconds: settings.visibilitySeconds,
    });
    if (batch.length === 0) break;
    result.seen += batch.length;
    // Toda recebida entra aqui; só o que foi apagado sai (as não tratadas pelo stop() ficam).
    for (const received of batch) held.add(received.receiptHandle);
    for (const received of batch) {
      if (ctx.isStopping()) return;
      const parsed = parseBillingMessage(received.body);
      // Corpo fora do schema fica na DLQ para o runbook.
      if (!parsed.valid) continue;
      const outcome = await inSettleSpan(ctx, received, parsed.message);
      if (outcome === 'kept') continue;
      held.delete(received.receiptHandle);
      result[outcome] += 1;
    }
  }
}

async function reconcileOnce(ctx: Context): Promise<ReconcileResult> {
  const result: ReconcileResult = { seen: 0, invoiced: 0, closed: 0 };
  const held = new Set<string>();
  try {
    await receiveAndSettle(ctx, result, held);
  } finally {
    // Só ao fim de receber: dentro da rodada a mensagem voltaria visível e o laço a receberia de novo.
    await releaseHeld(ctx.dlq, held);
  }
  return result;
}

async function round(ctx: Context): Promise<void> {
  try {
    const result = await reconcileOnce(ctx);
    eventLogger(ctx.logger, BILLING_LOG_EVENTS).info(
      'casecellshop.outbox.reconciliation.completed',
      result,
      'rodada de reconciliação concluída',
    );
  } catch (error) {
    eventLogger(ctx.logger, BILLING_LOG_EVENTS).warn(
      'casecellshop.outbox.reconciliation.failed',
      { err: error },
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
    clock,
    async run(isRunning) {
      while (isRunning()) {
        await round(ctx);
        if (!isRunning()) break;
        await runner.pause(settings.intervalMs);
      }
    },
    ...queueGaugeLifecycle(telemetry, dlq, 'dlq', logger),
  });

  return {
    start: () => runner.start(),
    stop: () => runner.stop(),
    reconcileOnce: () => reconcileOnce(ctx),
  };
}
