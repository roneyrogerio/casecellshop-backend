import type { Clock } from '../clock.ts';
import type { Telemetry } from '../telemetry.ts';
import type { ErpClient } from './erp-client.ts';
import type { ErpTransport } from './transport.ts';

export interface ErpClientOptions {
  transport: ErpTransport;
  // O timeout aborta a chamada pelo clock.sleep, para o teste controlar o tempo.
  clock: Clock;
  timeoutMs: number;
  telemetry?: Telemetry;
}

// Camada anticorrupção: aplica o timeout e classifica cada resposta numa lista
// fechada, sem retry interno (o retry fica no worker).
export function createErpClient(_options: ErpClientOptions): ErpClient {
  throw new Error('não implementado');
}
