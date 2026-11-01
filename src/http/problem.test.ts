import express from 'express';
import { type Logger, pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PROBLEM_MEDIA_TYPE } from '../contract/index.ts';
import { TransactionAbortedError } from '../db/database.ts';
import {
  expectMatchesContract,
  findRoute,
  type ObservedResponse,
} from '../../test/helpers/contract.ts';
import { createErrorHandler } from './problem.ts';

const CORRELATION_ID = 'fnd10-correlation-id';

interface LogLine {
  level: string;
  event?: string;
  msg?: string;
  correlationId?: string;
  [key: string]: unknown;
}

// Logger do pino escrevendo numa lista em memória, com o nível como texto (como o da aplicação).
function createMemoryLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: Logger = pino(
    { level: 'info', formatters: { level: (label) => ({ level: label }) } },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine);
      },
    },
  );
  return { logger, lines };
}

// App mínimo: a rota só lança o erro dado, e o middleware único de erros responde.
function createApp(thrown: unknown) {
  const { logger, lines } = createMemoryLogger();
  const app = express();
  app.use((_req, res, next) => {
    res.locals['correlationId'] = CORRELATION_ID;
    res.setHeader('X-Request-Id', CORRELATION_ID);
    next();
  });
  app.get('/falha', (_req, _res, next) => {
    next(thrown);
  });
  app.use(createErrorHandler(logger));
  return { app, lines };
}

function observed(response: request.Response): ObservedResponse {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
  };
}

// Um erro de driver como o que a guarda recebe, com texto de SQL que nunca pode vazar.
function abortedByDriverError(): TransactionAbortedError {
  const driverError = Object.assign(
    new Error(
      'current transaction is aborted, commands ignored until end of transaction block: select 1',
    ),
    { code: '25P02' },
  );
  return new TransactionAbortedError({ cause: driverError });
}

describe('FND-10 a transação abortada vira 500 com o evento db.transaction_aborted', () => {
  it('FND-10 TransactionAbortedError responde 500 em problem+json com type /problems/internal-error', async () => {
    const { app } = createApp(abortedByDriverError());

    const response = await request(app).get('/falha');

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    expect(response.body).toMatchObject({
      type: '/problems/internal-error',
      status: 500,
      correlationId: CORRELATION_ID,
    });
    expectMatchesContract(findRoute('get', '/health'), observed(response));
  });

  it('FND-10 a resposta da transação abortada é genérica: sem a mensagem do erro, sem stack e sem SQL', async () => {
    const error = abortedByDriverError();
    const { app } = createApp(error);

    const response = await request(app).get('/falha');

    const raw = response.text;
    expect(raw).not.toContain(error.message);
    expect(raw).not.toMatch(/25P02/);
    expect(raw).not.toMatch(/transaction is aborted/i);
    expect(raw).not.toMatch(/select 1/i);
    expect(raw).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(raw).not.toContain('stack');
    expect(Object.keys(response.body as object).sort()).toEqual([
      'correlationId',
      'status',
      'title',
      'type',
    ]);
  });

  it('FND-10 a transação abortada é defeito do código: a resposta não traz Retry-After', async () => {
    const { app } = createApp(abortedByDriverError());

    const response = await request(app).get('/falha');

    expect(response.status).toBe(500);
    expect(response.headers['retry-after']).toBeUndefined();
  });

  it('FND-10 a transação abortada grava um log error com event db.transaction_aborted', async () => {
    const { app, lines } = createApp(abortedByDriverError());

    await request(app).get('/falha');

    const aborted = lines.filter(
      (line) => line.event === 'db.transaction_aborted',
    );
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.level).toBe('error');
    expect(aborted[0]?.correlationId).toBe(CORRELATION_ID);
    // Um erro só gera um log: o evento genérico não se soma ao específico.
    expect(lines.filter((line) => line.event === 'unhandled_error')).toEqual(
      [],
    );
  });

  it('FND-10 outro erro qualquer continua com o evento unhandled_error', async () => {
    const { app, lines } = createApp(new Error('falha qualquer'));

    const response = await request(app).get('/falha');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ type: '/problems/internal-error' });
    expect(response.headers['retry-after']).toBeUndefined();
    const events = lines.map((line) => line.event);
    expect(events).toEqual(['unhandled_error']);
    expect(lines[0]?.level).toBe('error');
  });
});
