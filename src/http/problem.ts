import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { PROBLEM_MEDIA_TYPE, type Problem } from '../contract/index.ts';
import { TransactionAbortedError } from '../db/database.ts';

type ProblemBody = z.input<typeof Problem>;

export interface ProblemInit {
  status: number;
  // Sufixo de /problems/<causa>.
  cause: string;
  title: string;
  detail?: string;
  errors?: { path: string; message: string }[];
  headers?: Record<string, string>;
}

// Erro de domínio que o middleware único converte em problem+json. O que não
// for ProblemError é tratado como falha inesperada (500) sem expor detalhe.
export class ProblemError extends Error {
  readonly init: ProblemInit;

  constructor(init: ProblemInit) {
    super(init.title);
    this.init = init;
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ProblemError({ status: 404, cause: 'not-found', title: 'Recurso não encontrado' }));
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // O Express identifica o middleware de erro pela aridade 4: os quatro parâmetros ficam.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, _req, res, _next) => {
    const correlationId = res.locals['correlationId'] as string;
    const init: ProblemInit =
      error instanceof ProblemError
        ? error.init
        : { status: 500, cause: 'internal-error', title: 'Erro interno' };

    if (error instanceof TransactionAbortedError) {
      // Defeito do código (erro capturado dentro da transação), não falha do cliente.
      logger.error({ event: 'db.transaction_aborted', err: error, correlationId }, 'transação abortada antes do COMMIT');
    } else if (!(error instanceof ProblemError)) {
      // O detalhe vai só para o log; a resposta nunca leva stack trace nem SQL.
      logger.error({ event: 'unhandled_error', err: error, correlationId }, 'erro inesperado na requisição');
    }

    const body: ProblemBody = {
      type: `/problems/${init.cause}`,
      title: init.title,
      status: init.status,
      correlationId,
      ...(init.detail ? { detail: init.detail } : {}),
      ...(init.errors ? { errors: init.errors } : {}),
    };

    res.status(init.status);
    for (const [name, value] of Object.entries(init.headers ?? {})) res.setHeader(name, value);
    // Definido antes do json(): o Express só põe application/json se ainda não houver tipo.
    res.setHeader('Content-Type', PROBLEM_MEDIA_TYPE);
    res.json(body);
  };
}
