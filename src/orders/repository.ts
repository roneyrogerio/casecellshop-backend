import { SpanKind } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { createDb } from '../db/database.ts';
import type { OrderStatus } from '../contract/index.ts';
import type { Telemetry } from '../shared/telemetry.ts';

export interface OrdersRepository {
  findStatus(orderId: string): Promise<OrderStatus | null>;
}

// O span do repositório é CLIENT e filho do span da requisição (FND-05).
export function createOrdersRepository(pool: Pool, telemetry: Telemetry): OrdersRepository {
  const db = createDb(pool);
  return {
    findStatus(orderId) {
      return telemetry.withSpan(
        'orders.findStatus',
        { kind: SpanKind.CLIENT, attributes: { 'db.system.name': 'postgresql' } },
        async () => {
          const row = await db
            .selectFrom('orders')
            .select(['id', 'status', 'failure_reason'])
            .where('id', '=', orderId)
            .executeTakeFirst();
          if (!row) return null;
          // O motivo só existe no failed; o CHECK do banco garante um dos três valores.
          if (row.status === 'failed') {
            return { orderId: row.id, status: 'failed', reason: row.failure_reason as 'erp_rejected' | 'erp_out_of_stock' | 'cancelled' };
          }
          return { orderId: row.id, status: row.status as 'pending' | 'invoiced' };
        },
      );
    },
  };
}
