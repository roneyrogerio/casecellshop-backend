import type { Pool } from 'pg';
import type { Telemetry } from '../shared/telemetry.ts';

// Gauge da idade da outbox (AD-008: sinal lido do banco, exposto pela API; design.md, "Observabilidade").

export interface OutboxAgeGaugeDependencies {
  pool: Pool;
  telemetry: Telemetry;
}

// Registra o callback do `casecellshop.outbox.oldest_pending.age`; devolve a função que o remove.
export function registerOutboxAgeGauge(
  _dependencies: OutboxAgeGaugeDependencies,
): () => void {
  throw new Error('não implementado');
}
