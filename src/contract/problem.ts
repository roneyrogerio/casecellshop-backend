import { z } from 'zod';

// Mesmo formato do X-Request-Id aceito na entrada (design.md, "Fundação (M1)").
export const CorrelationId = z
  .string()
  .regex(/^[\x21-\x7E]{1,128}$/)
  .meta({
    description:
      'Identificador da requisição, o mesmo do cabeçalho X-Request-Id e dos logs.',
  });

export const ProblemType = z
  .string()
  .regex(/^\/problems\/[a-z0-9-]+$/)
  .meta({
    description:
      'Uma URI por causa de erro, para o cliente decidir pela causa e não pelo texto.',
    example: '/problems/invalid-request',
  });

// RFC 9457. O correlationId e o errors são membros de extensão, que a RFC permite.
export const Problem = z
  .strictObject({
    type: ProblemType,
    title: z.string().meta({
      description: 'Resumo curto da causa, igual para toda ocorrência dela.',
    }),
    status: z.int().min(400).max(599),
    detail: z.string().optional().meta({
      description: 'Explicação desta ocorrência, sem detalhe interno.',
    }),
    instance: z.string().optional(),
    correlationId: CorrelationId,
    errors: z
      .array(
        z.strictObject({
          path: z.string().meta({
            description:
              'Onde está o problema, como query.page ou body.items.0.sku.',
          }),
          message: z.string(),
        }),
      )
      .optional()
      .meta({
        description:
          'Um erro por campo violado, o primeiro problema de cada um, só no invalid-request.',
      }),
    currentPrices: z
      .array(
        z.strictObject({
          sku: z.string(),
          unitPrice: z
            .int()
            .min(0)
            .meta({ description: 'Preço unitário atual, em centavos.' }),
        }),
      )
      .optional()
      .meta({
        description:
          'Preço atual de cada item com preço alterado, só no price-changed (AD-018).',
      }),
  })
  .meta({
    // Com id, o gerador emite um $ref único em vez de repetir o schema em cada resposta.
    id: 'Problem',
    description: 'Erro em application/problem+json (RFC 9457).',
    example: {
      type: '/problems/invalid-request',
      title: 'Requisição fora do contrato',
      status: 400,
      correlationId: '6f1c2b0e-3d4a-4b7e-9f10-2a5c8d9e7b31',
      errors: [{ path: 'query.verbose', message: 'Parâmetro desconhecido' }],
    },
  });

export type Problem = z.infer<typeof Problem>;
