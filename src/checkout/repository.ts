import { createHash } from 'node:crypto';
import { context, SpanKind, type TextMapSetter } from '@opentelemetry/api';
import type { Kysely, Transaction } from 'kysely';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { CheckoutAccepted, CheckoutRequest } from '../contract/index.ts';
import { createDb, runInTransaction, type StoreDb } from '../db/database.ts';
import { isUnavailable } from '../db/unavailable.ts';
import { databaseUnavailableProblem, ProblemError } from '../http/problem.ts';
import { propagator, type Telemetry } from '../shared/telemetry.ts';

export interface CheckoutResult extends CheckoutAccepted {
  // 'replay' quando a chave já tinha um pedido; o status é o atual dele.
  kind: 'accepted' | 'replay';
}

export interface CheckoutInput {
  idempotencyKey: string;
  correlationId: string;
  request: CheckoutRequest;
}

export interface CheckoutRepository {
  create(input: CheckoutInput): Promise<CheckoutResult>;
}

const carrierSetter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => void (carrier[key] = value),
};

// Sinal interno: desfaz a transação inteira (inclusive o pedido e a chave) e leva o
// motivo para fora, sem tratar a recusa de negócio como falha do span.
class Rollback extends Error {
  readonly outcome: ProblemError | CheckoutResult;
  constructor(outcome: ProblemError | CheckoutResult) {
    super('transação desfeita de propósito');
    this.outcome = outcome;
  }
}

// O que a transação precisa saber do pedido: os itens em ordem de SKU e o hash deles.
interface Plan {
  input: CheckoutInput;
  items: CheckoutRequest['items'];
  hash: string;
}

// O passo em andamento decide o que um 55P03 significa.
interface Progress {
  step: 'key' | 'rest';
}

interface PricedItem {
  sku: string;
  quantity: number;
  unitPrice: number;
}

// O mesmo pedido escrito de outro jeito tem o mesmo hash: itens em ordem de SKU e
// chaves de cada item em ordem alfabética.
function payloadHash(items: CheckoutRequest['items']): string {
  const canonical = items.map((item) => ({
    expectedUnitPrice: item.expectedUnitPrice,
    quantity: item.quantity,
    sku: item.sku,
  }));
  return createHash('sha256')
    .update(JSON.stringify({ items: canonical }))
    .digest('hex');
}

function compareSku(a: { sku: string }, b: { sku: string }): number {
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

function problem(
  status: number,
  cause: string,
  title: string,
  extra: Partial<ConstructorParameters<typeof ProblemError>[0]> = {},
): ProblemError {
  return new ProblemError({ status, cause, title, ...extra });
}

// 1. Chave. Uma concorrente com a mesma chave espera aqui no índice único. Ela aponta para o
// pedido (FK), então o pedido nasce antes dela; se a chave já existir, a transação é desfeita e
// esse pedido some junto.
async function insertKey(
  trx: Transaction<StoreDb>,
  { input, hash }: Plan,
  orderId: string,
): Promise<boolean> {
  const inserted = await trx
    .insertInto('idempotency_keys')
    .values({
      key: input.idempotencyKey,
      payload_hash: hash,
      order_id: orderId,
    })
    .onConflict((oc) => oc.column('key').doNothing())
    .returning('key')
    .executeTakeFirst();
  return inserted !== undefined;
}

// A chave já existia: o mesmo corpo repete o pedido, outro corpo é recusado.
async function rollbackForExistingKey(
  trx: Transaction<StoreDb>,
  { input, hash }: Plan,
): Promise<never> {
  const existing = await trx
    .selectFrom('idempotency_keys')
    .innerJoin('orders', 'orders.id', 'idempotency_keys.order_id')
    .select(['idempotency_keys.payload_hash', 'orders.id', 'orders.status'])
    .where('idempotency_keys.key', '=', input.idempotencyKey)
    .executeTakeFirstOrThrow();
  if (existing.payload_hash !== hash) {
    throw new Rollback(
      problem(
        422,
        'idempotency-key-reused',
        'Idempotency-Key já usada com outro corpo',
      ),
    );
  }
  const rows = await trx
    .selectFrom('order_items')
    .select(['quantity', 'unit_price_cents'])
    .where('order_id', '=', existing.id)
    .execute();
  const total = rows.reduce(
    (sum, row) => sum + row.quantity * row.unit_price_cents,
    0,
  );
  throw new Rollback({
    kind: 'replay',
    orderId: existing.id,
    status: existing.status as CheckoutAccepted['status'],
    total,
  });
}

// 2. Preços do banco; o que o cliente viu só serve para avisá-lo.
async function priceItems(
  trx: Transaction<StoreDb>,
  items: CheckoutRequest['items'],
): Promise<PricedItem[]> {
  const products = await trx
    .selectFrom('products')
    .select(['sku', 'price_cents'])
    .where(
      'sku',
      'in',
      items.map((item) => item.sku),
    )
    .execute();
  const priceBySku = new Map(products.map((row) => [row.sku, row.price_cents]));
  if (items.some((item) => !priceBySku.has(item.sku))) {
    throw new Rollback(problem(422, 'unknown-sku', 'SKU inexistente'));
  }
  const changed = items
    .filter((item) => priceBySku.get(item.sku) !== item.expectedUnitPrice)
    .map((item) => ({
      sku: item.sku,
      unitPrice: priceBySku.get(item.sku) as number,
    }));
  if (changed.length > 0) {
    throw new Rollback(
      problem(409, 'price-changed', 'Preço alterado', {
        currentPrices: changed,
      }),
    );
  }
  return items.map((item) => ({
    sku: item.sku,
    quantity: item.quantity,
    unitPrice: priceBySku.get(item.sku) as number,
  }));
}

// 4. Mensagem de saída: o worker continua o trace da requisição.
async function insertOutbox(
  trx: Transaction<StoreDb>,
  orderId: string,
  correlationId: string,
): Promise<void> {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, carrierSetter);
  await trx
    .insertInto('outbox')
    .values({
      order_id: orderId,
      correlation_id: correlationId,
      traceparent: carrier['traceparent'] ?? null,
    })
    .execute();
}

