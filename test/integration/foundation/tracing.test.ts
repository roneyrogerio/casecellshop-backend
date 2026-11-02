import { SpanKind } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { createServer, request as httpRequest } from 'node:http';
import type { Pool } from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.ts';
import { createTelemetry } from '../../../src/shared/telemetry.ts';
import { findRoute } from '../../helpers/contract.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';

let database: TestDatabase;
let app: ReturnType<typeof createApp>;
let telemetry: ReturnType<typeof createTelemetry>;
const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  database = await startMigratedDatabase();
  telemetry = createTelemetry({ spanExporter: exporter });
  app = createApp({
    pool: database.pool,
    logger: pino({ level: 'silent' }),
    telemetry,
  });
}, 120_000);

afterAll(async () => {
  await telemetry?.shutdown();
  await database?.stop();
});

beforeEach(async () => {
  await telemetry.forceFlush();
  exporter.reset();
});

async function finishedSpans(): Promise<ReadableSpan[]> {
  // O processador pode exportar em lote; sem o flush o teste leria spans a menos.
  await telemetry.forceFlush();
  return exporter.getFinishedSpans();
}

// Envia um método qualquer por uma conexão HTTP de verdade: o supertest só tipa os métodos comuns, e o Node
// aceita métodos como PROPFIND, que o Express recebe e a convenção trata como fora da lista (`_OTHER`).
async function sendWithMethod(method: string, path: string): Promise<number> {
  const server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  try {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('o servidor de teste não abriu uma porta');
    return await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port: address.port, method, path, agent: false },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve(incoming.statusCode ?? 0));
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function singleServerSpan(): Promise<ReadableSpan> {
  const servers = (await finishedSpans()).filter(
    (span) => span.kind === SpanKind.SERVER,
  );
  expect(servers, 'deveria haver um único span da requisição').toHaveLength(1);
  const [server] = servers;
  if (!server) throw new Error('span da requisição ausente');
  return server;
}

