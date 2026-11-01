import { SpanKind } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.ts';
import { createTelemetry } from '../../../src/shared/telemetry.ts';
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
