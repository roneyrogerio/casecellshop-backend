import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import type { ErpClient } from './erp/erp-client.ts';
import type { Semaphore } from './outbox/semaphore.ts';
import type { Queue } from './queue/sqs.ts';
import type { Telemetry } from './telemetry.ts';

// Reconciliação periódica da DLQ do SQS (AD-003, AD-021; design.md, "Worker:
// reconciliação e runbook").

export interface ReconcilerConfig {
  intervalMs: number;
  maxMessages: number;
  visibilitySeconds: number;
  minDelayMs: number;
}

export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
  intervalMs: 300_000,
  maxMessages: 100,
  visibilitySeconds: 300,
  minDelayMs: 45_000,
};

export interface ReconcilerDependencies {
  pool: Pool;
  dlq: Queue;
  erp: ErpClient;
  semaphore: Semaphore;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<ReconcilerConfig>;
}

export interface ReconcileResult {
  seen: number;
  invoiced: number;
  closed: number;
}

export interface Reconciler {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcileOnce(): Promise<ReconcileResult>;
}

export function createReconciler(_dependencies: ReconcilerDependencies): Reconciler {
  throw new Error('não implementado');
}
