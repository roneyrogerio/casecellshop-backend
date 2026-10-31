import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '../clock.ts';
import type { Queue } from '../queue/sqs.ts';
import type { Telemetry } from '../telemetry.ts';

// Message Relay (Polling Publisher): publica no SQS as linhas da outbox ainda não
// publicadas (AD-021; design.md, "Message Relay").

export interface RelayConfig {
  batchSize: number;
  idleIntervalMs: number;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  batchSize: 10,
  idleIntervalMs: 500,
};

export interface RelayDependencies {
  pool: Pool;
  queue: Queue;
  logger: Logger;
  telemetry: Telemetry;
  clock: Clock;
  config?: Partial<RelayConfig>;
}

export interface Relay {
  start(): Promise<void>;
  stop(): Promise<void>;
  publishOnce(): Promise<number>;
}

export function createRelay(_dependencies: RelayDependencies): Relay {
  throw new Error('não implementado');
}
