import type { Pool } from 'pg';
import type { Telemetry } from '../shared/telemetry.ts';

// Gauges do estoque (OBS-06; AD-008: lidos do banco e expostos pela API; design.md, "Observabilidade").

export interface InventoryGaugesDependencies {
  pool: Pool;
  telemetry: Telemetry;
}

// Registra os callbacks de `casecellshop.inventory.reserved` e `casecellshop.inventory.oversold_skus`; devolve a
// função que os remove.
export function registerInventoryGauges(
  _dependencies: InventoryGaugesDependencies,
): () => void {
  throw new Error('não implementado');
}
