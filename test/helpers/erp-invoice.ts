import { expect } from 'vitest';
import { orderFor } from './erp.ts';
import type { ErpWorld } from './worker.ts';

// O ERP simulado já tem a fatura do pedido: a criação direta pelo ErpClient do mundo do teste, que a grava no erp_sim.
export async function erpHasInvoice(
  world: Pick<ErpWorld, 'erp'>,
  order: { orderId: string; sku: string; quantity: number; priceCents: number },
): Promise<void> {
  const created = await world.erp.createOrder(
    orderFor(order.orderId, order.sku, order.quantity, order.priceCents),
  );
  expect(created.kind).toBe('ok');
}
