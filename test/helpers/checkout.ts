import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Writable } from 'node:stream';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { Express } from 'express';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../src/app.ts';
import { checkoutRoute } from '../../src/contract/index.ts';
import { LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from '../../src/db/pool.ts';
import { logContext } from '../../src/shared/logging.ts';
import { createTelemetry, type Telemetry } from '../../src/shared/telemetry.ts';
import { expectMatchesContract } from './contract.ts';
import type { TestDatabase } from './database.ts';

// Tamanho fixo do pool da API nos testes de concorrência, o mesmo de produção (design.md, "Parâmetros").
export const APP_POOL_SIZE = 10;

export interface PoolLimits {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

// Limites dos testes de concorrência (CHK-01, CHK-03, CHK-07). Eles medem atomicidade, unicidade e
// ausência de deadlock, não a latência da máquina: com a CPU sobrecarregada (testes unitários em
// paralelo, fsync lento no Docker), quem segura o lock demora a mandar o próximo comando e as
// 9 transações da fila estouravam o lock_timeout de 2 s, virando 503. O deadlock continua visível,
// porque o PostgreSQL o detecta pelo deadlock_timeout (1 s por padrão), muito antes destes limites.
// O statement_timeout também conta a espera por lock, então precisa ser maior que o lock_timeout.
// O CHK-08 não usa estes limites: ele prova justamente o corte de produção.
export const PATIENT_LOCK_TIMEOUT_MS = 30_000;
export const PATIENT_STATEMENT_TIMEOUT_MS = 60_000;
export const PATIENT_LIMITS: PoolLimits = {
  lockTimeoutMs: PATIENT_LOCK_TIMEOUT_MS,
  statementTimeoutMs: PATIENT_STATEMENT_TIMEOUT_MS,
};

// Pool da API como em produção (5 s de statement_timeout, 2 s de lock_timeout), exceto a espera
// por conexão: com 50 requisições sobre 10 conexões, a espera de 1 s de produção mediria a
// máquina de CI e não a atomicidade do checkout.
export function createAppPool(
  uri: string,
  max: number = APP_POOL_SIZE,
  limits: PoolLimits = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: uri,
    max,
    connectionTimeoutMillis: 15_000,
    statement_timeout: limits.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
    lock_timeout: limits.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
  });
  pool.on('error', () => undefined);
  return pool;
}

export interface CheckoutHarness {
  app: Express;
  // Servidor já escutando: 50 requisições simultâneas dividem um só listener.
  server: http.Server;
  pool: pg.Pool;
  telemetry: Telemetry;
  exporter: InMemorySpanExporter;
  logLines: Record<string, unknown>[];
  close(): Promise<void>;
}

// Monta o app como o main/api.ts, com o logger do mesmo formato (nível em texto e correlationId
// pelo AsyncLocalStorage) escrevendo em memória e os spans no exportador em memória.
export async function startCheckoutHarness(
  database: TestDatabase,
  poolSize: number = APP_POOL_SIZE,
  limits: PoolLimits = {},
): Promise<CheckoutHarness> {
  const logLines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '')
          logLines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const logger = pino(
    {
      level: 'info',
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const spanContext = trace.getActiveSpan()?.spanContext();
        return {
          correlationId: logContext.getStore()?.correlationId,
          trace_id: spanContext?.traceId,
          span_id: spanContext?.spanId,
        };
      },
    },
    sink,
  );
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry({ spanExporter: exporter });
  const pool = createAppPool(database.uri, poolSize, limits);
  const app = createApp({ pool, logger, telemetry });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    app,
    server,
    pool,
    telemetry,
    exporter,
    logLines,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await telemetry.shutdown();
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------- dados

export interface SeededProduct {
  sku: string;
  priceCents: number;
}

// Cada teste cria os próprios produtos, com SKU único, direto nas tabelas.
export async function seedProduct(
  pool: pg.Pool,
  options: {
    priceCents: number;
    onHand: number;
    reserved?: number;
    prefix?: string;
  },
): Promise<SeededProduct> {
  const sku = `${options.prefix ?? 'T'}-${randomUUID().slice(0, 12)}`;
  await pool.query(
    'insert into products (sku, name, price_cents) values ($1, $2, $3)',
    [sku, `Capinha ${sku}`, options.priceCents],
  );
  await pool.query(
    'insert into inventory (sku, on_hand, reserved) values ($1, $2, $3)',
    [sku, options.onHand, options.reserved ?? 0],
  );
  return { sku, priceCents: options.priceCents };
}

export interface InventorySnapshot {
  onHand: number;
  reserved: number;
  soldTotal: number;
}

