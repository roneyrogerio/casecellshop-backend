import { type Attributes, defaultTextMapGetter, ROOT_CONTEXT, type Span, SpanKind } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { BillingMessage } from '../contract/billing-message.ts';
import { createDb, TransactionAbortedError } from '../db/database.ts';
import type { ErpClient, ErpOrderItem } from '../erp/erp-client.ts';
import type { HandleResult, Queue, ReceivedMessage } from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';
import { logContext } from '../shared/logging.ts';
import { createSemaphore, type Semaphore } from '../shared/semaphore.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { renewCallPermit, takeCallPermit } from './call-permit.ts';
import { concludeOrder, type OrderConclusion } from './conclude.ts';

// Parâmetros da tabela do design.md; os testes sobrepõem só o que precisam.
export interface WorkerConfig {
  // Contado do início da última chamada (H4 mais a ida da requisição).
  minDelayMs: number;
  erpTimeoutMs: number;
  // Folga sobre o timeout: com menos prazo que timeout + folga, a tentativa desiste.
  leaseMarginMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  erpConcurrency: number;
  // Fila no SQS (AD-021, AD-024).
  visibilitySeconds: number;
  receiveWaitSeconds: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  minDelayMs: 45_000,
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

const MAX_CONCLUSION_TRIES = 5;
// Máximo de mensagens por ReceiveMessage no SQS.
const MAX_RECEIVE_BATCH = 10;
// Espera depois de uma rodada que falhou, para o laço não martelar o SQS fora do ar.
const POLL_ERROR_BACKOFF_MS = 500;
const propagator = new W3CTraceContextPropagator();

// Por que a mensagem volta à fila: o resultado do ERP (ou o erro inesperado) que a causou.
type RetryCause = 'transient' | 'ambiguous' | 'config_error' | 'unexpected';

type Outcome =
  | OrderConclusion
  | { kind: 'retry'; cause: RetryCause; seconds: number }
  // Outra tentativa chamou o ERP há pouco: a mensagem volta quando a permissão puder ser tomada.
  | { kind: 'deferred'; seconds: number };

// Mensagem do SQS já validada, com o prazo dela no relógio injetável.
interface Attempt {
  orderId: string;
  correlationId: string;
  traceparent: string | null;
  receiptHandle: string;
  // ApproximateReceiveCount: é o número da tentativa.
  attempt: number;
  // Recebida em + visibilidade, medido antes do recebimento: nunca passa do prazo real do SQS.
  deadline: number;
}

export function createWorker({ pool, queue, erp, semaphore: injected, logger, telemetry, clock, random = Math.random, config }: WorkerDependencies): Worker {
  const settings: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
  const db = createDb(pool);
  const semaphore = injected ?? createSemaphore(settings.erpConcurrency);
  const erpWindowMs = settings.erpTimeoutMs + settings.leaseMarginMs;
  // Idade máxima da permissão de chamada: depois dela outra tentativa do pedido já pode tomá-la (33 s).
  const maxPermitAgeMs = settings.minDelayMs - erpWindowMs;
  // Um estado só: 'stopping' é o intervalo em que o stop() espera o laço e as tentativas; fora
  // dele, start() e pollOnce() recebem, inclusive depois de um stop().
  let state: 'stopped' | 'running' | 'stopping' = 'stopped';
  let stopped: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  let loop: Promise<void> | undefined;
  // Ordem das chamadas a start() e stop(): um start() que esperava o stop() desiste se outro stop()
  // veio depois dele, para o último a resolver deixar o worker parado.
  let calls = 0;
  let lastStopCall = 0;

  // Full jitter sobre o exponencial com teto, somado ao atraso mínimo, em segundos inteiros para cima.
  function retrySeconds(attempt: number): number {
    const ceiling = Math.min(settings.backoffCapMs, settings.backoffBaseMs * 2 ** (attempt - 1));
    return Math.ceil((settings.minDelayMs + random() * ceiling) / 1000);
  }

  // Desiste antes de chamar quando o prazo da mensagem ou a idade da permissão não cobrem a chamada.
  function tooLate(message: Attempt, permitReadAt?: number): boolean {
    const now = clock.now();
    return message.deadline - now < erpWindowMs || (permitReadAt !== undefined && now - permitReadAt > maxPermitAgeMs);
  }

  async function loadItems(orderId: string): Promise<ErpOrderItem[]> {
    // Itens com o preço aceito no checkout (H3).
    const rows = await db.selectFrom('order_items').select(['sku', 'quantity', 'unit_price_cents']).where('order_id', '=', orderId).orderBy('sku').execute();
    return rows.map((row) => ({ sku: row.sku, quantity: row.quantity, unitPriceCents: row.unit_price_cents }));
  }

  // Devolve undefined quando a tentativa desiste sem responder ao SQS (prazo ou permissão curtos demais).
  async function callErp(message: Attempt, log: Logger): Promise<Outcome | undefined> {
    const retry = (cause: RetryCause): Outcome => ({ kind: 'retry', cause, seconds: retrySeconds(message.attempt) });
    const configError = (status: number) => {
      log.warn({ event: 'erp.config_error', status }, 'erro de configuração no ERP');
      return retry('config_error');
    };
    const giveUp = () => {
      log.warn({ event: 'outbox.lease_short' }, 'prazo curto demais para a chamada: a mensagem volta quando a visibilidade vencer');
      return undefined;
    };

    // Os itens vêm antes da permissão: nenhuma consulta ao banco pode ficar entre a última
    // conferência de prazo e a chamada ao ERP.
    const items = await loadItems(message.orderId);
    if (tooLate(message)) return giveUp();
    // Lido antes do UPDATE: a idade medida nunca fica abaixo da real, que conta do now() do banco.
    let permitReadAt = clock.now();
    const permit = await takeCallPermit(db, message.orderId, { minDelayMs: settings.minDelayMs, clearDead: true });
    if (!permit.granted) return { kind: 'deferred', seconds: Math.ceil(permit.retryInMs / 1000) + 1 };

    // Conferência imediata antes de cada chamada ao ERP, a primeira e a que vem depois da renovação.
    if (tooLate(message, permitReadAt)) return giveUp();
    if (permit.sentBefore) {
      // Já pode ter chegado ao ERP: só um "não existe" explícito autoriza criar de novo.
      const found = await erp.findOrderByReference(message.orderId);
      if (found.kind === 'found') return { kind: 'invoiced' };
      if (found.kind === 'config_error') return configError(found.status);
      if (found.kind !== 'not_found') return retry('transient');

      // A consulta pode ter sido lenta: confere de novo e regrava o início da chamada para a criação.
      if (tooLate(message, permitReadAt)) return giveUp();
      permitReadAt = clock.now();
      if (!(await renewCallPermit(db, message.orderId, permit.token))) return giveUp();
    }

    if (tooLate(message, permitReadAt)) return giveUp();
    const created = await erp.createOrder({ reference: message.orderId, items });
    if (created.kind === 'ok') return { kind: 'invoiced' };
    if (created.kind === 'permanent') return { kind: 'failed', reason: created.reason === 'rejected' ? 'erp_rejected' : 'erp_out_of_stock' };
    if (created.kind === 'config_error') return configError(created.status);
    return retry(created.kind);
  }

  // Falha do SQS não rejeita: a mensagem volta quando a visibilidade vencer, e o banco já protege o pedido.
  async function respond(action: () => Promise<HandleResult>, log: Logger): Promise<HandleResult | 'error'> {
    try {
      const result = await action();
      if (result === 'stale') {
        telemetry.outboxConclusionNoRow.add(1);
        log.warn({ event: 'outbox.conclusion_no_row' }, 'o SQS recusou o receipt handle: outro recebimento já tem a mensagem');
      }
      return result;
    } catch (error) {
      log.warn({ event: 'outbox.queue_error', err: error }, 'falha do SQS ao responder à mensagem');
      return 'error';
    }
  }

  // Encerra a mensagem de um pedido que já tinha desfecho.
  async function close(message: Attempt, log: Logger): Promise<void> {
    // Só conta quando o SQS apagou: com o handle antigo (stale), outro recebimento é quem encerra.
    const result = await respond(() => queue.delete(message.receiptHandle), log);
    if (result !== 'ok') return;
    telemetry.outboxAttemptOutcome.add(1, { outcome: 'closed' });
    log.info({ event: 'outbox.closed' }, 'pedido já tinha desfecho: mensagem encerrada');
  }

  // Grava o desfecho no banco; undefined quando desiste (prazo vencido ou repetições esgotadas).
  async function concludeInDb(message: Attempt, conclusion: OrderConclusion, log: Logger) {
    // O teto impede que um erro rápido e persistente vire um laço contra o banco.
    for (let tries = 1; tries <= MAX_CONCLUSION_TRIES; tries += 1) {
      try {
        return await concludeOrder(db, message.orderId, conclusion);
      } catch (error) {
        if (error instanceof TransactionAbortedError) {
          log.error({ event: 'db.transaction_aborted', err: error }, 'a transação de conclusão abortou antes do COMMIT');
        } else {
          log.warn({ event: 'outbox.conclusion_failed', err: error }, 'falha ao gravar o desfecho');
        }
        // Repete enquanto o prazo da mensagem vale; depois ela volta pela visibilidade.
        if (clock.now() >= message.deadline) return undefined;
      }
    }
    return undefined;
  }

  // Primeiro o banco, depois o SQS.
  async function finish(message: Attempt, outcome: Outcome, log: Logger): Promise<void> {
    if (outcome.kind === 'retry' || outcome.kind === 'deferred') {
      const result = await respond(() => queue.changeVisibility(message.receiptHandle, outcome.seconds), log);
      // Só conta e loga quando a visibilidade de fato mudou.
      if (result !== 'ok') return;
      telemetry.outboxAttemptOutcome.add(1, { outcome: outcome.kind });
      if (outcome.kind === 'retry') log.warn({ event: 'outbox.retry', outcome: outcome.cause }, 'a mensagem volta à fila');
      else log.info({ event: 'outbox.call_deferred' }, 'outra tentativa chamou o ERP há pouco: a mensagem volta quando o atraso mínimo passar');
      return;
    }

    const result = await concludeInDb(message, outcome, log);
    if (!result) return;
    // Faturado ou falho só conta se esta transação mudou o pedido; senão a mensagem foi só encerrada.
    if (!result.orderChanged) {
      await close(message, log);
      return;
    }
    telemetry.outboxAttemptOutcome.add(1, { outcome: outcome.kind });
    if (outcome.kind === 'invoiced') {
      log.info({ event: 'order.invoiced' }, 'pedido faturado');
      if (result.acceptToOutcomeSeconds !== undefined) telemetry.orderAcceptToInvoice.record(result.acceptToOutcomeSeconds);
    } else {
      log.warn({ event: 'order.failed', reason: outcome.reason }, 'pedido falhou no ERP');
    }
    await respond(() => queue.delete(message.receiptHandle), log);
  }

  // Nunca rejeita: o erro de uma tentativa não pode interromper as outras da rodada.
  async function runAttempt(message: Attempt, span: Span): Promise<void> {
    const log = logger.child({ orderId: message.orderId, attempt: message.attempt });
    let outcome: Outcome | undefined;
    try {
      const order = await db.selectFrom('orders').select('status').where('id', '=', message.orderId).executeTakeFirstOrThrow();
      // Não gasta chamada com pedido que já tem desfecho; roda no span de encerramento, que não é uma tentativa.
      if (order.status !== 'pending') {
        span.updateName('outbox.settle');
        span.setAttribute('outcome', 'closed');
        await close(message, log);
        return;
      }
      outcome = await callErp(message, log);
      if (!outcome) {
        telemetry.outboxAttemptOutcome.add(1, { outcome: 'lease_short' });
        return;
      }
    } catch (error) {
      log.error({ event: 'outbox.attempt_error', err: error }, 'erro inesperado na tentativa');
      outcome = { kind: 'retry', cause: 'unexpected', seconds: retrySeconds(message.attempt) };
    }
    try {
      await finish(message, outcome, log);
    } catch (error) {
      log.error({ event: 'outbox.attempt_error', err: error }, 'erro inesperado ao concluir');
    }
  }

  // A tentativa continua o trace do checkout (traceparent da mensagem) e o correlationId dele; sem
  // traceparent, o span é raiz. O mixin do logger lê os dois do contexto ativo.
  function inSpan(name: string, message: Pick<Attempt, 'orderId' | 'attempt' | 'correlationId' | 'traceparent'>, fn: (span: Span) => Promise<void>, extra: Attributes = {}): Promise<void> {
    const parent = propagator.extract(ROOT_CONTEXT, message.traceparent ? { traceparent: message.traceparent } : {}, defaultTextMapGetter);
    return logContext.run({ correlationId: message.correlationId }, () =>
      telemetry.tracer.startActiveSpan(
        name,
        { kind: SpanKind.CONSUMER, attributes: { orderId: message.orderId, attempt: message.attempt, ...extra } },
        parent,
        async (span) => {
          try {
            await fn(span);
          } finally {
            span.end();
          }
        },
      ),
    );
  }

  // Corpo fora do schema: a fila é uma entrada como outra qualquer. Não responde ao SQS, para a
  // mensagem voltar e chegar à DLQ pelo limite de recebimentos.
  function rejectInvalid(received: ReceivedMessage): void {
    let orderId: unknown;
    try {
      orderId = (JSON.parse(received.body) as { orderId?: unknown } | null)?.orderId;
    } catch {
      orderId = undefined;
    }
    logger.error(
      { event: 'outbox.invalid_message', attempt: received.receiveCount, ...(typeof orderId === 'string' ? { orderId } : {}) },
      'corpo da mensagem fora do schema: a mensagem fica sem resposta',
    );
  }

  function attempt(received: ReceivedMessage, receivedAt: number): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(received.body);
    } catch {
      body = undefined;
    }
    const parsed = BillingMessage.safeParse(body);
    if (!parsed.success) {
      rejectInvalid(received);
      return Promise.resolve();
    }
    const message: Attempt = {
      orderId: parsed.data.orderId,
      correlationId: parsed.data.correlationId,
      traceparent: received.traceparent,
      receiptHandle: received.receiptHandle,
      attempt: received.receiveCount,
      deadline: receivedAt + settings.visibilitySeconds * 1000,
    };
    return inSpan('outbox.attempt', message, (span) => runAttempt(message, span));
  }

  // Recebe até as permissões livres e dispara as tentativas sem esperá-las: `done` resolve quando
  // todas terminam. Cada tentativa devolve a sua permissão ao fim.
  async function receiveRound(): Promise<{ count: number; done: Promise<void> }> {
    const permits = await semaphore.acquireFree();
    if (state === 'stopping') {
      semaphore.release(permits);
      return { count: 0, done: Promise.resolve() };
    }
    let received: ReceivedMessage[];
    // Lido antes do recebimento: o prazo da mensagem nunca passa do que o SQS concede.
    const receivedAt = clock.now();
    try {
      received = await queue.receive({ max: Math.min(permits, MAX_RECEIVE_BATCH), waitSeconds: settings.receiveWaitSeconds, visibilitySeconds: settings.visibilitySeconds });
    } catch (error) {
      semaphore.release(permits);
      throw error;
    }
    semaphore.release(permits - received.length);
    const done = Promise.all(received.map((message) => attempt(message, receivedAt).finally(() => semaphore.release(1)))).then(() => undefined);
    return { count: received.length, done };
  }

  // Uma rodada completa: resolve depois de todas as tentativas terminarem.
  async function pollOnce(): Promise<number> {
    const { count, done } = await receiveRound();
    await done;
    return count;
  }

  // Não espera a rodada: uma chamada lenta não segura a vazão das outras, e o recebimento
  // seguinte já espera por uma permissão livre; o long polling faz a espera com a fila vazia.
  async function run(): Promise<void> {
    while (state === 'running') {
      try {
        const round = await receiveRound();
        inFlight.add(round.done);
        void round.done.finally(() => inFlight.delete(round.done));
      } catch (error) {
        logger.error({ event: 'worker.poll_error', err: error }, 'falha na rodada do worker');
        if (state === 'running') await clock.sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  }

  return {
    async start() {
      calls += 1;
      const mine = calls;
      // Um start() durante o stop() espera o encerramento e então reinicia, a não ser que outro stop() tenha vindo depois dele.
      while (state === 'stopping') await stopped;
      if (state === 'stopped' && lastStopCall < mine) {
        state = 'running';
        loop = run();
        logger.info({ event: 'worker_started' }, 'worker iniciado');
      }
    },
    // Sem `async`: devolve a própria promessa do encerramento, para quem espera nela ver o stop() antes do start().
    stop() {
      calls += 1;
      lastStopCall = calls;
      if (state === 'stopping' && stopped) return stopped;
      if (state !== 'running') return Promise.resolve();
      state = 'stopping';
      stopped = (async () => {
        try {
          // Para de receber e espera as tentativas em andamento; o prazo é do lifecycle.
          await loop;
          await Promise.all(inFlight);
        } finally {
          state = 'stopped';
        }
        logger.info({ event: 'worker_stopped' }, 'worker encerrado');
      })();
      return stopped;
    },
    pollOnce,
  };
}
