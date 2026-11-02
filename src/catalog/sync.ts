// A sincronização de preço e estoque com o ERP, no worker (AD-009; design.md, "Sincronização").
import type { Pool } from 'pg';
import type { ErpClient } from '../erp/erp-client.ts';
import type { Clock } from '../shared/clock.ts';
import type { AppLogger } from '../shared/logging.ts';
import type { Semaphore } from '../shared/semaphore.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import type { CatalogSyncConfig } from './config.ts';

export interface CatalogSyncDependencies {
  pool: Pool;
  erp: ErpClient;
  // O semáforo das chamadas ao ERP do processo, o mesmo do envio e da reconciliação.
  semaphore: Semaphore;
  clock: Clock;
  logger: AppLogger;
  telemetry: Telemetry;
  config: CatalogSyncConfig;
}

export interface SyncRoundResult {
  // Todas as páginas do ERP lidas: só então os ausentes são zerados e o last_completed_at é gravado.
  complete: boolean;
  // SKUs lidos do ERP nesta rodada.
  skuCount: number;
  // SKUs ausentes do ERP zerados nesta rodada (0 numa rodada incompleta).
  missingCount: number;
}

export interface CatalogSync {
  // Uma rodada na subida e depois uma por intervalo, uma de cada vez; idempotente.
  start(): Promise<void>;
  // Espera a rodada em andamento.
  stop(): Promise<void>;
  // Uma rodada direta, para os testes; nunca em paralelo com outra.
  runRound(): Promise<SyncRoundResult>;
}

export function createCatalogSync(_deps: CatalogSyncDependencies): CatalogSync {
  throw new Error('não implementado');
}
