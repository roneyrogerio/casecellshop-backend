import type { Pool } from 'pg';
import type { Clock } from '../shared/clock.ts';
import type { AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';

// Pedidos sem desfecho em 60 s (OBS-04; design.md, "Observabilidade"): a verificação periódica da API marca a
// linha com `sli_breached_at` por `UPDATE … RETURNING` e conta só o que marcou, uma vez em qualquer réplica.

export interface StuckOrderMonitorConfig {
  intervalMs: number;
  thresholdSeconds: number;
  batchSize: number;
}

export const DEFAULT_STUCK_ORDER_MONITOR_CONFIG: StuckOrderMonitorConfig = {
  intervalMs: 10_000,
  thresholdSeconds: 60,
  batchSize: 500,
};

export interface StuckOrderMonitorDependencies {
  pool: Pool;
  logger: AppLogger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<StuckOrderMonitorConfig>;
}

export interface StuckOrderMonitor {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Uma verificação: resolve com o número de pedidos que esta chamada marcou.
  checkOnce(): Promise<number>;
}

export function createStuckOrderMonitor(
  _dependencies: StuckOrderMonitorDependencies,
): StuckOrderMonitor {
  throw new Error('não implementado');
}
