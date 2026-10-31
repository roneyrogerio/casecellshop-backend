import { defaultTextMapGetter, ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { sql } from 'kysely';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import { BillingMessage } from './contract/billing-message.ts';
import { createDb } from './db/database.ts';
import type { ErpClient } from './erp/erp-client.ts';
import { logContext } from './logging.ts';
import { takeCallPermit } from './outbox/call-permit.ts';
import { concludeOrder } from './outbox/conclude.ts';
import type { Semaphore } from './outbox/semaphore.ts';
import type { Queue, ReceivedMessage } from './queue/sqs.ts';
import type { Telemetry } from './telemetry.ts';

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
  minDelayMs: 45_000,
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

// Máximo de mensagens por ReceiveMessage no SQS.
const MAX_RECEIVE_BATCH = 10;
const propagator = new W3CTraceContextPropagator();

export function createReconciler({ pool, dlq, erp, semaphore, logger, telemetry, clock, config }: ReconcilerDependencies): Reconciler {
  const settings: ReconcilerConfig = { ...DEFAULT_RECONCILER_CONFIG, ...config };
  const db = createDb(pool);
  let state: 'stopped' | 'running' | 'stopping' = 'stopped';
  let loop: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  // Uma consulta ao ERP por vez, sob uma permissão do semáforo: o limite vale para todo o processo.
  async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    const permits = await semaphore.acquireFree();
    semaphore.release(permits - 1);
    try {
      return await fn();
    } finally {
      semaphore.release(1);
    }
  }

  // Devolve o que a mensagem acrescenta ao resultado da rodada.
  async function settleMessage(received: ReceivedMessage, message: BillingMessage, log: Logger): Promise<'invoiced' | 'closed' | 'kept'> {
    // O dead_at marca a chegada à DLQ uma vez; a permissão de chamada do worker o zera.
    const marked = await db.updateTable('outbox').set({ dead_at: sql<Date>`now()` }).where('order_id', '=', message.orderId).where('dead_at', 'is', null).returning('order_id').executeTakeFirst();
    if (marked) {
      log.error({ event: 'outbox.dead' }, 'a mensagem chegou à DLQ: o pedido segue pendente com a reserva');
      telemetry.outboxAttemptOutcome.add(1, { outcome: 'dead' });
    }

    const order = await db.selectFrom('orders').select('status').where('id', '=', message.orderId).executeTakeFirst();
    if (!order) return 'kept';
    if (order.status !== 'pending') {
      if ((await dlq.delete(received.receiptHandle)) !== 'ok') return 'kept';
      telemetry.outboxAttemptOutcome.add(1, { outcome: 'closed' });
      log.info({ event: 'outbox.closed' }, 'pedido já tinha desfecho: mensagem apagada da DLQ');
      return 'closed';
    }

    return withSemaphore(async () => {
      // Sem a permissão (outra chamada há menos que o atraso mínimo), a mensagem fica para o runbook.
      const permit = await takeCallPermit(db, message.orderId, { minDelayMs: settings.minDelayMs, clearDead: false });
      if (!permit.granted) return 'kept';
      const found = await erp.findOrderByReference(message.orderId);
      if (found.kind !== 'found') return 'kept';

      const result = await concludeOrder(db, message.orderId, { kind: 'invoiced' });
      if (result.orderChanged) {
        telemetry.outboxAttemptOutcome.add(1, { outcome: 'invoiced' });
        log.info({ event: 'order.invoiced' }, 'pedido faturado pela reconciliação');
        if (result.acceptToOutcomeSeconds !== undefined) telemetry.orderAcceptToInvoice.record(result.acceptToOutcomeSeconds);
      }
      await dlq.delete(received.receiptHandle);
      return 'invoiced';
    });
  }

  // Dentro do span de encerramento, no trace do checkout e com o correlationId dele nos logs.
  function inSettleSpan(received: ReceivedMessage, message: BillingMessage): Promise<'invoiced' | 'closed' | 'kept'> {
    const parent = propagator.extract(ROOT_CONTEXT, received.traceparent ? { traceparent: received.traceparent } : {}, defaultTextMapGetter);
    return logContext.run({ correlationId: message.correlationId }, () =>
      telemetry.tracer.startActiveSpan('outbox.settle', { kind: SpanKind.CONSUMER, attributes: { orderId: message.orderId } }, parent, async (span) => {
        try {
          return await settleMessage(received, message, logger.child({ orderId: message.orderId, correlationId: message.correlationId }));
        } finally {
          span.end();
        }
      }),
    );
  }

  async function reconcileOnce(): Promise<ReconcileResult> {
    const result: ReconcileResult = { seen: 0, invoiced: 0, closed: 0 };
    while (result.seen < settings.maxMessages) {
      const batch = await dlq.receive({
        max: Math.min(MAX_RECEIVE_BATCH, settings.maxMessages - result.seen),
        waitSeconds: 0,
        visibilitySeconds: settings.visibilitySeconds,
      });
      if (batch.length === 0) break;
      result.seen += batch.length;
      for (const received of batch) {
        let body: unknown;
        try {
          body = JSON.parse(received.body);
        } catch {
          body = undefined;
        }
        const parsed = BillingMessage.safeParse(body);
        // Corpo fora do schema fica na DLQ para o runbook.
        if (!parsed.success) continue;
        try {
          const outcome = await inSettleSpan(received, parsed.data);
          if (outcome !== 'kept') result[outcome] += 1;
        } catch (error) {
          // Uma mensagem com problema não impede as outras da rodada.
          logger.warn({ event: 'outbox.reconcile_error', orderId: parsed.data.orderId, err: error }, 'falha ao reconciliar a mensagem');
        }
      }
    }
    return result;
  }

  async function round(): Promise<void> {
    try {
      const result = await reconcileOnce();
      logger.info({ event: 'outbox.reconciled', ...result }, 'rodada de reconciliação concluída');
    } catch (error) {
      logger.warn({ event: 'outbox.reconcile_error', err: error }, 'falha na rodada de reconciliação');
    }
  }

  async function run(): Promise<void> {
    while (state === 'running') {
      await round();
      if (state !== 'running') break;
      // O stop() acorda a espera: sem isso, o encerramento aguardaria o intervalo inteiro (5 min).
      await Promise.race([clock.sleep(settings.intervalMs), new Promise<void>((resolve) => (wake = resolve))]);
    }
  }

  return {
    async start() {
      while (state === 'stopping') await stopped;
      if (state !== 'stopped') return;
      state = 'running';
      loop = run();
    },
    stop() {
      if (state === 'stopping' && stopped) return stopped;
      if (state !== 'running') return Promise.resolve();
      state = 'stopping';
      wake?.();
      stopped = (async () => {
        try {
          await loop;
        } finally {
          state = 'stopped';
        }
      })();
      return stopped;
    },
    reconcileOnce,
  };
}
