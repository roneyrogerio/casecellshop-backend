import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { sql, type Kysely, type Transaction } from 'kysely';
import { BillingMessage } from '../contract/billing-message.ts';
import { createDb, runInTransaction, type StoreDb } from '../db/database.ts';
import type { OutgoingMessage, Queue } from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { billingMetrics } from './telemetry.ts';

// Message Relay (Polling Publisher): publica no SQS as linhas da outbox ainda não
// publicadas (AD-021; design.md, "Message Relay").

export interface RelayConfig {
  batchSize: number;
  idleIntervalMs: number;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  batchSize: 10,
  idleIntervalMs: 500,
};

export interface RelayDependencies {
  pool: Pool;
  queue: Queue;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<RelayConfig>;
}

export interface Relay {
  start(): Promise<void>;
  stop(): Promise<void>;
  publishOnce(): Promise<number>;
}

interface Context {
  db: Kysely<StoreDb>;
  queue: Queue;
  logger: Logger;
  telemetry: Telemetry;
  settings: RelayConfig;
}

interface OutboxRow {
  order_id: string;
  correlation_id: string;
  traceparent: string | null;
}

// Valida o corpo antes de enviar: a mensagem que sai tem de passar no contrato do worker.
// Linha inválida fica fora do lote: se derrubasse a rodada, travaria as demais, já que é das mais antigas.
function toOutgoing(logger: Logger, rows: OutboxRow[]): OutgoingMessage[] {
  return rows.flatMap((row) => {
    const parsed = BillingMessage.safeParse({
      orderId: row.order_id,
      correlationId: row.correlation_id,
    });
    if (!parsed.success) {
      logger.error(
        { event: 'outbox.invalid_row', orderId: row.order_id },
        'linha da outbox inválida, fora do lote',
      );
      return [];
    }
    return [
      {
        id: row.order_id,
        body: JSON.stringify(parsed.data),
        traceparent: row.traceparent,
      },
    ];
  });
}

// Devolve as linhas lidas e as publicadas: a diferença decide se o lote veio cheio.
async function publishBatch(
  { queue, logger, telemetry, settings }: Context,
  trx: Transaction<StoreDb>,
): Promise<{ read: number; published: number }> {
  // SKIP LOCKED: dois relés levam lotes diferentes, sem um esperar o outro.
  const rows = await trx
    .selectFrom('outbox')
    .select(['order_id', 'correlation_id', 'traceparent'])
    .where('published_at', 'is', null)
    .orderBy('created_at')
    .limit(settings.batchSize)
    .forUpdate()
    .skipLocked()
    .execute();
  if (rows.length === 0) return { read: 0, published: 0 };

  const outgoing = toOutgoing(logger, rows);
  if (outgoing.length === 0) return { read: rows.length, published: 0 };
  const { failedIds } = await queue.send(outgoing);
  const failed = new Set(failedIds);
  const accepted = outgoing
    .map((message) => message.id)
    .filter((id) => !failed.has(id));
  if (accepted.length === 0) return { read: rows.length, published: 0 };

  // Se este UPDATE falhar, a mensagem já está no SQS e a linha volta ao lote: entrega ao menos uma vez.
  const marked = await trx
    .updateTable('outbox')
    .set({ published_at: sql<Date>`now()` })
    .where('order_id', 'in', accepted)
    .returning('order_id')
    .execute();
  billingMetrics(telemetry).add(
    'casecellshop.outbox.published.messages',
    marked.length,
  );
  return { read: rows.length, published: marked.length };
}

const round = (ctx: Context) =>
  runInTransaction(ctx.db, (trx) => publishBatch(ctx, trx));

export function createRelay({
  pool,
  queue,
  logger,
  telemetry,
  clock,
  config,
}: RelayDependencies): Relay {
  const settings: RelayConfig = { ...DEFAULT_RELAY_CONFIG, ...config };
  const ctx: Context = {
    db: createDb(pool),
    queue,
    logger,
    telemetry,
    settings,
  };

  const runner = createLoopRunner({
    async run(isRunning) {
      while (isRunning()) {
        let full = false;
        try {
          full = (await round(ctx)).published >= settings.batchSize;
        } catch (error) {
          logger.error(
            { event: 'outbox.relay_error', err: error },
            'falha na rodada do relay',
          );
        }
        // Lote cheio: pode haver mais; senão (vazio, parcial ou erro) espera.
        if (!full && isRunning()) await clock.sleep(settings.idleIntervalMs);
      }
    },
    onStarted: () => logger.info({ event: 'relay_started' }, 'relay iniciado'),
    onStopped: () => logger.info({ event: 'relay_stopped' }, 'relay encerrado'),
  });

  return {
    start: () => runner.start(),
    stop: () => runner.stop(),
    publishOnce: async () => (await round(ctx)).published,
  };
}
