import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { healthRoute } from './health.ts';

export { HealthQuery, HealthStatus, healthRoute } from './health.ts';
export { RequestHeaders, ResponseHeaders, RetryAfterHeaders } from './headers.ts';
export { CorrelationId, Problem, ProblemType } from './problem.ts';
export { PROBLEM_MEDIA_TYPE } from './responses.ts';

// A validação e os testes percorrem esta lista; o OpenAPI é gerado dela.
export const routes = [healthRoute];

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  for (const route of routes) registry.registerPath(route);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'CaseCellShop API',
      version: '0.1.0',
      description: 'Catálogo com cache, checkout assíncrono e status do pedido, entre a loja e o ERP.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/' }],
    tags: [{ name: 'system', description: 'Operação do serviço.' }],
  });
}
