import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { expect } from 'vitest';
import { z } from 'zod';
import { routes } from '../../src/contract/index.ts';

// O que o teste observa de uma resposta, venha do supertest ou do fetch.
export interface ObservedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

type ResponseEntry = NonNullable<RouteConfig['responses']>[string | number];

// Acha a rota no registro do contrato, a mesma lista que gera o openapi.yaml.
export function findRoute(method: string, path: string): RouteConfig {
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!route)
    throw new Error(`Rota fora do contrato: ${method.toUpperCase()} ${path}`);
  return route;
}

// Traduz uma Response do fetch para o formato observado, com cabeçalhos em minúsculas.
export async function observeFetchResponse(
  response: Response,
): Promise<ObservedResponse> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('json');
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: isJson && text ? (JSON.parse(text) as unknown) : text,
  };
}

function mediaType(contentType: string | string[] | undefined): string {
  const value = Array.isArray(contentType)
    ? (contentType[0] ?? '')
    : (contentType ?? '');
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function isZod(schema: unknown): schema is z.ZodType {
  return schema instanceof z.ZodType;
}

// Valida o status, o tipo de conteúdo, o corpo e os cabeçalhos da resposta pelo
// schema da rota no contrato: a mesma fonte que a API usa para validar a entrada.
export function expectMatchesContract(
  route: RouteConfig,
  response: ObservedResponse,
): void {
  const declared: ResponseEntry | undefined =
    route.responses[response.status] ?? route.responses['default'];
  expect(
    declared,
    `status ${response.status} não está declarado em ${route.method.toUpperCase()} ${route.path}`,
  ).toBeDefined();
  const entry = declared as {
    headers?: unknown;
    content?: Record<string, { schema?: unknown }>;
  };

  if (isZod(entry.headers)) {
    const parsedHeaders = entry.headers.safeParse(response.headers);
    expect(
      parsedHeaders.success,
      `cabeçalhos fora do contrato: ${JSON.stringify(response.headers)}`,
    ).toBe(true);
  }

  const content = entry.content ?? {};
  const type = mediaType(response.headers['content-type']);
  const media = content[type];
  expect(
    media,
    `tipo de conteúdo ${type || '(vazio)'} fora do contrato (${Object.keys(content).join(', ')})`,
  ).toBeDefined();
  const schema = media?.schema;
  if (isZod(schema)) {
    const parsedBody = schema.safeParse(response.body);
    expect(
      parsedBody.success,
      `corpo fora do contrato: ${JSON.stringify(response.body)}`,
    ).toBe(true);
  }
}
