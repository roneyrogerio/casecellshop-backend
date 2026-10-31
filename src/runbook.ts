import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import type { Clock } from './clock.ts';

// Runbook da DLQ (design.md, "Worker: reconciliação e runbook").

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
export function redriveDlq(_options: RedriveOptions): Promise<RedriveResult> {
  throw new Error('não implementado');
}

// Cancela o pedido ainda pendente, depois de o operador confirmar no ERP que ele
// não existe; devolve se o pedido mudou.
export function cancelOrder(_pool: Pool, _orderId: string): Promise<{ changed: boolean }> {
  throw new Error('não implementado');
}
