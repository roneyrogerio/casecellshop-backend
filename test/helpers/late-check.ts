import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import type pg from 'pg';
import { afterEach } from 'vitest';
import {
  createLateCheck,
  type LateCheck,
  type LateCheckConfig,
} from '../../src/billing/late-check.ts';
import type { ErpClient } from '../../src/erp/erp-client.ts';
import { fromPino, type AppLogger } from '../../src/shared/logging.ts';
import { createSemaphore, type Semaphore } from '../../src/shared/semaphore.ts';
import { createTelemetry, type Telemetry } from '../../src/shared/telemetry.ts';
import { metricValue, scrapeMetrics } from './metrics.ts';
import type { ErpWorld } from './worker.ts';

// Apoio à verificação tardia (AD-031; ORD-23 a ORD-25). As colunas novas da outbox (`create_calls`,
// `late_checked_at`, `late_finding`) são lidas e semeadas por SQL cru: os prazos são relativos ao relógio do
// banco (`now() - make_interval(...)`), e o SQL escreve isso direto, sem expressões soltas no Kysely.

export const LATE_INVOICE_DETECTED = 'casecellshop.order.late_invoice.detected';
export const LATE_CHECK_COMPLETED = 'casecellshop.order.late_check.completed';

// Janela de assentamento do design.md (Parâmetros): 15 min desde o início da última chamada ao ERP.
export const SETTLE_WINDOW_SECONDS = 900;

export interface LateCheckOptions {
  logger?: AppLogger;
  config?: Partial<LateCheckConfig>;
  semaphore?: Semaphore;
  erp?: ErpClient;
  telemetry?: Telemetry;
}

// A verificação tardia sobre o ERP e o relógio manual do mundo do teste. Montada na primeira chamada, e não
// aqui: a preparação do teste não depende dela, e uma montagem que falha não deve escondê-la.
export function buildLateCheck(
  world: Pick<ErpWorld, 'clock' | 'erp'> & {
    pool: pg.Pool;
    telemetry: Telemetry;
  },
  options: LateCheckOptions = {},
): LateCheck {
  let instance: LateCheck | undefined;
  const current = (): LateCheck =>
    (instance ??= createLateCheck({
      clock: world.clock,
      telemetry: options.telemetry ?? world.telemetry,
      pool: world.pool,
      ...(options.config ? { config: options.config } : {}),
      logger: options.logger ?? fromPino(pino({ level: 'silent' })),
      semaphore: options.semaphore ?? createSemaphore(30),
      erp: options.erp ?? world.erp,
    }));
  return {
    start: () => current().start(),
    stop: () => current().stop(),
    checkOnce: () => current().checkOnce(),
  };
}

// Uma telemetria nova por chamada (os contadores começam do zero), encerrada no fim do teste.
export function useTelemetryPerTest(): () => Telemetry {
  const created: Telemetry[] = [];
  afterEach(async () => {
    for (const telemetry of created.splice(0)) await telemetry.shutdown();
  });
  return () => {
    const telemetry = createTelemetry({
      spanExporter: new InMemorySpanExporter(),
    });
    created.push(telemetry);
    return telemetry;
  };
}

export interface LateColumns {
  createCalls: number;
  lateCheckedAt: Date | null;
  lateFinding: string | null;
}

