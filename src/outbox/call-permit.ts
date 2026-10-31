import type { Kysely } from 'kysely';
import type { StoreDb } from '../db/database.ts';

// Permissão de chamada por pedido (AD-024; design.md, "Worker: envio"): uma
// chamada ao ERP por pedido a cada atraso mínimo, pelo relógio do banco.

export type CallPermit =
  | { granted: true; token: string; sentBefore: boolean }
  // Outra tentativa chamou o ERP há menos que o atraso mínimo.
  | { granted: false; retryInMs: number };

export interface TakeCallPermitOptions {
  minDelayMs: number;
  // Só o worker zera o dead_at; a reconciliação não.
  clearDead: boolean;
}

export function takeCallPermit(_db: Kysely<StoreDb>, _orderId: string, _options: TakeCallPermitOptions): Promise<CallPermit> {
  throw new Error('não implementado');
}

// Regrava o início da chamada para a criação que vem depois da consulta; false
// quando o token já não vale.
export function renewCallPermit(_db: Kysely<StoreDb>, _orderId: string, _token: string): Promise<boolean> {
  throw new Error('não implementado');
}
