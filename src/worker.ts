import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from './clock.ts';
import type { Telemetry } from './telemetry.ts';

export interface WorkerDependencies {
  pool: Pool;
  // Pool próprio do ERP simulado: a chamada ao ERP não disputa conexão com a loja.
  erpPool: Pool;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// No M1 o worker só tem o ciclo de vida: a outbox, a reconciliação e a
// sincronização entram nos marcos seguintes, sobre estas mesmas dependências.
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
  };
}
