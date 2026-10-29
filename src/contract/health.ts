import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { RequestHeaders } from './headers.ts';
import { defaultResponse, jsonResponse, problemResponse, unavailableResponse } from './responses.ts';

// Estrita e vazia: um parâmetro desconhecido é uma requisição fora do contrato (FND-03).
export const HealthQuery = z.strictObject({});

export const HealthStatus = z.strictObject({ status: z.literal('ok') });

export type HealthStatus = z.infer<typeof HealthStatus>;

export const healthRoute = {
  method: 'get',
  path: '/health',
  operationId: 'getHealth',
  summary: 'Confere se a API e o banco respondem',
  description: 'Usada pelo healthcheck do compose. Responde 200 só se o banco responde a um SELECT 1.',
  tags: ['system'],
  security: [],
  request: { query: HealthQuery, headers: RequestHeaders },
  responses: {
    200: jsonResponse('A API e o banco respondem.', HealthStatus),
    400: problemResponse('Requisição fora do contrato, como um parâmetro desconhecido.'),
    503: unavailableResponse('O banco não respondeu.'),
    default: defaultResponse,
  },
} satisfies RouteConfig;
