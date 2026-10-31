import { type Attributes, defaultTextMapGetter, ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { sql } from 'kysely';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import { createDb, TransactionAbortedError } from './db/database.ts';
import { logContext } from './logging.ts';
import type { ErpClient } from './erp/erp-client.ts';
import { type ClaimedMessage, type ClaimSettled, claimMessages, intervalOf } from './outbox/claim.ts';
import { type Conclusion, concludeMessage, holdsLease } from './outbox/conclude.ts';
import { createSemaphore } from './outbox/semaphore.ts';
import type { Telemetry } from './telemetry.ts';

// Parâmetros da tabela do design.md; os testes sobrepõem só o que precisam.
export interface WorkerConfig {
  leaseMs: number;
  // Contado do início da última chamada (H4 mais a ida da requisição).
  minDelayMs: number;
  erpTimeoutMs: number;
  // Folga sobre o timeout: com menos lease que timeout + folga, a tentativa desiste.
  leaseMarginMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  pollIntervalMs: number;
  erpConcurrency: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  leaseMs: 30_000,
  minDelayMs: 45_000,
  erpTimeoutMs: 10_000,
  leaseMarginMs: 2_000,
  maxAttempts: 12,
  backoffBaseMs: 5_000,
  backoffCapMs: 300_000,
  pollIntervalMs: 500,
  erpConcurrency: 30,
};

export interface WorkerDependencies {
  pool: Pool;
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
  // Uma rodada: reivindica até as permissões livres do semáforo, roda as tentativas
  // e resolve com o número de mensagens reivindicadas, depois de todas terminarem.
  pollOnce(): Promise<number>;
}

const MAX_CONCLUSION_TRIES = 5;
const propagator = new W3CTraceContextPropagator();

// Por que a mensagem volta à fila: o resultado do ERP (ou o erro inesperado) que a causou.
type RetryCause = 'transient' | 'ambiguous' | 'config_error' | 'unexpected';

export function createWorker({ pool, erp, logger, telemetry, clock, random = Math.random, config }: WorkerDependencies): Worker {
  const settings: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
  const db = createDb(pool);
  const semaphore = createSemaphore(settings.erpConcurrency);
  // Um estado só: 'stopping' é o intervalo em que o stop() espera o laço e as tentativas; fora
  // dele, start() e pollOnce() reivindicam, inclusive depois de um stop().
  let state: 'stopped' | 'running' | 'stopping' = 'stopped';
  let stopped: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  let loop: Promise<void> | undefined;

  // Esgotadas as tentativas, a mensagem vai para a DLQ; senão volta depois do atraso mínimo mais jitter.
  function retryOrDead(message: ClaimedMessage): Conclusion {
    if (message.attempts >= settings.maxAttempts) return { kind: 'dead' };
    const ceiling = Math.min(settings.backoffCapMs, settings.backoffBaseMs * 2 ** (message.attempts - 1));
    return { kind: 'retry', delayMs: settings.minDelayMs + random() * ceiling };
  }

  // Grava last_call_at e confere o lease num UPDATE só, pelo relógio do banco.
  async function markCall(message: ClaimedMessage): Promise<boolean> {
    const updated = await db
      .updateTable('outbox')
      .set({ last_call_at: sql<Date>`now()` })
      .where('order_id', '=', message.orderId)
      .where('claim_token', '=', message.token)
      .where('lease_until', '>', sql<Date>`now() + ${intervalOf(settings.erpTimeoutMs + settings.leaseMarginMs)}`)
      .executeTakeFirst();
    return updated.numUpdatedRows > 0n;
  }

  // Devolve undefined quando o lease é curto demais para uma das chamadas: desiste sem concluir.
  async function callErp(message: ClaimedMessage, log: Logger): Promise<Conclusion | undefined> {
    const retry = (cause: RetryCause): Conclusion => {
      const conclusion = retryOrDead(message);
      // Só registra o retry quando a mensagem de fato volta à fila.
      if (conclusion.kind === 'retry') log.warn({ event: 'outbox.retry', outcome: cause }, 'a mensagem volta à fila');
      return conclusion;
    };
    const configError = (status: number) => {
      log.warn({ event: 'erp.config_error', status }, 'erro de configuração no ERP');
      return retry('config_error');
    };
    // Antes de cada chamada: uma consulta lenta não pode deixar o last_call_at da criação velho
    // nem a criação sair com o lease já curto.
    const leaseShort = async (): Promise<boolean> => {
      if (await markCall(message)) return false;
      log.warn({ event: 'outbox.lease_short' }, 'lease curto demais para a chamada: a mensagem volta quando vencer');
      return true;
    };

    if (message.sentBefore) {
      if (await leaseShort()) return undefined;
      // Já pode ter chegado ao ERP: só um "não existe" explícito autoriza criar de novo.
      const found = await erp.findOrderByReference(message.orderId);
      if (found.kind === 'found') return { kind: 'invoiced' };
      if (found.kind === 'config_error') return configError(found.status);
      if (found.kind !== 'not_found') return retry('transient');
    }

    if (await leaseShort()) return undefined;
    const created = await erp.createOrder({ reference: message.orderId, items: message.items });
    if (created.kind === 'ok') return { kind: 'invoiced' };
    if (created.kind === 'permanent') return { kind: 'failed', reason: created.reason === 'rejected' ? 'erp_rejected' : 'erp_out_of_stock' };
    if (created.kind === 'config_error') return configError(created.status);
    return retry(created.kind);
  }

  async function finish(message: ClaimedMessage, conclusion: Conclusion, log: Logger): Promise<void> {
    // O teto impede que um erro rápido e persistente vire um laço contra o banco.
    for (let tries = 1; tries <= MAX_CONCLUSION_TRIES; tries += 1) {
      try {
        const result = await concludeMessage(db, message.orderId, message.token, conclusion);
        if (!result.applied) {
          telemetry.outboxConclusionNoRow.add(1);
          log.warn({ event: 'outbox.conclusion_no_row' }, 'o token já não vale: a conclusão não mudou nada');
          return;
        }
        // Faturado ou falho só conta se esta transação mudou o pedido; senão a mensagem foi só encerrada.
        if ((conclusion.kind === 'invoiced' || conclusion.kind === 'failed') && !result.orderChanged) {
          telemetry.outboxAttemptOutcome.add(1, { outcome: 'closed' });
          log.info({ event: 'outbox.closed' }, 'pedido já tinha desfecho: mensagem encerrada');
          return;
        }
        telemetry.outboxAttemptOutcome.add(1, { outcome: conclusion.kind });
        if (conclusion.kind === 'invoiced') {
          log.info({ event: 'order.invoiced' }, 'pedido faturado');
          if (result.acceptToOutcomeSeconds !== undefined) telemetry.orderAcceptToInvoice.record(result.acceptToOutcomeSeconds);
        } else if (conclusion.kind === 'failed') {
          log.warn({ event: 'order.failed', reason: conclusion.reason }, 'pedido falhou no ERP');
        } else if (conclusion.kind === 'dead') {
          log.error({ event: 'outbox.dead' }, 'mensagem na DLQ');
        }
        return;
      } catch (error) {
        if (error instanceof TransactionAbortedError) {
          log.error({ event: 'db.transaction_aborted', err: error }, 'a transação de conclusão abortou antes do COMMIT');
        } else {
          log.warn({ event: 'outbox.conclusion_failed', err: error }, 'falha ao gravar o desfecho');
        }
        // Repete enquanto o lease vale; depois a mensagem volta pela reivindicação. Se nem a
        // conferência responde, desiste pelo mesmo caminho.
        const valid = await holdsLease(db, message.orderId, message.token).catch(() => false);
        if (!valid) return;
      }
    }
  }

  // Nunca rejeita: o erro de uma tentativa não pode interromper as outras da rodada.
  async function runAttempt(message: ClaimedMessage): Promise<void> {
    const log = logger.child({ orderId: message.orderId, attempt: message.attempts });
    let conclusion: Conclusion | undefined;
    try {
      conclusion = await callErp(message, log);
      if (!conclusion) {
        telemetry.outboxAttemptOutcome.add(1, { outcome: 'lease_short' });
        return;
      }
    } catch (error) {
      log.error({ event: 'outbox.attempt_error', err: error }, 'erro inesperado na tentativa');
      conclusion = retryOrDead(message);
    }
    try {
      await finish(message, conclusion, log);
    } catch (error) {
      log.error({ event: 'outbox.attempt_error', err: error }, 'erro inesperado ao concluir');
    }
  }

  // A tentativa continua o trace do checkout (traceparent da outbox) e o correlationId dele; sem
  // traceparent, o span é raiz. O mixin do logger lê os dois do contexto ativo.
  // Os eventos que a reivindicação decide (closed, dead) rodam num span `outbox.settle`, que não é uma tentativa.
  function inSpan(name: string, message: ClaimSettled, fn: () => Promise<void> | void, extra: Attributes = {}): Promise<void> {
    const parent = propagator.extract(ROOT_CONTEXT, message.traceparent ? { traceparent: message.traceparent } : {}, defaultTextMapGetter);
    return logContext.run({ correlationId: message.correlationId }, () =>
      telemetry.tracer.startActiveSpan(
        name,
        { kind: SpanKind.CONSUMER, attributes: { orderId: message.orderId, attempt: message.attempts, ...extra } },
        parent,
        async (span) => {
          try {
            await fn();
          } finally {
            span.end();
          }
        },
      ),
    );
  }

  function attempt(message: ClaimedMessage): Promise<void> {
    return inSpan('outbox.attempt', message, () => runAttempt(message));
  }

  // Reivindica até as permissões livres e dispara as tentativas sem esperá-las: `done` resolve
  // quando todas terminam. Cada tentativa devolve a sua permissão ao fim.
  async function claimRound(): Promise<{ count: number; done: Promise<void> }> {
    const permits = await semaphore.acquireFree();
    if (state === 'stopping') {
      semaphore.release(permits);
      return { count: 0, done: Promise.resolve() };
    }
    let result;
    try {
      result = await claimMessages(db, { ...settings, limit: permits });
    } catch (error) {
      semaphore.release(permits);
      throw error;
    }
    semaphore.release(permits - result.claimed.length);
    // Decididos na reivindicação, sem chamar o ERP, mas com o contexto da outbox como os da tentativa.
    for (const settled of result.closed) {
      await inSpan(
        'outbox.settle',
        settled,
        () => {
          telemetry.outboxAttemptOutcome.add(1, { outcome: 'closed' });
          logger.info({ event: 'outbox.closed', orderId: settled.orderId, attempt: settled.attempts }, 'pedido já tinha desfecho: mensagem encerrada');
        },
        { outcome: 'closed' },
      );
    }
    for (const settled of result.dead) {
      await inSpan(
        'outbox.settle',
        settled,
        () => {
          telemetry.outboxAttemptOutcome.add(1, { outcome: 'dead' });
          logger.error({ event: 'outbox.dead', orderId: settled.orderId, attempt: settled.attempts }, 'limite de tentativas gasto: mensagem na DLQ');
        },
        { outcome: 'dead' },
      );
    }
    const done = Promise.all(result.claimed.map((message) => attempt(message).finally(() => semaphore.release(1)))).then(() => undefined);
    return { count: result.claimed.length, done };
  }

  // Uma rodada completa: resolve depois de todas as tentativas terminarem.
  async function pollOnce(): Promise<number> {
    const { count, done } = await claimRound();
    await done;
    return count;
  }

  // Não espera a rodada: uma chamada lenta não segura a vazão das outras, e a reivindicação
  // seguinte já espera por uma permissão livre.
  async function run(): Promise<void> {
    while (state === 'running') {
      let count = 0;
      try {
        const round = await claimRound();
        count = round.count;
        inFlight.add(round.done);
        void round.done.finally(() => inFlight.delete(round.done));
      } catch (error) {
        logger.error({ event: 'worker.poll_error', err: error }, 'falha na rodada do worker');
      }
      if (count === 0 && state === 'running') await clock.sleep(settings.pollIntervalMs);
    }
  }

  return {
    async start() {
      // Um start() durante o stop() espera o encerramento e então reinicia.
      while (state === 'stopping') await stopped;
      if (state === 'stopped') {
        state = 'running';
        loop = run();
        logger.info({ event: 'worker_started' }, 'worker iniciado');
      }
    },
    // Sem `async`: devolve a própria promessa do encerramento, para quem espera nela ver o stop() antes do start().
    stop() {
      if (state === 'stopping' && stopped) return stopped;
      if (state !== 'running') return Promise.resolve();
      state = 'stopping';
      stopped = (async () => {
        try {
          // Para de reivindicar e espera as tentativas em andamento; o prazo é do lifecycle.
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