// A falha do banco na retirada da conexão: o /health responde 503 sem que o código mude.
function appWithUnavailableDatabase(): ReturnType<typeof createApp> {
  const brokenPool = {
    options: {},
    connect: () =>
      Promise.reject(new Error('Connection terminated unexpectedly')),
    on: () => undefined,
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return createApp({
    pool: brokenPool,
    logger: pino({ level: 'silent' }),
    telemetry,
  });
}

describe('OBS-07 span HTTP segue a convenção de spans HTTP do OpenTelemetry', () => {
  it('OBS-07 rota casada: o nome é "GET /health" e os atributos obrigatórios saem, sem error.type nem method_original', async () => {
    await request(app).get('/health').expect(200);

    const server = await singleServerSpan();
    expect(server.name).toBe('GET /health');
    expect(server.attributes['http.route']).toBe('/health');
    expect(server.attributes['http.request.method']).toBe('GET');
    expect(server.attributes['url.scheme']).toBe('http');
    expect(server.attributes['url.path']).toBe('/health');
    expect(server.attributes['http.response.status_code']).toBe(200);
    const keys = Object.keys(server.attributes);
    expect(keys).not.toContain('error.type');
    expect(keys).not.toContain('http.request.method_original');
  });

  it('OBS-07 caminho sem rota: o nome é só o método, sem a chave http.route, com url.path e status 404', async () => {
    await request(app).get('/nao-existe').expect(404);

    const server = await singleServerSpan();
    expect(server.name).toBe('GET');
    expect(Object.keys(server.attributes)).not.toContain('http.route');
    expect(server.attributes['url.path']).toBe('/nao-existe');
    expect(server.attributes['http.request.method']).toBe('GET');
    expect(server.attributes['http.response.status_code']).toBe(404);
    expect(Object.keys(server.attributes)).not.toContain('error.type');
  });

  it('OBS-07 url.path sai sem a query string', async () => {
    // O contrato recusa query desconhecida (400); o status não importa aqui, só o caminho gravado no span.
    await request(app).get('/health?x=1&y=dois');

    const server = await singleServerSpan();
    expect(server.attributes['url.path']).toBe('/health');
    expect(server.name).toBe('GET /health');
  });

  it('OBS-07 método fora da lista: o nome é HTTP, http.request.method é _OTHER e o original vai em http.request.method_original', async () => {
    const status = await sendWithMethod('PROPFIND', '/health');
    expect(status).toBe(404);

    const server = await singleServerSpan();
    expect(server.name).toBe('HTTP');
    expect(server.attributes['http.request.method']).toBe('_OTHER');
    expect(server.attributes['http.request.method_original']).toBe('PROPFIND');
    expect(server.attributes['url.path']).toBe('/health');
    expect(server.attributes['http.response.status_code']).toBe(404);
  });

  it('OBS-07 resposta 5xx: error.type traz o código como texto, igual à métrica, e o nome segue com a rota', async () => {
    const res = await request(appWithUnavailableDatabase()).get('/health');
    expect(res.status).toBe(503);

    const server = await singleServerSpan();
    expect(server.name).toBe('GET /health');
    expect(server.attributes['http.response.status_code']).toBe(503);
    expect(server.attributes['error.type']).toBe('503');
    expect(server.attributes['http.route']).toBe('/health');
  });

  it('OBS-07 resposta 4xx com rota casada: sem error.type, com o template do contrato em http.route', async () => {
    const res = await request(app).get('/orders/nao-e-uuid/status');
    expect(res.status).toBe(400);

    const template = findRoute('get', '/orders/{orderId}/status').path;
    const server = await singleServerSpan();
    expect(server.name).toBe(`GET ${template}`);
    expect(server.attributes['http.route']).toBe(template);
    expect(server.attributes['url.path']).toBe('/orders/nao-e-uuid/status');
    expect(server.attributes['http.response.status_code']).toBe(400);
    expect(Object.keys(server.attributes)).not.toContain('error.type');
  });
});

describe('FND-05 span do repositório filho do span da requisição', () => {
  it('FND-05 o span do repositório sai como filho do span da requisição no GET /health', async () => {
    await request(app).get('/health').expect(200);

    const spans = await finishedSpans();
    const server = spans.find((span) => span.name === 'GET /health');
    const repository = spans.find((span) => span.name === 'health.ping');
    expect(server, 'span da requisição ausente').toBeDefined();
    expect(repository, 'span do repositório ausente').toBeDefined();

    expect(repository?.parentSpanContext?.spanId).toBe(
      server?.spanContext().spanId,
    );
    expect(repository?.spanContext().traceId).toBe(
      server?.spanContext().traceId,
    );
  });

  it('FND-05 o span da requisição é SERVER, com http.route igual ao template da rota', async () => {
    await request(app).get('/health').expect(200);

    const server = (await finishedSpans()).find(
      (span) => span.name === 'GET /health',
    );
    expect(server?.kind).toBe(SpanKind.SERVER);
    expect(server?.attributes['http.route']).toBe('/health');
    expect(server?.parentSpanContext).toBeUndefined();
  });

  it('FND-05 o span do repositório é CLIENT, com db.system.name igual a postgresql', async () => {
    await request(app).get('/health').expect(200);

    const repository = (await finishedSpans()).find(
      (span) => span.name === 'health.ping',
    );
    expect(repository?.kind).toBe(SpanKind.CLIENT);
    expect(repository?.attributes['db.system.name']).toBe('postgresql');
  });

  it('FND-05 requisições simultâneas não misturam contexto: cada span do repositório é filho do próprio span da requisição', async () => {
    const total = 5;
    const responses = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        request(app).get('/health').set('X-Request-Id', `trace-${index}`),
      ),
    );
    for (const res of responses) expect(res.status).toBe(200);

    const spans = await finishedSpans();
    const servers = spans.filter((span) => span.name === 'GET /health');
    const repositories = spans.filter((span) => span.name === 'health.ping');
    expect(servers).toHaveLength(total);
    expect(repositories).toHaveLength(total);

    const parentIds = repositories.map(
      (span) => span.parentSpanContext?.spanId,
    );
    const serverIds = servers.map((span) => span.spanContext().spanId);
    expect(new Set(parentIds).size).toBe(total);
    for (const parentId of parentIds) expect(serverIds).toContain(parentId);
    for (const repository of repositories) {
      const parent = servers.find(
        (span) =>
          span.spanContext().spanId === repository.parentSpanContext?.spanId,
      );
      expect(parent?.spanContext().traceId).toBe(
        repository.spanContext().traceId,
      );
    }
  });
});
