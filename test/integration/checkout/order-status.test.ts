import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/app.ts';
import { OrderStatus, PROBLEM_MEDIA_TYPE, Problem } from '../../../src/contract/index.ts';
import { createTelemetry } from '../../../src/telemetry.ts';
import { expectMatchesContract, findRoute } from '../../helpers/contract.ts';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statusRoute = findRoute('get', '/orders/{orderId}/status');

type FailureReason = 'erp_rejected' | 'erp_out_of_stock' | 'cancelled';

let database: TestDatabase;
let app: ReturnType<typeof createApp>;
const logLines: Record<string, unknown>[] = [];

// Destino em memória do pino: cada linha JSON vira um objeto em `logLines`.
const logSink = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() !== '') logLines.push(JSON.parse(line) as Record<string, unknown>);
    }
    callback();
  },
});

// O banco só aceita `failed` com um dos três motivos, e os outros status sem motivo.
async function insertOrder(status: 'pending' | 'invoiced' | 'failed', reason: FailureReason | null = null): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    'insert into orders (status, failure_reason) values ($1, $2) returning id',
    [status, reason],
  );
  const row = result.rows[0];
  if (!row) throw new Error('o insert do pedido não devolveu a linha');
  return row.id;
}

beforeAll(async () => {
  database = await startMigratedDatabase();
  app = createApp({
    pool: database.pool,
    logger: pino({ level: 'info' }, logSink),
    telemetry: createTelemetry({ spanExporter: new InMemorySpanExporter() }),
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('CHK-11 status do pedido', () => {
  it.each(['pending', 'invoiced'] as const)('CHK-11 um pedido %s responde 200 com orderId e status, sem reason', async (status) => {
    const orderId = await insertOrder(status);

    const res = await request(app).get(`/orders/${orderId}/status`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ orderId, status });
    expect(res.body).not.toHaveProperty('reason');
    expect(OrderStatus.parse(res.body)).toEqual({ orderId, status });
    expectMatchesContract(statusRoute, res);
  });

  it.each(['erp_rejected', 'erp_out_of_stock', 'cancelled'] as const)(
    'CHK-11 um pedido failed com o motivo %s responde 200 com o reason',
    async (reason) => {
      const orderId = await insertOrder('failed', reason);

      const res = await request(app).get(`/orders/${orderId}/status`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).toEqual({ orderId, status: 'failed', reason });
      expectMatchesContract(statusRoute, res);
    },
  );

  it('CHK-11 o status acompanha a mudança do pedido no banco', async () => {
    const orderId = await insertOrder('pending');
    const before = await request(app).get(`/orders/${orderId}/status`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ orderId, status: 'pending' });

    await database.pool.query("update orders set status = 'invoiced', outcome_at = now() where id = $1", [orderId]);
    const after = await request(app).get(`/orders/${orderId}/status`);

    expect(after.status).toBe(200);
    expect(after.body).toEqual({ orderId, status: 'invoiced' });
    expectMatchesContract(statusRoute, after);
  });

  it('CHK-11 um UUID válido que não existe responde 404 em problem+json com a causa not-found', async () => {
    const orderId = randomUUID();

    const res = await request(app).get(`/orders/${orderId}/status`);

    expect(res.status).toBe(404);
    expect((res.headers['content-type'] as string).split(';')[0]).toBe(PROBLEM_MEDIA_TYPE);
    expectMatchesContract(statusRoute, res);
    const problem = Problem.parse(res.body);
    expect(problem.status).toBe(404);
    expect(problem.type).toBe('/problems/not-found');
    expect(problem.correlationId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toContain(orderId);
  });

  it.each([
    ['texto livre', 'abc'],
    ['número', '123'],
    ['UUID sem hífens', randomUUID().replaceAll('-', '')],
  ])('CHK-11 o identificador %s fora do formato UUID responde 400 com params.orderId em errors', async (_label, orderId) => {
    const res = await request(app).get(`/orders/${orderId}/status`);

    expect(res.status).toBe(400);
    expect((res.headers['content-type'] as string).split(';')[0]).toBe(PROBLEM_MEDIA_TYPE);
    expectMatchesContract(statusRoute, res);
    const problem = Problem.parse(res.body);
    expect(problem.status).toBe(400);
    expect(problem.type).toBe('/problems/invalid-request');
    expect(problem.errors?.map((error) => error.path)).toContain('params.orderId');
    expect(problem.correlationId).toBe(res.headers['x-request-id']);
  });

  it('CHK-11 um parâmetro de query desconhecido responde 400 mesmo para um pedido existente', async () => {
    const orderId = await insertOrder('pending');

    const res = await request(app).get(`/orders/${orderId}/status`).query({ verbose: 'true' });

    expect(res.status).toBe(400);
    expect((res.headers['content-type'] as string).split(';')[0]).toBe(PROBLEM_MEDIA_TYPE);
    expectMatchesContract(statusRoute, res);
    const problem = Problem.parse(res.body);
    expect(problem.type).toBe('/problems/invalid-request');
    expect(problem.errors?.map((error) => error.path)).toContain('query.verbose');
  });
});

describe('CHK-11 X-Request-Id nas respostas do status', () => {
  it('CHK-11 o 200 devolve o X-Request-Id enviado', async () => {
    const orderId = await insertOrder('pending');

    const res = await request(app).get(`/orders/${orderId}/status`).set('X-Request-Id', 'status-200');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('status-200');
  });

  it('CHK-11 o 404 devolve o X-Request-Id enviado, também no correlationId', async () => {
    const res = await request(app).get(`/orders/${randomUUID()}/status`).set('X-Request-Id', 'status-404');

    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('status-404');
    expect(Problem.parse(res.body).correlationId).toBe('status-404');
  });

  it('CHK-11 o 400 devolve o X-Request-Id enviado, também no correlationId', async () => {
    const res = await request(app).get('/orders/abc/status').set('X-Request-Id', 'status-400');

    expect(res.status).toBe(400);
    expect(res.headers['x-request-id']).toBe('status-400');
    expect(Problem.parse(res.body).correlationId).toBe('status-400');
  });

  it('CHK-11 sem X-Request-Id a API gera um UUID e o devolve no 200', async () => {
    const orderId = await insertOrder('invoiced');

    const res = await request(app).get(`/orders/${orderId}/status`);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});

describe('OBS-01 orderId no log do status', () => {
  it('OBS-01 o log http_request da consulta a um pedido existente traz o orderId', async () => {
    const orderId = await insertOrder('pending');
    const correlationId = `obs01-${randomUUID()}`;

    const res = await request(app).get(`/orders/${orderId}/status`).set('X-Request-Id', correlationId);
    expect(res.status).toBe(200);

    // O log sai no fim da resposta, que pode correr um instante depois de o cliente ler o corpo.
    await vi.waitFor(() => {
      const entry = logLines.find((line) => line['event'] === 'http_request' && line['correlationId'] === correlationId);
      expect(entry).toBeDefined();
      expect(entry?.['orderId']).toBe(orderId);
      expect(entry?.['status']).toBe(200);
      expect(entry?.['route']).toBe('/orders/{orderId}/status');
    });
  });

  it('OBS-01 o orderId do log é o do pedido consultado, não o de outro', async () => {
    const first = await insertOrder('pending');
    const second = await insertOrder('failed', 'cancelled');
    const firstCorrelation = `obs01-a-${randomUUID()}`;
    const secondCorrelation = `obs01-b-${randomUUID()}`;

    await request(app).get(`/orders/${first}/status`).set('X-Request-Id', firstCorrelation);
    await request(app).get(`/orders/${second}/status`).set('X-Request-Id', secondCorrelation);

    await vi.waitFor(() => {
      const byCorrelation = (id: string) => logLines.find((line) => line['event'] === 'http_request' && line['correlationId'] === id);
      expect(byCorrelation(firstCorrelation)?.['orderId']).toBe(first);
      expect(byCorrelation(secondCorrelation)?.['orderId']).toBe(second);
    });
  });
});
