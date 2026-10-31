import type { ErpOrderRequest } from './erp-client.ts';

// Transporte entre a camada anticorrupção e o ERP: status HTTP e erros de rede,
// para o simulado ser classificado do mesmo jeito que o ERP real seria.

export type ErpRequest =
  | { op: 'createOrder'; body: ErpOrderRequest }
  | { op: 'findOrder'; reference: string }
  | { op: 'listCatalog'; page: number };

export interface ErpResponse {
  status: number;
  body: unknown;
}

export interface ErpTransport {
  // Rejeita com ErpNetworkError, ou com o motivo do sinal quando ele aborta.
  send(request: ErpRequest, signal: AbortSignal): Promise<ErpResponse>;
}

// ECONNREFUSED e ENOTFOUND: a requisição não chegou. ECONNRESET: caiu depois do envio.
export type ErpNetworkCode = 'ECONNREFUSED' | 'ENOTFOUND' | 'ECONNRESET';

export class ErpNetworkError extends Error {
  readonly code: ErpNetworkCode;

  constructor(code: ErpNetworkCode) {
    super(`Falha de rede ao falar com o ERP: ${code}`);
    this.name = 'ErpNetworkError';
    this.code = code;
  }
}
