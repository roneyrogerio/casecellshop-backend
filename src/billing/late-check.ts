import type { Pool } from 'pg';
import type { ErpClient } from '../erp/erp-client.ts';
import type { Clock } from '../shared/clock.ts';
import type { AppLogger } from '../shared/logging.ts';
import type { Semaphore } from '../shared/semaphore.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { MIN_CALL_DELAY_MS, SETTLE_WINDOW_MS } from './call-permit.ts';

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

export function createLateCheck(
  _dependencies: LateCheckDependencies,
): LateCheck {
  throw new Error('não implementado');
}
