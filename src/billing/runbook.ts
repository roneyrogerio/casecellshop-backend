import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import type { ErpClient } from '../erp/erp-client.ts';
import { createQueue, startRedrive } from '../queue/sqs.ts';
import type { Clock } from '../shared/clock.ts';

// Runbook da DLQ (design.md, "Worker: reconciliação e runbook").

const DEFAULT_REDRIVE_TIMEOUT_MS = 60_000;
const REDRIVE_POLL_MS = 1_000;

export interface RedriveOptions {
  client: SQSClient;
  dlqUrl: string;
  clock: Clock;
  // Até quando esperar a DLQ esvaziar.
  timeoutMs?: number;
}

export interface RedriveResult {
  before: number;
  remaining: number;
}

// Devolve as mensagens da DLQ à fila de origem e acompanha pela contagem da DLQ,
// sem o ListMessageMoveTasks, que derruba o ElasticMQ nativo (R12).
export async function redriveDlq({
  client,
  dlqUrl,
  clock,
  timeoutMs = DEFAULT_REDRIVE_TIMEOUT_MS,
}: RedriveOptions): Promise<RedriveResult> {
  const dlq = createQueue(client, dlqUrl);
  const before = await dlq.approximateCount();
  await startRedrive(client, dlqUrl);
  const deadline = clock.now() + timeoutMs;
  let remaining = await dlq.approximateCount();
  while (remaining > 0 && clock.now() < deadline) {
    await clock.sleep(REDRIVE_POLL_MS);
    remaining = await dlq.approximateCount();
  }
  return { before, remaining };
}

export interface CancelOrderDependencies {
  pool: Pool;
  erp: ErpClient;
  // Padrão: SETTLE_WINDOW_MS; o teste pode encurtar.
  settleWindowMs?: number;
}

// Resultado do cancelamento seguro (AD-031): só `cancelled` muda o pedido.
export type CancelOrderResult =
  | { kind: 'cancelled' }
  // O pedido já tinha desfecho.
  | { kind: 'unchanged' }
  // A última chamada ao ERP é mais nova que a janela de assentamento.
  | { kind: 'too_recent'; retryInMs: number }
  | { kind: 'erp_has_order' }
  | { kind: 'erp_unavailable' }
  // Outra tentativa tomou a permissão de chamada entre a consulta e o cancelamento.
  | { kind: 'permit_lost' };

// Cancela o pedido ainda pendente que o ERP não tem, só fora da janela de assentamento (AD-031).
export function cancelOrder(
  _dependencies: CancelOrderDependencies,
  _orderId: string,
): Promise<CancelOrderResult> {
  return Promise.reject(new Error('não implementado'));
}

// A mensagem ao operador de cada resultado, e se o comando sai com erro (as recusas).
export function describeCancel(
  _orderId: string,
  _result: CancelOrderResult,
): { message: string; failed: boolean } {
  throw new Error('não implementado');
}
