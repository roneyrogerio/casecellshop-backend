import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { createDb } from '../db/database.ts';
import type { ErpClient } from '../erp/erp-client.ts';
import {
  MAX_RECEIVE_BATCH,
  type Queue,
  type ReceivedMessage,
} from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger } from '../shared/logging.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import { createSemaphore, type Semaphore } from '../shared/semaphore.ts';
import { runConsumerSpan, type Telemetry } from '../shared/telemetry.ts';
import { type AttemptContext, runAttempt } from './attempt.ts';
import { MIN_CALL_DELAY_MS } from './call-permit.ts';
import type { Attempt, CallSettings } from './erp-call.ts';
import { parseBillingMessage } from './message.ts';
import { BILLING_LOG_EVENTS } from './telemetry.ts';

// Parâmetros da tabela do design.md; os testes sobrepõem só o que precisam.
export interface WorkerConfig extends CallSettings {
  erpConcurrency: number;
  // Fila no SQS (AD-021, AD-024).
  visibilitySeconds: number;
  receiveWaitSeconds: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  minDelayMs: MIN_CALL_DELAY_MS,
  erpTimeoutMs: 10_000,
  leaseMarginMs: 2_000,
  backoffBaseMs: 5_000,
  backoffCapMs: 300_000,
  erpConcurrency: 30,
  visibilitySeconds: 60,
  receiveWaitSeconds: 1,
};

export interface WorkerDependencies {
  pool: Pool;
  queue: Queue;
  // Padrão: um novo, com o limite da configuração.
  semaphore?: Semaphore;
  // Porta do ERP (camada anticorrupção).
  erp: ErpClient;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  // Sorteio do jitter; o teste o fixa.
  random?: () => number;
  config?: Partial<WorkerConfig>;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Uma rodada: adquire as permissões livres, recebe até esse número de mensagens, roda as
  // tentativas e resolve com o número de mensagens recebidas, depois de todas terminarem.
  pollOnce(): Promise<number>;
}

// Espera depois de uma rodada que falhou, para o laço não martelar o SQS fora do ar.
const POLL_ERROR_BACKOFF_MS = 500;

interface WorkerContext extends AttemptContext {
  semaphore: Semaphore;
  settings: WorkerConfig;
  isStopping: () => boolean;
}

// Corpo fora do schema: a fila é uma entrada como outra qualquer. Não responde ao SQS, para a
// mensagem voltar e chegar à DLQ pelo limite de recebimentos.
function rejectInvalid(
  logger: Logger,
  received: ReceivedMessage,
  orderId: string | undefined,
): void {
  eventLogger(logger, BILLING_LOG_EVENTS).error(
    'casecellshop.outbox.message.rejected',
    {
      attempt: received.receiveCount,
      ...(orderId === undefined ? {} : { orderId }),
    },
    'corpo da mensagem fora do schema: a mensagem fica sem resposta',
  );
}

function attempt(
  ctx: WorkerContext,
  received: ReceivedMessage,
  receivedAt: number,
): Promise<void> {
  const parsed = parseBillingMessage(received.body);
  if (!parsed.valid) {
    rejectInvalid(ctx.logger, received, parsed.orderId);
    return Promise.resolve();
  }
  const message: Attempt = {
    orderId: parsed.message.orderId,
    correlationId: parsed.message.correlationId,
    traceparent: received.traceparent,
    receiptHandle: received.receiptHandle,
    attempt: received.receiveCount,
    deadline: receivedAt + ctx.settings.visibilitySeconds * 1000,
  };
  // A tentativa continua o trace do checkout e o correlationId dele; o mixin do logger lê os dois do contexto ativo.
  const options = {
    name: 'outbox.attempt',
    traceparent: message.traceparent,
    correlationId: message.correlationId,
    attributes: { orderId: message.orderId, attempt: message.attempt },
  };
  return runConsumerSpan(ctx.telemetry, options, (span) =>
    runAttempt(ctx, message, span),
  );
}

// Recebe até as permissões livres e dispara as tentativas sem esperá-las: `done` resolve quando
// todas terminam. Cada tentativa devolve a sua permissão ao fim.
async function receiveRound(
  ctx: WorkerContext,
): Promise<{ count: number; done: Promise<void> }> {
  const { semaphore, queue, clock, settings } = ctx;
  const permits = await semaphore.acquireFree();
  if (ctx.isStopping()) {
    semaphore.release(permits);
    return { count: 0, done: Promise.resolve() };
  }
  let received: ReceivedMessage[];
  // Lido antes do recebimento: o prazo da mensagem nunca passa do que o SQS concede.
  const receivedAt = clock.now();
  try {
    received = await queue.receive({
      max: Math.min(permits, MAX_RECEIVE_BATCH),
      waitSeconds: settings.receiveWaitSeconds,
      visibilitySeconds: settings.visibilitySeconds,
    });
  } catch (error) {
    semaphore.release(permits);
    throw error;
  }
  semaphore.release(permits - received.length);
  const done = Promise.all(
    received.map((message) =>
      attempt(ctx, message, receivedAt).finally(() => semaphore.release(1)),
    ),
  ).then(() => undefined);
  return { count: received.length, done };
}

// Não espera a rodada: uma chamada lenta não segura a vazão das outras, e o recebimento
// seguinte já espera por uma permissão livre; o long polling faz a espera com a fila vazia.
async function pollLoop(
  ctx: WorkerContext,
  inFlight: Set<Promise<void>>,
  isRunning: () => boolean,
): Promise<void> {
  while (isRunning()) {
    try {
      const round = await receiveRound(ctx);
      inFlight.add(round.done);
      void round.done.finally(() => inFlight.delete(round.done));
    } catch (error) {
      eventLogger(ctx.logger, BILLING_LOG_EVENTS).error(
        'casecellshop.worker.poll.failed',
        { err: error },
        'falha na rodada do worker',
      );
      if (isRunning()) await ctx.clock.sleep(POLL_ERROR_BACKOFF_MS);
    }
  }
}

function announce(
  logger: Logger,
  name: 'casecellshop.worker.started' | 'casecellshop.worker.stopped',
): void {
  const message =
    name === 'casecellshop.worker.started'
      ? 'worker iniciado'
      : 'worker encerrado';
  eventLogger(logger, BILLING_LOG_EVENTS).info(name, {}, message);
}

export function createWorker({
  pool,
  queue,
  erp,
  semaphore,
  logger,
  telemetry,
  clock,
  random = Math.random,
  config,
}: WorkerDependencies): Worker {
  const settings: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
  const ctx: WorkerContext = {
    db: createDb(pool),
    queue,
    erp,
    logger,
    telemetry,
    clock,
    random,
    settings,
    semaphore: semaphore ?? createSemaphore(settings.erpConcurrency),
    isStopping: () => runner.isStopping(),
  };
  const inFlight = new Set<Promise<void>>();

  const runner = createLoopRunner({
    run: (isRunning) => pollLoop(ctx, inFlight, isRunning),
    drain: () => Promise.all(inFlight),
    onStarted: () => announce(logger, 'casecellshop.worker.started'),
    onStopped: () => announce(logger, 'casecellshop.worker.stopped'),
  });

  return {
    start: () => runner.start(),
    stop: () => runner.stop(),
    // Uma rodada completa: resolve depois de todas as tentativas terminarem.
    async pollOnce() {
      const { count, done } = await receiveRound(ctx);
      await done;
      return count;
    },
  };
}
