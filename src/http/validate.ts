import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ProblemError } from './problem.ts';

type ProblemErrors = { path: string; message: string }[];

function isZod(schema: unknown): schema is z.ZodType {
  return schema instanceof z.ZodType;
}

// Mensagens em português, sem repetir o texto interno do zod. Os códigos sem mensagem própria
// ficam listados, todos com a genérica, para o tsc acusar um código novo do zod (exaustividade).
const MESSAGES: Record<z.core.$ZodIssue['code'], string> = {
  invalid_type: 'Tipo inválido',
  too_small: 'Valor abaixo do mínimo',
  too_big: 'Valor acima do máximo',
  invalid_format: 'Formato inválido',
  invalid_value: 'Valor não permitido',
  unrecognized_keys: 'Parâmetro desconhecido',
  not_multiple_of: 'Valor inválido',
  invalid_union: 'Valor inválido',
  invalid_key: 'Valor inválido',
  invalid_element: 'Valor inválido',
  custom: 'Valor inválido',
};

function messageFor(issue: z.core.$ZodIssue): string {
  // O Record já faz o tsc acusar código novo; a genérica cobre um código que o zod gere só em execução.
  return MESSAGES[issue.code] ?? 'Valor inválido';
}

function collect(origin: string, error: z.ZodError, into: ProblemErrors): void {
  // O zod pode apontar mais de um problema no mesmo campo (ex.: limite de inteiro seguro e
  // mínimo do Cents); a resposta 400 traz só o primeiro de cada caminho, na ordem original.
  const seen = new Set(into.map((e) => e.path));
  const add = (path: string, issue: z.core.$ZodIssue): void => {
    if (seen.has(path)) return;
    seen.add(path);
    into.push({ path, message: messageFor(issue) });
  };
  for (const issue of error.issues) {
    const base = [origin, ...issue.path.map(String)];
    if (issue.code === 'unrecognized_keys') {
      // Um erro por chave desconhecida, com o nome dela no caminho (FND-03).
      for (const key of issue.keys) add([...base, key].join('.'), issue);
    } else {
      add(base.join('.'), issue);
    }
  }
}

// Valida parâmetros, query, cabeçalhos e corpo pelos schemas da rota no
// contrato: a mesma fonte do OpenAPI e dos testes.
export function validateRequest(route: RouteConfig): RequestHandler {
  const request = route.request ?? {};
  const media: unknown = request.body?.content['application/json'];
  const body =
    typeof media === 'object' && media !== null && 'schema' in media
      ? media.schema
      : undefined;

  return (req, res, next) => {
    const errors: ProblemErrors = [];

    const checks: [string, unknown, unknown][] = [
      ['params', request.params, req.params],
      ['query', request.query, req.query],
      ['headers', request.headers, req.headers],
      ['body', body, req.body],
    ];
    for (const [origin, schema, value] of checks) {
      if (!isZod(schema)) continue;
      const result = schema.safeParse(value);
      if (!result.success) collect(origin, result.error, errors);
    }

    res.locals['route'] = route.path;
    if (errors.length > 0) {
      next(
        new ProblemError({
          status: 400,
          cause: 'invalid-request',
          title: 'Requisição fora do contrato',
          errors,
        }),
      );
      return;
    }
    next();
  };
}
