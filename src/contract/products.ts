import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { RequestHeaders, ResponseHeaders } from './headers.ts';
import { Problem } from './problem.ts';
import { PROBLEM_MEDIA_TYPE } from './responses.ts';

// Tamanho fixo da página, fatiada da entrada única do cache (design.md, "Vitrine e cache").
export const PRODUCTS_PAGE_SIZE = 50;

// Texto e não número: a query chega como texto, e a regex recusa "1.0", "01" e "1e3" antes de converter.
export const ProductsQuery = z.strictObject({
  page: z
    .string()
    .regex(/^[1-9]\d{0,5}$/)
    .optional()
    .meta({
      description: 'Página a partir de 1, até 999999; sem o parâmetro, 1.',
      example: '1',
    }),
});

// As faixas escondem o estoque exato e mudam menos que ele (AD-005).
export const Availability = z
  .enum(['available', 'low_stock', 'out_of_stock'])
  .meta({
    description:
      'Faixa pelas unidades livres: available acima de 5, low_stock de 1 a 5, out_of_stock sem nenhuma.',
  });

export const Product = z
  .strictObject({
    sku: z.string().meta({ example: 'CAPA-MOTO-G84' }),
    name: z.string(),
    unitPrice: z
      .int()
      .min(0)
      .meta({ description: 'Preço unitário, em centavos.', example: 4990 }),
    availability: Availability,
  })
  .meta({ id: 'Product', description: 'Um produto da vitrine.' });

export const ProductPage = z
  .strictObject({
    items: z.array(Product).max(PRODUCTS_PAGE_SIZE),
    hasNext: z.boolean().meta({
      description: 'Se há outra página depois desta.',
    }),
  })
  .meta({
    id: 'ProductPage',
    description:
      'Uma página da vitrine; todas as páginas de um TTL vêm do mesmo instantâneo.',
  });

export type Product = z.infer<typeof Product>;
export type ProductPage = z.infer<typeof ProductPage>;

// Toda resposta da vitrine leva no-store: sem ele, um cache no caminho aplicaria frescor heurístico (CAT-10).
const NoStoreHeaders = ResponseHeaders.extend({
  'cache-control': z.literal('no-store'),
});

const NoStoreRetryAfterHeaders = NoStoreHeaders.extend({
  'retry-after': z
    .string()
    .regex(/^\d+$/)
    .meta({ description: 'Segundos até tentar de novo.' }),
});

function noStoreProblem(description: string, retryAfter = false) {
  return {
    description,
    headers: retryAfter ? NoStoreRetryAfterHeaders : NoStoreHeaders,
    content: { [PROBLEM_MEDIA_TYPE]: { schema: Problem } },
  };
}

export const productsRoute = {
  method: 'get',
  path: '/products',
  operationId: 'listProducts',
  summary: 'Lista os produtos da vitrine',
  description:
    'Lê o catálogo do cache em memória, sem chamar o ERP. Preço e estoque vêm da última sincronização com o ERP.',
  tags: ['catalog'],
  security: [],
  request: { query: ProductsQuery, headers: RequestHeaders },
  responses: {
    200: {
      description: 'Uma página de produtos.',
      headers: NoStoreHeaders,
      content: { 'application/json': { schema: ProductPage } },
    },
    400: noStoreProblem('Página fora do formato ou parâmetro desconhecido.'),
    503: noStoreProblem(
      'Catálogo ainda não sincronizado, ou sem entrada no cache e com o banco fora.',
      true,
    ),
    default: noStoreProblem('Erro inesperado (500), sem detalhe interno.'),
  },
} satisfies RouteConfig;
