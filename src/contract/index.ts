import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { checkoutRoute } from './checkout.ts';
import { healthRoute } from './health.ts';
import { orderStatusRoute } from './orders.ts';

export {
  AcceptedHeaders,
  CheckoutAccepted,
  CheckoutHeaders,
  CheckoutItem,
  CheckoutRequest,
  checkoutRoute,
  MAX_BODY_BYTES,
  MAX_ITEMS,
  MAX_QUANTITY,
} from './checkout.ts';
export { BillingMessage, TRACEPARENT_ATTRIBUTE } from './billing-message.ts';
export { HealthQuery, HealthStatus, healthRoute } from './health.ts';
export {
  FailureReason,
  OrderId,
  OrderStatus,
  OrderStatusValue,
  orderStatusRoute,
} from './orders.ts';
export {
  RequestHeaders,
  ResponseHeaders,
  RetryAfterHeaders,
} from './headers.ts';
export { CorrelationId, Problem, ProblemType } from './problem.ts';
export { PROBLEM_MEDIA_TYPE } from './responses.ts';

// A validação e os testes percorrem esta lista; o OpenAPI é gerado dela.
export const routes = [healthRoute, checkoutRoute, orderStatusRoute];

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  for (const route of routes) registry.registerPath(route);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'CaseCellShop API',
      version: '0.1.0',
      description:
        'Catálogo com cache, checkout assíncrono e status do pedido, entre a loja e o ERP.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'system', description: 'Operação do serviço.' },
      {
        name: 'checkout',
        description: 'Compra assíncrona, sem esperar o ERP.',
      },
      { name: 'orders', description: 'Acompanhamento do pedido.' },
    ],
  });
}
