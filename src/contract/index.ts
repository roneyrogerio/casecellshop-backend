import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { checkoutRoute } from './checkout.ts';
import { healthRoute } from './health.ts';
import { orderStatusRoute } from './orders.ts';
import { productsRoute } from './products.ts';

// Só o que outro módulo importa daqui; o resto fica no arquivo de cada schema (AI-35).
export {
  CheckoutAccepted,
  CheckoutRequest,
  checkoutRoute,
  MAX_BODY_BYTES,
} from './checkout.ts';
export { BillingMessage, TRACEPARENT_ATTRIBUTE } from './billing-message.ts';
export { HealthStatus, healthRoute } from './health.ts';
export { OrderStatus, orderStatusRoute } from './orders.ts';
export {
  PRODUCTS_PAGE_SIZE,
  type Product,
  type ProductPage,
  productsRoute,
} from './products.ts';
export { CorrelationId, Problem } from './problem.ts';
export { PROBLEM_MEDIA_TYPE } from './responses.ts';

// A validação e os testes percorrem esta lista; o OpenAPI é gerado dela.
export const routes = [
  healthRoute,
  productsRoute,
  checkoutRoute,
  orderStatusRoute,
];

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
    // Endereço absoluto: um arquivo importado no Insomnia não resolve um servidor relativo (ROADMAP, M4).
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'A API no docker compose local.',
      },
    ],
    tags: [
      { name: 'system', description: 'Operação do serviço.' },
      {
        name: 'catalog',
        description: 'Vitrine servida do cache, sem chamar o ERP.',
      },
      {
        name: 'checkout',
        description: 'Compra assíncrona, sem esperar o ERP.',
      },
      { name: 'orders', description: 'Acompanhamento do pedido.' },
    ],
  });
}