export async function readInventory(
  pool: pg.Pool,
  sku: string,
): Promise<InventorySnapshot> {
  const result = await pool.query<{
    on_hand: number;
    reserved: number;
    sold_total: number;
  }>('select on_hand, reserved, sold_total from inventory where sku = $1', [
    sku,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`estoque inexistente para ${sku}`);
  return {
    onHand: row.on_hand,
    reserved: row.reserved,
    soldTotal: row.sold_total,
  };
}

// A invariante do estoque (AD-002): nenhuma promessa acima do que há. Lista as violações, para o
// teste do checkout exigir a lista vazia e o controle negativo exigir uma lista com itens.
export function stockViolations(snapshot: InventorySnapshot): string[] {
  const violations: string[] = [];
  if (snapshot.reserved < 0)
    violations.push(`reserved negativo (${snapshot.reserved})`);
  if (snapshot.onHand - snapshot.reserved < 0) {
    violations.push(
      `promessa acima do estoque: reserved ${snapshot.reserved} > on_hand ${snapshot.onHand}`,
    );
  }
  return violations;
}

async function count(
  pool: pg.Pool,
  text: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await pool.query<{ n: number }>(text, values);
  return result.rows[0]?.n ?? 0;
}

// Pedidos distintos que têm o SKU.
export function countOrdersWithSku(
  pool: pg.Pool,
  sku: string,
): Promise<number> {
  return count(
    pool,
    'select count(distinct order_id)::int as n from order_items where sku = $1',
    [sku],
  );
}

// Mensagens da outbox dos pedidos que têm o SKU.
export function countOutboxWithSku(
  pool: pg.Pool,
  sku: string,
): Promise<number> {
  return count(
    pool,
    'select count(*)::int as n from outbox where order_id in (select order_id from order_items where sku = $1)',
    [sku],
  );
}

export function countKeyRows(pool: pg.Pool, key: string): Promise<number> {
  return count(
    pool,
    'select count(*)::int as n from idempotency_keys where key = $1',
    [key],
  );
}

// Tudo o que um checkout deixa no banco, em contagens globais: o arquivo roda um teste por vez,
// então "antes e depois iguais" prova que uma requisição recusada não deixou nada.
export interface Footprint {
  orders: number;
  orderItems: number;
  outbox: number;
  keys: number;
  reserved: number;
}

export async function footprint(pool: pg.Pool): Promise<Footprint> {
  return {
    orders: await count(pool, 'select count(*)::int as n from orders'),
    orderItems: await count(pool, 'select count(*)::int as n from order_items'),
    outbox: await count(pool, 'select count(*)::int as n from outbox'),
    keys: await count(pool, 'select count(*)::int as n from idempotency_keys'),
    reserved: await count(
      pool,
      'select coalesce(sum(reserved), 0)::int as n from inventory',
    ),
  };
}

// ---------------------------------------------------------------- requisições

export interface CheckoutLine {
  sku: string;
  quantity: number;
  expectedUnitPrice: number;
}

export function line(
  product: SeededProduct,
  quantity = 1,
  expectedUnitPrice: number = product.priceCents,
): CheckoutLine {
  return { sku: product.sku, quantity, expectedUnitPrice };
}

export function checkoutBody(...lines: CheckoutLine[]): {
  items: CheckoutLine[];
} {
  return { items: lines };
}

export function newKey(): string {
  return `key-${randomUUID()}`;
}

export type CheckoutTarget = http.Server | Express;

export interface PostOptions {
  // `undefined` gera uma chave nova; `null` omite o cabeçalho.
  key?: string | null;
  requestId?: string;
  traceparent?: string;
  contentType?: string;
}

// Envia o POST /checkout e confere o status, o tipo de conteúdo, o corpo e os cabeçalhos da
// resposta pelo schema da rota no contrato (FND-07), seja um 202 ou um erro.
export async function postCheckout(
  target: CheckoutTarget,
  body: unknown,
  options: PostOptions = {},
): Promise<request.Response> {
  const req = request(target).post('/checkout');
  const key = options.key === undefined ? newKey() : options.key;
  if (key !== null) req.set('Idempotency-Key', key);
  if (options.requestId !== undefined)
    req.set('X-Request-Id', options.requestId);
  if (options.traceparent !== undefined)
    req.set('traceparent', options.traceparent);
  if (options.contentType !== undefined)
    req.set('Content-Type', options.contentType);
  const res = await req.send(body as string | object);
  expectMatchesContract(checkoutRoute, res);
  return res;
}

export function header(
  res: request.Response,
  name: string,
): string | undefined {
  const value: string | undefined = res.headers[name.toLowerCase()];
  return value;
}

export function mediaTypeOf(res: request.Response): string {
  return (header(res, 'content-type') ?? '').split(';')[0] ?? '';
}