// 5. Reserva por último, um UPDATE por SKU em ordem de SKU: a mesma ordem de lock em todo
// pedido evita deadlock.
async function reserveStock(
  trx: Transaction<StoreDb>,
  priced: PricedItem[],
): Promise<void> {
  for (const item of priced) {
    const result = await trx
      .updateTable('inventory')
      .set({ reserved: (eb) => eb('reserved', '+', item.quantity) })
      .where('sku', '=', item.sku)
      .where((eb) =>
        eb(eb('on_hand', '-', eb.ref('reserved')), '>=', item.quantity),
      )
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new Rollback(
        problem(409, 'out-of-stock', 'Sem estoque suficiente'),
      );
    }
  }
}

async function placeOrder(
  trx: Transaction<StoreDb>,
  plan: Plan,
  progress: Progress,
): Promise<CheckoutResult> {
  const order = await trx
    .insertInto('orders')
    .defaultValues()
    .returning('id')
    .executeTakeFirstOrThrow();
  const inserted = await insertKey(trx, plan, order.id);
  progress.step = 'rest';
  if (!inserted) return rollbackForExistingKey(trx, plan);

  const priced = await priceItems(trx, plan.items);
  // 3. Itens, com o preço do banco.
  await trx
    .insertInto('order_items')
    .values(
      priced.map((item) => ({
        order_id: order.id,
        sku: item.sku,
        quantity: item.quantity,
        unit_price_cents: item.unitPrice,
      })),
    )
    .execute();
  await insertOutbox(trx, order.id, plan.input.correlationId);
  await reserveStock(trx, priced);

  const total = priced.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  return { kind: 'accepted', orderId: order.id, status: 'pending', total };
}

// A recusa de negócio sai como valor, não como exceção: o span só registra a falha de verdade.
function runInSpan(
  db: Kysely<StoreDb>,
  telemetry: Telemetry,
  plan: Plan,
  progress: Progress,
): Promise<ProblemError | CheckoutResult> {
  return telemetry.withSpan(
    'checkout.create',
    { kind: SpanKind.CLIENT, attributes: { 'db.system.name': 'postgresql' } },
    async () => {
      try {
        return await runInTransaction(db, (trx) =>
          placeOrder(trx, plan, progress),
        );
      } catch (error) {
        // O ROLLBACK já foi feito pelo invólucro; aqui só se separa recusa de falha.
        if (error instanceof Rollback) return error.outcome;
        throw error;
      }
    },
  );
}

// Falha do banco vira 409 (chave em andamento) ou 503; devolve undefined para o que não é do banco.
function databaseProblem(
  error: unknown,
  progress: Progress,
  logger: Logger,
): ProblemError | undefined {
  if (!isUnavailable(error)) return undefined;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '55P03' && progress.step === 'key') {
    return problem(
      409,
      'idempotency-key-in-progress',
      'Esta Idempotency-Key ainda está em andamento',
    );
  }
  logger.warn(
    { event: 'checkout.db_unavailable', err: error, step: progress.step },
    'o banco não atendeu o checkout',
  );
  return databaseUnavailableProblem();
}

async function createCheckout(
  db: Kysely<StoreDb>,
  telemetry: Telemetry,
  logger: Logger,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const items = [...input.request.items].sort(compareSku);
  const plan: Plan = { input, items, hash: payloadHash(items) };
  const progress: Progress = { step: 'key' };

  try {
    const outcome = await runInSpan(db, telemetry, plan, progress);
    if (outcome instanceof ProblemError) throw outcome;
    return outcome;
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    const mapped = databaseProblem(error, progress, logger);
    if (mapped) throw mapped;
    throw error;
  }
}

export function createCheckoutRepository(
  pool: Pool,
  telemetry: Telemetry,
  logger: Logger,
): CheckoutRepository {
  const db = createDb(pool);
  return { create: (input) => createCheckout(db, telemetry, logger, input) };
}