export async function readLateColumns(
  pool: pg.Pool,
  orderId: string,
): Promise<LateColumns> {
  const result = await pool.query<{
    create_calls: number;
    late_checked_at: Date | null;
    late_finding: string | null;
  }>(
    'select create_calls, late_checked_at, late_finding from outbox where order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`outbox inexistente para ${orderId}`);
  return {
    createCalls: row.create_calls,
    lateCheckedAt: row.late_checked_at,
    lateFinding: row.late_finding,
  };
}

// Semeia o estado de uma linha da outbox como a deixaria um envio em dúvida: o número de criações mandadas ao
// ERP e o início da última chamada, no passado pelo relógio do banco. `first_sent_at` acompanha, porque
// houve ao menos uma chamada.
export async function seedSentState(
  pool: pg.Pool,
  orderId: string,
  state: { createCalls: number; lastCallAgoSeconds: number },
): Promise<void> {
  await pool.query(
    `update outbox
        set create_calls = $2,
            first_sent_at = coalesce(first_sent_at, now() - make_interval(secs => $3)),
            last_call_at = now() - make_interval(secs => $3)
      where order_id = $1`,
    [orderId, state.createCalls, state.lastCallAgoSeconds],
  );
}

export type SeededOutcome =
  | { status: 'invoiced' }
  | {
      status: 'failed';
      reason: 'cancelled' | 'erp_rejected' | 'erp_out_of_stock';
    };

// Um desfecho já gravado, semeado: o `cancelOrder` é de outra fatia (AD-031), e a recusa depois de dois envios
// só existe com o ORD-27. O pedido muda e o estoque acompanha na mesma regra do worker (a reserva sai; vira
// venda só no faturado), para o teste comparar o estoque antes e depois da verificação.
export async function seedOutcome(
  pool: pg.Pool,
  order: { orderId: string; sku: string; quantity: number },
  outcome: SeededOutcome,
): Promise<void> {
  const reason = outcome.status === 'failed' ? outcome.reason : null;
  await pool.query(
    `update orders
        set status = $2, failure_reason = $3, outcome_at = now()
      where id = $1 and status = 'pending'`,
    [order.orderId, outcome.status, reason],
  );
  await pool.query(
    `update inventory
        set reserved = reserved - $2,
            on_hand = on_hand - $3,
            sold_total = sold_total + $3
      where sku = $1`,
    [
      order.sku,
      order.quantity,
      outcome.status === 'invoiced' ? order.quantity : 0,
    ],
  );
}

// Marca como já verificadas as outras linhas da outbox, para a rodada ver só os pedidos do teste: o banco é
// compartilhado pelos testes do arquivo, e a verificação lê candidatos de toda a tabela.
export async function markOthersChecked(
  pool: pg.Pool,
  keep: readonly string[],
): Promise<void> {
  await pool.query(
    `update outbox
        set late_checked_at = now()
      where late_checked_at is null and not (order_id = any($1::uuid[]))`,
    [keep],
  );
}

// A última chamada ao ERP fora da janela de assentamento (15 min) e dentro dela, pelo relógio do banco.
export const PAST_WINDOW_SECONDS = SETTLE_WINDOW_SECONDS + 60;
export const WITHIN_WINDOW_SECONDS = SETTLE_WINDOW_SECONDS - 60;

export interface LateInvoiceMetrics {
  failedOrder: number | undefined;
  duplicate: number | undefined;
}

// O counter dos achados, lido do /metrics, por causa; `undefined` é série ausente.
export async function readLateInvoices(
  telemetry: Telemetry,
): Promise<LateInvoiceMetrics> {
  const families = await scrapeMetrics(telemetry);
  return {
    failedOrder: metricValue(families, 'casecellshop.order.late_invoices', {
      'casecellshop.late_invoice.cause': 'failed_order',
    }),
    duplicate: metricValue(families, 'casecellshop.order.late_invoices', {
      'casecellshop.late_invoice.cause': 'duplicate',
    }),
  };
}

export interface SpiedErp {
  erp: ErpClient;
  // Referências consultadas (`findOrderByReference`) e contadas (`countInvoicesByReference`) pela verificação.
  finds: string[];
  counts: string[];
}

// O ErpClient do mundo embrulhado só para anotar as chamadas da verificação tardia: o ORD-25 trata do número de
// chamadas (um envio só e a janela não consultam o ERP), e a resposta continua a do ERP simulado.
export function spyErp(inner: ErpClient): SpiedErp {
  const finds: string[] = [];
  const counts: string[] = [];
  return {
    finds,
    counts,
    erp: {
      ...inner,
      findOrderByReference(reference) {
        finds.push(reference);
        return inner.findOrderByReference(reference);
      },
      countInvoicesByReference(reference) {
        counts.push(reference);
        return inner.countInvoicesByReference(reference);
      },
    },
  };
}
