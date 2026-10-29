import type { ResponseConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { ResponseHeaders, RetryAfterHeaders } from './headers.ts';
import { Problem } from './problem.ts';

export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

export function jsonResponse(description: string, schema: z.ZodType): ResponseConfig {
  return { description, headers: ResponseHeaders, content: { 'application/json': { schema } } };
}

export function problemResponse(description: string): ResponseConfig {
  return { description, headers: ResponseHeaders, content: { [PROBLEM_MEDIA_TYPE]: { schema: Problem } } };
}

// O 503 diz ao cliente quando tentar de novo, em vez de deixá-lo insistir.
export function unavailableResponse(description: string): ResponseConfig {
  return { description, headers: RetryAfterHeaders, content: { [PROBLEM_MEDIA_TYPE]: { schema: Problem } } };
}

// Toda rota herda o default, para um erro inesperado também sair em problem+json.
export const defaultResponse = problemResponse('Erro inesperado (500), sem detalhe interno.');
