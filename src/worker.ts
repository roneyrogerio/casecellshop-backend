import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import type { ErpClient } from './erp/erp-client.ts';
import type { Telemetry } from './telemetry.ts';

// Parâmetros da tabela do design.md; os testes sobrepõem só o que precisam.
export interface WorkerConfig {
  leaseMs: number;
  // Contado do início da última chamada (H4 mais a ida da requisição).
  minDelayMs: number;
  erpTimeoutMs: number;
  // Folga sobre o timeout: com menos lease que timeout + folga, a tentativa desiste.
  leaseMarginMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  pollIntervalMs: number;
  erpConcurrency: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  leaseMs: 30_000,
  minDelayMs: 45_000,
  erpTimeoutMs: 10_000,
  leaseMarginMs: 2_000,
  maxAttempts: 12,
  backoffBaseMs: 5_000,
  backoffCapMs: 300_000,
  pollIntervalMs: 500,
  erpConcurrency: 30,
};

export interface WorkerDependencies {
  pool: Pool;
  // Porta do ERP (camada anticorrupção). Obrigatória a partir da Fatia 2 do M3.
  erp?: ErpClient;
  // Pool do ERP simulado do M1; sai na Fatia 2 do M3, quando o main monta a porta.
  erpPool?: Pool;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  // Sorteio do jitter; o teste o fixa.
  random?: () => number;
  config?: Partial<WorkerConfig>;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Uma rodada: reivindica até as permissões livres do semáforo, roda as tentativas
  // e resolve com o número de mensagens reivindicadas, depois de todas terminarem.
  pollOnce(): Promise<number>;
}

// No M1 o worker só tem o ciclo de vida; o envio entra na Fatia 2 do M3.
export function createWorker({ logger }: WorkerDependencies): Worker {
  let running = false;
  return {
    start() {
      if (!running) {
        running = true;
        logger.info({ event: 'worker_started' }, 'worker iniciado');
      }
      return Promise.resolve();
    },
    stop() {
      if (running) {
        running = false;
        logger.info({ event: 'worker_stopped' }, 'worker encerrado');
      }
      return Promise.resolve();
    },
    pollOnce() {
      return Promise.reject(new Error('não implementado'));
    },
  };
}
