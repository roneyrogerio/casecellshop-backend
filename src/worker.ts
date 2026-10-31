import { sql } from 'kysely';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import { createDb } from './db/database.ts';
import type { ErpClient } from './erp/erp-client.ts';
import { type ClaimedMessage, claimMessages, intervalOf } from './outbox/claim.ts';
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

// Por que a mensagem volta à fila: o resultado do ERP (ou o erro inesperado) que a causou.
type RetryCause = 'transient' | 'ambiguous' | 'config_error' | 'unexpected';

export function createWorker({ pool, erp, logger, clock, random = Math.random, config }: WorkerDependencies): Worker {
  const settings: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
  const db = createDb(pool);
  const semaphore = createSemaphore(settings.erpConcurrency);
  let running = false;
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

  async function callErp(message: ClaimedMessage, log: Logger): Promise<Conclusion> {
    const retry = (cause: RetryCause) => {
      log.warn({ event: 'outbox.retry', outcome: cause }, 'a mensagem volta à fila');
      return retryOrDead(message);
    };
    const configError = (status: number) => {
      log.warn({ event: 'erp.config_error', status }, 'erro de configuração no ERP');
      return retry('config_error');
    };

    if (message.sentBefore) {
      // Já pode ter chegado ao ERP: só um "não existe" explícito autoriza criar de novo.
      const found = await erp.findOrderByReference(message.orderId);
      if (found.kind === 'found') return { kind: 'invoiced' };
      if (found.kind === 'config_error') return configError(found.status);
      if (found.kind !== 'not_found') return retry('transient');
    }

    const created = await erp.createOrder({ reference: message.orderId, items: message.items });
    if (created.kind === 'ok') return { kind: 'invoiced' };
    if (created.kind === 'permanent') return { kind: 'failed', reason: created.reason === 'rejected' ? 'erp_rejected' : 'erp_out_of_stock' };
    if (created.kind === 'config_error') return configError(created.status);
    return retry(created.kind);
  }

  async function finish(message: ClaimedMessage, conclusion: Conclusion, log: Logger): Promise<void> {
    for (;;) {
      try {
        const applied = await concludeMessage(db, message.orderId, message.token, conclusion);
        if (!applied) log.warn({ event: 'outbox.conclusion_no_row' }, 'o token já não vale: a conclusão não mudou nada');
        else if (conclusion.kind === 'invoiced') log.info({ event: 'order.invoiced' }, 'pedido faturado');
        else if (conclusion.kind === 'failed') log.warn({ event: 'order.failed', reason: conclusion.reason }, 'pedido falhou no ERP');
        else if (conclusion.kind === 'dead') log.error({ event: 'outbox.dead' }, 'mensagem na DLQ');
        return;
      } catch (error) {
        log.warn({ event: 'outbox.conclusion_failed', err: error }, 'falha ao gravar o desfecho');
        // Repete enquanto o lease vale; depois a mensagem volta pela reivindicação. Se nem a
        // conferência responde, desiste pelo mesmo caminho.
        const valid = await holdsLease(db, message.orderId, message.token).catch(() => false);
        if (!valid) return;
      }
    }
  }

  // Nunca rejeita: o erro de uma tentativa não pode interromper as outras da rodada.
  async function attempt(message: ClaimedMessage): Promise<void> {
    const log = logger.child({ orderId: message.orderId, attempt: message.attempts });
    let conclusion: Conclusion;
    try {
      if (!(await markCall(message))) {
        log.warn({ event: 'outbox.lease_short' }, 'lease curto demais para a chamada: a mensagem volta quando vencer');
        return;
      }
      conclusion = await callErp(message, log);
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

  async function pollOnce(): Promise<number> {
    const permits = await semaphore.acquireFree();
    let result;
    try {
      result = await claimMessages(db, { ...settings, limit: permits });
    } catch (error) {
      semaphore.release(permits);
      throw error;
    }
    semaphore.release(permits - result.claimed.length);
    for (const { orderId, attempts } of result.closed) {
      logger.info({ event: 'outbox.closed', orderId, attempt: attempts }, 'pedido já tinha desfecho: mensagem encerrada');
    }
    for (const { orderId, attempts } of result.dead) {
      logger.error({ event: 'outbox.dead', orderId, attempt: attempts }, 'limite de tentativas gasto: mensagem na DLQ');
    }
    await Promise.all(result.claimed.map((message) => attempt(message).finally(() => semaphore.release(1))));
    return result.claimed.length;
  }

  async function run(): Promise<void> {
    while (running) {
      const claimed = await pollOnce().catch((error: unknown) => {
        logger.error({ event: 'worker.poll_error', err: error }, 'falha na rodada do worker');
        return 0;
      });
      if (claimed === 0 && running) await clock.sleep(settings.pollIntervalMs);
    }
  }

  return {
    start() {
      if (!running) {
        running = true;
        loop = run();
        logger.info({ event: 'worker_started' }, 'worker iniciado');
      }
      return Promise.resolve();
    },
    async stop() {
      if (running) {
        running = false;
        // Para de reivindicar e espera as tentativas em andamento; o prazo é do lifecycle.
        await loop;
        logger.info({ event: 'worker_stopped' }, 'worker encerrado');
      }
    },
    pollOnce,
  };
}
