import { z } from 'zod';
import { CorrelationId } from './problem.ts';

// Nomes em minúsculas porque o Node entrega os cabeçalhos assim; no HTTP o nome
// não diferencia maiúsculas, então o OpenAPI continua valendo para X-Request-Id.

// Objeto não estrito: toda requisição traz outros cabeçalhos. Um X-Request-Id
// inválido não recusa a requisição: a API gera outro (design.md, "Fundação (M1)").
export const RequestHeaders = z.object({
  'x-request-id': z.string().optional().meta({
    description: 'Aceito com 1 a 128 caracteres ASCII visíveis; fora disso, a API gera um UUID.',
  }),
});

export const ResponseHeaders = z.object({
  'x-request-id': CorrelationId,
});

export const RetryAfterHeaders = ResponseHeaders.extend({
  'retry-after': z.string().regex(/^\d+$/).meta({ description: 'Segundos até tentar de novo.' }),
});
