import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { StoreDb } from '../db/database.ts';
import type { ErpClient, ErpOrderItem } from '../erp/erp-client.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger } from '../shared/logging.ts';
import { renewCallPermit, takeCallPermit } from './call-permit.ts';
import type { OrderConclusion } from './conclude.ts';
import { BILLING_LOG_EVENTS } from './telemetry.ts';

// A chamada ao ERP de uma tentativa do worker (design.md, "Worker: envio"): a permissão de
// chamada, a consulta que antecede a recriação e a criação, com os prazos conferidos entre elas.

// Parâmetros da tabela do design.md que a chamada usa.
export interface CallSettings {
  // Contado do início da última chamada (H4 mais a ida da requisição).
  minDelayMs: number;
  erpTimeoutMs: number;
  // Folga sobre o timeout: com menos prazo que timeout + folga, a tentativa desiste.
  leaseMarginMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
}

export interface CallContext {
  db: Kysely<StoreDb>;
  erp: ErpClient;
  clock: Clock;
  // Sorteio do jitter; o teste o fixa.
  random: () => number;
  settings: CallSettings;
}

// Por que a mensagem volta à fila: o resultado do ERP (ou o erro inesperado) que a causou.
export type RetryCause =
  'transient' | 'ambiguous' | 'config_error' | 'unexpected';

export type Outcome =
  | OrderConclusion
  | { kind: 'retry'; cause: RetryCause; seconds: number }
  // Outra tentativa chamou o ERP há pouco: a mensagem volta quando a permissão puder ser tomada.
  | { kind: 'deferred'; seconds: number };

// Mensagem do SQS já validada, com o prazo dela no relógio injetável.
export interface Attempt {
  orderId: string;
  correlationId: string;
  traceparent: string | null;
  receiptHandle: string;
  // ApproximateReceiveCount: é o número da tentativa.
  attempt: number;
  // Recebida em + visibilidade, medido antes do recebimento: nunca passa do prazo real do SQS.
  deadline: number;
}

// Full jitter sobre o exponencial com teto, somado ao atraso mínimo, em segundos inteiros para cima.
export function retrySeconds(
  { settings, random }: CallContext,
  attempt: number,
): number {
  const ceiling = Math.min(
    settings.backoffCapMs,
    settings.backoffBaseMs * 2 ** (attempt - 1),
  );
  return Math.ceil((settings.minDelayMs + random() * ceiling) / 1000);
}

function retry(ctx: CallContext, message: Attempt, cause: RetryCause): Outcome {
  return { kind: 'retry', cause, seconds: retrySeconds(ctx, message.attempt) };
}

function configError(
  ctx: CallContext,
  message: Attempt,
  log: Logger,
  status: number,
): Outcome {
  eventLogger(log, BILLING_LOG_EVENTS).warn(
    'casecellshop.erp.config.rejected',
    { status },
    'erro de configuração no ERP',
  );
  return retry(ctx, message, 'config_error');
}

function giveUp(log: Logger): undefined {
  eventLogger(log, BILLING_LOG_EVENTS).warn(
    'casecellshop.outbox.lease.too_short',
    {},
    'prazo curto demais para a chamada: a mensagem volta quando a visibilidade vencer',
  );
  return undefined;
}

// Desiste antes de chamar quando o prazo da mensagem ou a idade da permissão não cobrem a chamada.
function tooLate(
  { clock, settings }: CallContext,
  message: Attempt,
  permitReadAt?: number,
): boolean {
  const erpWindowMs = settings.erpTimeoutMs + settings.leaseMarginMs;
  // Idade máxima da permissão de chamada: depois dela outra tentativa do pedido já pode tomá-la (33 s).
  const maxPermitAgeMs = settings.minDelayMs - erpWindowMs;
  const now = clock.now();
  return (
    message.deadline - now < erpWindowMs ||
    (permitReadAt !== undefined && now - permitReadAt > maxPermitAgeMs)
  );
}

async function loadItems(
  db: Kysely<StoreDb>,
  orderId: string,
): Promise<ErpOrderItem[]> {
  // Itens com o preço aceito no checkout (H3).
  const rows = await db
    .selectFrom('order_items')
    .select(['sku', 'quantity', 'unit_price_cents'])
    .where('order_id', '=', orderId)
    .orderBy('sku')
    .execute();
  return rows.map((row) => ({
    sku: row.sku,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
  }));
}

// A permissão diz que a chamada anterior já pode ter chegado ao ERP: só um "não existe" explícito
// autoriza criar de novo.
async function lookupExisting(
  ctx: CallContext,
  message: Attempt,
  log: Logger,
): Promise<Outcome | 'not_found'> {
  const found = await ctx.erp.findOrderByReference(message.orderId);
  if (found.kind === 'found') return { kind: 'invoiced' };
  if (found.kind === 'config_error')
    return configError(ctx, message, log, found.status);
  if (found.kind !== 'not_found') return retry(ctx, message, 'transient');
  return 'not_found';
}

async function createInErp(
  ctx: CallContext,
  message: Attempt,
  log: Logger,
  items: ErpOrderItem[],
): Promise<Outcome> {
  const created = await ctx.erp.createOrder({
    reference: message.orderId,
    items,
  });
  if (created.kind === 'ok') return { kind: 'invoiced' };
  if (created.kind === 'permanent')
    return {
      kind: 'failed',
      reason:
        created.reason === 'rejected' ? 'erp_rejected' : 'erp_out_of_stock',
    };
  if (created.kind === 'config_error')
    return configError(ctx, message, log, created.status);
  return retry(ctx, message, created.kind);
}

// Devolve undefined quando a tentativa desiste sem responder ao SQS (prazo ou permissão curtos demais).
export async function callErp(
  ctx: CallContext,
  message: Attempt,
  log: Logger,
): Promise<Outcome | undefined> {
  const { db, clock, settings } = ctx;
  // Os itens vêm antes da permissão: nenhuma consulta ao banco pode ficar entre a última
  // conferência de prazo e a chamada ao ERP.
  const items = await loadItems(db, message.orderId);
  if (tooLate(ctx, message)) return giveUp(log);
  // Lido antes do UPDATE: a idade medida nunca fica abaixo da real, que conta do now() do banco.
  let permitReadAt = clock.now();
  const permit = await takeCallPermit(db, message.orderId, {
    minDelayMs: settings.minDelayMs,
    clearDead: true,
  });
  if (!permit.granted)
    return {
      kind: 'deferred',
      seconds: Math.ceil(permit.retryInMs / 1000) + 1,
    };

  // Conferência imediata antes de cada chamada ao ERP, a primeira e a que vem depois da renovação.
  if (tooLate(ctx, message, permitReadAt)) return giveUp(log);
  if (permit.sentBefore) {
    const existing = await lookupExisting(ctx, message, log);
    if (existing !== 'not_found') return existing;

    // A consulta pode ter sido lenta: confere de novo e regrava o início da chamada para a criação.
    if (tooLate(ctx, message, permitReadAt)) return giveUp(log);
    permitReadAt = clock.now();
    if (!(await renewCallPermit(db, message.orderId, permit.token)))
      return giveUp(log);
  }

  if (tooLate(ctx, message, permitReadAt)) return giveUp(log);
  return createInErp(ctx, message, log, items);
}
