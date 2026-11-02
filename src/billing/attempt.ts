import type { Span } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { TransactionAbortedError } from '../db/database.ts';
import { DB_LOG_EVENTS } from '../db/telemetry.ts';
import type { HandleResult, Queue } from '../queue/sqs.ts';
import { eventLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { concludeOrder, type OrderConclusion } from './conclude.ts';
import { BILLING_LOG_EVENTS, billingMetrics } from './telemetry.ts';
import {
  type Attempt,
  callErp,
  type CallContext,
  type Outcome,
  retrySeconds,
} from './erp-call.ts';

// Uma tentativa do worker, da leitura do pedido ao desfecho: o banco primeiro, o SQS depois
// (design.md, "Worker: envio").

export interface AttemptContext extends CallContext {
  queue: Queue;
  logger: Logger;
  telemetry: Telemetry;
}

const MAX_CONCLUSION_TRIES = 5;

type RetryOutcome = Extract<Outcome, { kind: 'retry' | 'deferred' }>;

// Falha do SQS não rejeita: a mensagem volta quando a visibilidade vencer, e o banco já protege o pedido.
async function respond(
  { telemetry }: AttemptContext,
  action: () => Promise<HandleResult>,
  log: Logger,
): Promise<HandleResult | 'error'> {
  try {
    const result = await action();
    if (result === 'stale') {
      billingMetrics(telemetry).add(
        'casecellshop.outbox.orphan_conclusions',
        1,
      );
      eventLogger(log, BILLING_LOG_EVENTS).warn(
        'casecellshop.outbox.conclusion.orphaned',
        {},
        'o SQS recusou o receipt handle: outro recebimento já tem a mensagem',
      );
    }
    return result;
  } catch (error) {
    eventLogger(log, BILLING_LOG_EVENTS).warn(
      'casecellshop.outbox.queue.failed',
      { err: error },
      'falha do SQS ao responder à mensagem',
    );
    return 'error';
  }
}

// Encerra a mensagem de um pedido que já tinha desfecho.
async function close(
  ctx: AttemptContext,
  message: Attempt,
  log: Logger,
): Promise<void> {
  // Só conta quando o SQS apagou: com o handle antigo (stale), outro recebimento é quem encerra.
  const result = await respond(
    ctx,
    () => ctx.queue.delete(message.receiptHandle),
    log,
  );
  if (result !== 'ok') return;
  billingMetrics(ctx.telemetry).add('casecellshop.outbox.attempts', 1, {
    'casecellshop.outbox.attempt.outcome': 'closed',
  });
  eventLogger(log, BILLING_LOG_EVENTS).info(
    'casecellshop.outbox.closed',
    {},
    'pedido já tinha desfecho: mensagem encerrada',
  );
}

// Grava o desfecho no banco; undefined quando desiste (prazo vencido ou repetições esgotadas).
async function concludeInDb(
  { db, clock }: AttemptContext,
  message: Attempt,
  conclusion: OrderConclusion,
  log: Logger,
) {
  // O teto impede que um erro rápido e persistente vire um laço contra o banco.
  for (let tries = 1; tries <= MAX_CONCLUSION_TRIES; tries += 1) {
    try {
      return await concludeOrder(db, message.orderId, conclusion);
    } catch (error) {
      if (error instanceof TransactionAbortedError) {
        eventLogger(log, DB_LOG_EVENTS).error(
          'casecellshop.db.transaction.aborted',
          { err: error },
          'a transação de conclusão abortou antes do COMMIT',
        );
      } else {
        eventLogger(log, BILLING_LOG_EVENTS).warn(
          'casecellshop.outbox.conclusion.failed',
          { err: error },
          'falha ao gravar o desfecho',
        );
      }
      // Repete enquanto o prazo da mensagem vale; depois ela volta pela visibilidade.
      if (clock.now() >= message.deadline) return undefined;
    }
  }
  return undefined;
}

async function finishRetry(
  ctx: AttemptContext,
  message: Attempt,
  outcome: RetryOutcome,
  log: Logger,
): Promise<void> {
  const result = await respond(
    ctx,
    () => ctx.queue.changeVisibility(message.receiptHandle, outcome.seconds),
    log,
  );
  // Só conta e loga quando a visibilidade de fato mudou.
  if (result !== 'ok') return;
  billingMetrics(ctx.telemetry).add('casecellshop.outbox.attempts', 1, {
    'casecellshop.outbox.attempt.outcome': outcome.kind,
  });
  if (outcome.kind === 'retry')
    eventLogger(log, BILLING_LOG_EVENTS).warn(
      'casecellshop.outbox.retry.scheduled',
      { cause: outcome.cause },
      'a mensagem volta à fila',
    );
  else
    eventLogger(log, BILLING_LOG_EVENTS).info(
      'casecellshop.outbox.call.deferred',
      {},
      'outra tentativa chamou o ERP há pouco: a mensagem volta quando o atraso mínimo passar',
    );
}

async function finishConclusion(
  ctx: AttemptContext,
  message: Attempt,
  outcome: OrderConclusion,
  log: Logger,
): Promise<void> {
  const result = await concludeInDb(ctx, message, outcome, log);
  if (!result) return;
  // Faturado ou falho só conta se esta transação mudou o pedido; senão a mensagem foi só encerrada.
  if (!result.orderChanged) {
    await close(ctx, message, log);
    return;
  }
  const metrics = billingMetrics(ctx.telemetry);
  metrics.add('casecellshop.outbox.attempts', 1, {
    'casecellshop.outbox.attempt.outcome': outcome.kind,
  });
  if (outcome.kind === 'invoiced') {
    eventLogger(log, BILLING_LOG_EVENTS).info(
      'casecellshop.order.invoiced',
      {},
      'pedido faturado',
    );
    if (result.acceptToOutcomeSeconds !== undefined)
      metrics.record(
        'casecellshop.order.accept_to_invoice.duration',
        result.acceptToOutcomeSeconds,
      );
  } else {
    eventLogger(log, BILLING_LOG_EVENTS).warn(
      'casecellshop.order.failed',
      { reason: outcome.reason },
      'pedido falhou no ERP',
    );
  }
  await respond(ctx, () => ctx.queue.delete(message.receiptHandle), log);
}

// Primeiro o banco, depois o SQS.
function finish(
  ctx: AttemptContext,
  message: Attempt,
  outcome: Outcome,
  log: Logger,
): Promise<void> {
  if (outcome.kind === 'retry' || outcome.kind === 'deferred')
    return finishRetry(ctx, message, outcome, log);
  return finishConclusion(ctx, message, outcome, log);
}

function logAttemptFailed(log: Logger, error: unknown, message: string): void {
  eventLogger(log, BILLING_LOG_EVENTS).error(
    'casecellshop.outbox.attempt.failed',
    { err: error },
    message,
  );
}

// Nunca rejeita: o erro de uma tentativa não pode interromper as outras da rodada.
export async function runAttempt(
  ctx: AttemptContext,
  message: Attempt,
  span: Span,
): Promise<void> {
  const log = ctx.logger.child({
    orderId: message.orderId,
    attempt: message.attempt,
  });
  let outcome: Outcome | undefined;
  try {
    const order = await ctx.db
      .selectFrom('orders')
      .select('status')
      .where('id', '=', message.orderId)
      .executeTakeFirstOrThrow();
    // Não gasta chamada com pedido que já tem desfecho; roda no span de encerramento, que não é uma tentativa.
    if (order.status !== 'pending') {
      span.updateName('outbox.settle');
      span.setAttribute('outcome', 'closed');
      await close(ctx, message, log);
      return;
    }
    outcome = await callErp(ctx, message, log);
    if (!outcome) {
      billingMetrics(ctx.telemetry).add('casecellshop.outbox.attempts', 1, {
        'casecellshop.outbox.attempt.outcome': 'lease_short',
      });
      return;
    }
  } catch (error) {
    logAttemptFailed(log, error, 'erro inesperado na tentativa');
    outcome = {
      kind: 'retry',
      cause: 'unexpected',
      seconds: retrySeconds(ctx, message.attempt),
    };
  }
  try {
    await finish(ctx, message, outcome, log);
  } catch (error) {
    logAttemptFailed(log, error, 'erro inesperado ao concluir');
  }
}
