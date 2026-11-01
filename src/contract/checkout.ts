import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { CorrelationId } from './problem.ts';
import { RequestHeaders, RetryAfterHeaders } from './headers.ts';
import { OrderId, OrderStatusValue } from './orders.ts';
import {
  defaultResponse,
  problemResponse,
  unavailableResponse,
} from './responses.ts';

// design.md, "Parâmetros": limites de entrada do checkout.
export const MAX_QUANTITY = 10;
export const MAX_ITEMS = 20;
export const MAX_BODY_BYTES = 16 * 1024;

export const Sku = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/)
  .meta({ description: 'Código do produto.', example: 'CAPA-IP15-PRETA' });

// Dinheiro sempre em centavos inteiros.
export const Cents = z.int().min(0).meta({ description: 'Valor em centavos.' });

export const CheckoutItem = z.strictObject({
  sku: Sku,
  quantity: z.int().min(1).max(MAX_QUANTITY),
  // AD-018: o preço que o cliente viu; o cobrado é sempre o do banco.
  expectedUnitPrice: Cents.meta({
    description: 'Preço unitário que o cliente viu, em centavos.',
  }),
});

export const CheckoutRequest = z
  .strictObject({ items: z.array(CheckoutItem).min(1).max(MAX_ITEMS) })
  .meta({
    id: 'CheckoutRequest',
    description: 'Itens do pedido; cada SKU aparece uma vez.',
  });

export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

// A chave tem o mesmo formato do X-Request-Id. Ela é obrigatória, mas a falta dela
// tem causa própria (idempotency-key-required), e por isso o handler a confere.
export const IdempotencyKey = CorrelationId.meta({
  description:
    'Chave escolhida pelo cliente para repetir o mesmo pedido sem criar outro (1 a 128 caracteres ASCII visíveis).',
});

export const CheckoutHeaders = RequestHeaders.extend({
  'idempotency-key': IdempotencyKey,
});

export const CheckoutAccepted = z
  .strictObject({
    orderId: OrderId,
    status: OrderStatusValue,
    total: Cents.meta({
      description: 'Total do pedido em centavos, pelo preço do banco.',
    }),
  })
  .meta({
    id: 'CheckoutAccepted',
    description: 'Pedido aceito; o faturamento no ERP segue em segundo plano.',
  });

export type CheckoutAccepted = z.infer<typeof CheckoutAccepted>;

export const AcceptedHeaders = RetryAfterHeaders.extend({
  location: z
    .string()
    .regex(/^\/orders\/[0-9a-f-]{36}\/status$/)
    .meta({ description: 'Onde acompanhar o pedido.' }),
});

export const checkoutRoute = {
  method: 'post',
  path: '/checkout',
  operationId: 'postCheckout',
  summary: 'Inicia uma compra',
  description:
    'Reserva o estoque e grava o pedido numa transação, sem esperar o ERP, e responde 202. A mesma Idempotency-Key com o mesmo corpo devolve o mesmo pedido.',
  tags: ['checkout'],
  security: [],
  request: {
    headers: CheckoutHeaders,
    body: {
      required: true,
      content: { 'application/json': { schema: CheckoutRequest } },
    },
  },
  responses: {
    202: {
      description:
        'Pedido aceito, ou o mesmo pedido de antes na repetição com a mesma chave.',
      headers: AcceptedHeaders,
      content: { 'application/json': { schema: CheckoutAccepted } },
    },
    400: problemResponse(
      'Entrada fora do contrato, sem Idempotency-Key ou com SKU repetido.',
    ),
    409: problemResponse(
      'Sem estoque, preço alterado (com currentPrices) ou a mesma chave em andamento.',
    ),
    413: problemResponse('Corpo acima de 16 KiB.'),
    415: problemResponse('Conteúdo diferente de application/json.'),
    422: problemResponse('A mesma chave com outro corpo, ou SKU inexistente.'),
    503: unavailableResponse(
      'O banco não respondeu ou um lock passou do prazo.',
    ),
    default: defaultResponse,
  },
} satisfies RouteConfig;
