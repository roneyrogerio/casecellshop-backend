import type { Kysely } from 'kysely';
import type { Pool } from 'pg';
import { createDb, type StoreDb } from '../db/database.ts';
import type { ErpClient } from '../erp/erp-client.ts';
import type { Clock } from '../shared/clock.ts';
import { eventLogger, type AppLogger } from '../shared/logging.ts';
import { createLoopRunner } from '../shared/loop-runner.ts';
import { withPermit, type Semaphore } from '../shared/semaphore.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import {
  MIN_CALL_DELAY_MS,
  SETTLE_WINDOW_MS,
  takeCallPermit,
} from './call-permit.ts';
import {
  markChecked,
  selectCandidates,
  type LateCandidate,
  type LateFinding,
} from './late-check-store.ts';
import { BILLING_LOG_EVENTS, billingMetrics } from './telemetry.ts';

// Verificação tardia dos pedidos com envio em dúvida (AD-031; design.md, "Worker: verificação tardia").

export interface LateCheckConfig {
  intervalMs: number;
  maxOrders: number;
  settleWindowMs: number;
  minDelayMs: number;
}

export const DEFAULT_LATE_CHECK_CONFIG: LateCheckConfig = {
  intervalMs: 300_000,
  maxOrders: 100,
  settleWindowMs: SETTLE_WINDOW_MS,
  minDelayMs: MIN_CALL_DELAY_MS,
};

export interface LateCheckDependencies {
  pool: Pool;
  erp: ErpClient;
  semaphore: Semaphore;
  logger: AppLogger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<LateCheckConfig>;
}

export interface LateCheckResult {
  // Candidatos com resultado conclusivo nesta rodada (marca gravada).
  checked: number;
  // Achados registrados nesta rodada.
  found: number;
}

export interface LateCheck {
  start(): Promise<void>;
  stop(): Promise<void>;
  checkOnce(): Promise<LateCheckResult>;
}

interface Context {
  db: Kysely<StoreDb>;
  erp: ErpClient;
  semaphore: Semaphore;
  logger: AppLogger;
  telemetry: Telemetry;
  settings: LateCheckConfig;
  isStopping: () => boolean;
}

// `inconclusive`: a consulta ou a contagem falhou, ou a permissão não veio; nada é gravado.
type Verdict =
  | { kind: 'inconclusive' }
  | { kind: 'conclusive'; finding: LateFinding | undefined };

const INCONCLUSIVE: Verdict = { kind: 'inconclusive' };

// Pedido falho: a consulta é uma chamada à API, então vale a regra da H4 (permissão de chamada, sem somar
// create_calls). Sem a permissão, outra tentativa chamou há pouco e o pedido volta numa rodada futura.
async function examineFailed(ctx: Context, orderId: string): Promise<Verdict> {
  const permit = await takeCallPermit(ctx.db, orderId, {
    minDelayMs: ctx.settings.minDelayMs,
    clearDead: false,
  });
  if (!permit.granted) return INCONCLUSIVE;
  const found = await ctx.erp.findOrderByReference(orderId);
  if (found.kind === 'found')
    return { kind: 'conclusive', finding: 'failed_order' };
  return found.kind === 'not_found'
    ? { kind: 'conclusive', finding: undefined }
    : INCONCLUSIVE;
}

// Pedido faturado: a contagem lê o banco do ERP, não a API, então não disputa a permissão da H4.
async function examineInvoiced(
  ctx: Context,
  orderId: string,
): Promise<Verdict> {
  const counted = await ctx.erp.countInvoicesByReference(orderId);
  if (counted.kind !== 'ok') return INCONCLUSIVE;
  return {
    kind: 'conclusive',
    finding: counted.count >= 2 ? 'duplicate' : undefined,
  };
}

// Devolve o achado que esta instância gravou, se houve; undefined quando não há achado ou outra réplica marcou antes.
async function checkCandidate(
  ctx: Context,
  candidate: LateCandidate,
): Promise<{ marked: boolean; finding: LateFinding | undefined }> {
  const { orderId, correlationId, status } = candidate;
  const verdict = await withPermit(ctx.semaphore, () =>
    status === 'failed'
      ? examineFailed(ctx, orderId)
      : examineInvoiced(ctx, orderId),
  );
  if (verdict.kind === 'inconclusive')
    return { marked: false, finding: undefined };
  const marked = await markChecked(ctx.db, orderId, verdict.finding);
  // Só quem gravou a marca alerta: com várias réplicas, o achado sai uma vez.
  if (marked && verdict.finding) {
    eventLogger(
      ctx.logger.child({ orderId, correlationId }),
      BILLING_LOG_EVENTS,
    ).error(
      'casecellshop.order.late_invoice.detected',
      { cause: verdict.finding },
      'fatura tardia ou duplicada no ERP',
    );
    billingMetrics(ctx.telemetry).add('casecellshop.order.late_invoices', 1, {
      'casecellshop.order.late_invoice.cause': verdict.finding,
    });
  }
  return { marked, finding: marked ? verdict.finding : undefined };
}

async function checkOnce(ctx: Context): Promise<LateCheckResult> {
  const { db, settings } = ctx;
  const result: LateCheckResult = { checked: 0, found: 0 };
  const candidates = await selectCandidates(
    db,
    settings.settleWindowMs,
    settings.maxOrders,
  );
  for (const candidate of candidates) {
    if (ctx.isStopping()) break;
    try {
      const outcome = await checkCandidate(ctx, candidate);
      if (outcome.marked) result.checked += 1;
      if (outcome.finding) result.found += 1;
    } catch (error) {
      // Um pedido com problema não impede os outros; ele volta na rodada seguinte.
      eventLogger(
        ctx.logger.child({ orderId: candidate.orderId }),
        BILLING_LOG_EVENTS,
      ).warn(
        'casecellshop.order.late_check.failed',
        { err: error },
        'falha na verificação tardia do pedido',
      );
    }
  }
  eventLogger(ctx.logger, BILLING_LOG_EVENTS).info(
    'casecellshop.order.late_check.completed',
    result,
    'rodada da verificação tardia concluída',
  );
  return result;
}

export function createLateCheck({
  pool,
  erp,
  semaphore,
  logger,
  telemetry,
  clock,
  config,
}: LateCheckDependencies): LateCheck {
  const ctx: Context = {
    db: createDb(pool),
    erp,
    semaphore,
    logger,
    telemetry,
    settings: { ...DEFAULT_LATE_CHECK_CONFIG, ...config },
    isStopping: () => runner.isStopping(),
  };

  const runner = createLoopRunner({
    clock,
    async run(isRunning) {
      while (isRunning()) {
        try {
          await checkOnce(ctx);
        } catch (error) {
          // A rodada que falha (a leitura dos candidatos) não derruba o laço.
          eventLogger(logger, BILLING_LOG_EVENTS).warn(
            'casecellshop.order.late_check.failed',
            { err: error },
            'falha na rodada da verificação tardia',
          );
        }
        if (isRunning()) await runner.pause(ctx.settings.intervalMs);
      }
    },
  });

  return {
    async start() {
      // Exporta as duas séries com 0 antes do primeiro achado, para o alerta ver o aumento desde o zero.
      const metrics = billingMetrics(telemetry);
      for (const cause of ['failed_order', 'duplicate'] as const)
        metrics.add('casecellshop.order.late_invoices', 0, {
          'casecellshop.order.late_invoice.cause': cause,
        });
      await runner.start();
    },
    stop: () => runner.stop(),
    checkOnce: () => checkOnce(ctx),
  };
}
