import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.ts';
import { CorrelationId, HealthStatus, PROBLEM_MEDIA_TYPE, Problem } from '../../../src/contract/index.ts';
import { createTelemetry } from '../../../src/shared/telemetry.ts';
import { expectMatchesContract, findRoute } from '../../helpers/contract.ts';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const healthRoute = findRoute('get', '/health');

let database: TestDatabase;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  database = await startMigratedDatabase();
  app = createApp({
    pool: database.pool,
    logger: pino({ level: 'silent' }),
    telemetry: createTelemetry({ spanExporter: new InMemorySpanExporter() }),
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('FND-03 requisição fora do contrato', () => {
  it('FND-03 GET /health com parâmetro de query desconhecido responde 400 em problem+json', async () => {
    const res = await request(app).get('/health').query({ verbose: 'true' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expectMatchesContract(healthRoute, res);

    const problem = Problem.parse(res.body);
    expect(problem.status).toBe(400);
    expect(problem.type).toBe('/problems/invalid-request');
    expect(problem.errors?.some((error) => error.path.includes('verbose'))).toBe(true);
  });

  it('FND-03 o correlationId do corpo do 400 é igual ao cabeçalho x-request-id', async () => {
    const res = await request(app).get('/health').query({ verbose: 'true' });

    const problem = Problem.parse(res.body);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(problem.correlationId).toBe(res.headers['x-request-id']);
  });

  it('FND-03 o 400 não expõe stack trace nem detalhe interno', async () => {
    const res = await request(app).get('/health').query({ verbose: 'true' });

    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(text).not.toMatch(/node_modules/);
    expect(res.body).not.toHaveProperty('stack');
  });

  it('FND-03 um X-Request-Id válido volta igual no cabeçalho e no correlationId do 400', async () => {
    const id = 'pedido-fnd03_ABC.123';
    const res = await request(app).get('/health').query({ verbose: 'true' }).set('X-Request-Id', id);

    expect(res.status).toBe(400);
    expect(res.headers['x-request-id']).toBe(id);
    expect(Problem.parse(res.body).correlationId).toBe(id);
    expectMatchesContract(healthRoute, res);
  });

  it('FND-03 um X-Request-Id de 128 caracteres, o limite, é aceito e volta igual', async () => {
    const id = 'a'.repeat(128);
    const res = await request(app).get('/health').set('X-Request-Id', id);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it.each([
    ['com espaço', 'tem espaco'],
    ['com 129 caracteres', 'a'.repeat(129)],
    ['com caractere não ASCII', 'id-ç'],
    ['vazio', ''],
  ])('FND-03 um X-Request-Id inválido (%s) é trocado por um UUID válido pelo CorrelationId', async (_label, sent) => {
    const res = await request(app).get('/health').query({ verbose: 'true' }).set('X-Request-Id', sent);

    expect(res.status).toBe(400);
    const returned = res.headers['x-request-id'] as string;
    expect(returned).not.toBe(sent);
    expect(CorrelationId.safeParse(returned).success).toBe(true);
    expect(returned).toMatch(UUID);
    expect(Problem.parse(res.body).correlationId).toBe(returned);
  });

  it('FND-03 sem X-Request-Id a API gera um UUID e o devolve no 200 e no 400', async () => {
    const ok = await request(app).get('/health');
    const bad = await request(app).get('/health').query({ verbose: 'true' });

    expect(ok.headers['x-request-id']).toMatch(UUID);
    expect(bad.headers['x-request-id']).toMatch(UUID);
    expect(ok.headers['x-request-id']).not.toBe(bad.headers['x-request-id']);
  });

  it('FND-03 o 200 do /health passa pelo schema da rota, com o x-request-id no cabeçalho', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'saude-1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(HealthStatus.parse(res.body)).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBe('saude-1');
    expectMatchesContract(healthRoute, res);
  });

  it('FND-03 o tipo de conteúdo do 400 é exatamente application/problem+json', async () => {
    const res = await request(app).get('/health').query({ outro: '1', mais: '2' });

    expect(res.status).toBe(400);
    expect((res.headers['content-type'] as string).split(';')[0]).toBe(PROBLEM_MEDIA_TYPE);
  });
});
