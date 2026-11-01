import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { RequestHeaders } from './headers.ts';
import {
  defaultResponse,
  jsonResponse,
  problemResponse,
  unavailableResponse,
} from './responses.ts';

// UUID gerado pelo banco (gen_random_uuid): sem ordem previsível, para um
// pedido não ser achado por enumeração.
export const OrderId = z
  .uuid()
  .meta({ description: 'Identificador do pedido, um UUID gerado pela loja.' });

export const OrderStatusValue = z.enum(['pending', 'invoiced', 'failed']).meta({
  description:
    'pending até o ERP responder; invoiced quando faturado; failed com o motivo.',
});

// Os três motivos de um pedido falho, que o banco também garante.
export const FailureReason = z
  .enum(['erp_rejected', 'erp_out_of_stock', 'cancelled'])
  .meta({
    description: 'Rejeição do ERP, falta de estoque no ERP ou cancelamento.',
  });

// O motivo vem só no failed: a união separa os dois casos no contrato.
export const OrderStatus = z
  .union([
    z.strictObject({
      orderId: OrderId,
      status: z.enum(['pending', 'invoiced']),
    }),
    z.strictObject({
      orderId: OrderId,
      status: z.literal('failed'),
      reason: FailureReason,
    }),
  ])
  .meta({ id: 'OrderStatus', description: 'Estado atual do pedido.' });

export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderStatusParams = z.strictObject({ orderId: OrderId });

export const OrderStatusQuery = z.strictObject({});

export const orderStatusRoute = {
  method: 'get',
  path: '/orders/{orderId}/status',
  operationId: 'getOrderStatus',
  summary: 'Consulta o estado de um pedido',
  description:
    'Acompanha o pedido criado pelo POST /checkout até o faturamento no ERP ou a falha.',
  tags: ['orders'],
  security: [],
  request: {
    params: OrderStatusParams,
    query: OrderStatusQuery,
    headers: RequestHeaders,
  },
  responses: {
    200: jsonResponse('Estado atual do pedido.', OrderStatus),
    400: problemResponse(
      'Identificador fora do formato UUID ou parâmetro desconhecido.',
    ),
    404: problemResponse('Pedido inexistente.'),
    503: unavailableResponse('O banco não respondeu.'),
    default: defaultResponse,
  },
} satisfies RouteConfig;
