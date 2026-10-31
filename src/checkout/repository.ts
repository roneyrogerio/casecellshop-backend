import { createHash } from 'node:crypto';
import { context, SpanKind, type TextMapSetter } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { CheckoutAccepted, CheckoutRequest } from '../contract/index.ts';
import { createDb, runInTransaction } from '../db/database.ts';
import { isUnavailable } from '../db/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { Telemetry } from '../shared/telemetry.ts';

export interface CheckoutResult extends CheckoutAccepted {
  // 'replay' quando a chave já tinha um pedido; o status é o atual dele.
  kind: 'accepted' | 'replay';
}

export interface CheckoutRepository {
  create(input: { idempotencyKey: string; correlationId: string; request: CheckoutRequest }): Promise<CheckoutResult>;
}

// Segundos até o cliente tentar de novo depois de o banco não responder.
const UNAVAILABLE_RETRY_AFTER_SECONDS = '5';

const propagator = new W3CTraceContextPropagator();
const carrierSetter: TextMapSetter<Record<string, string>> = { set: (carrier, key, value) => void (carrier[key] = value) };

// Sinal interno: desfaz a transação inteira (inclusive o pedido e a chave) e leva o
// motivo para fora, sem tratar a recusa de negócio como falha do span.
class Rollback extends Error {
  readonly outcome: ProblemError | CheckoutResult;
  constructor(outcome: ProblemError | CheckoutResult) {
    super('transação desfeita de propósito');
    this.outcome = outcome;
  }
}

// O mesmo pedido escrito de outro jeito tem o mesmo hash: itens em ordem de SKU e
// chaves de cada item em ordem alfabética.
function payloadHash(items: CheckoutRequest['items']): string {
  const canonical = items.map((item) => ({ expectedUnitPrice: item.expectedUnitPrice, quantity: item.quantity, sku: item.sku }));
  return createHash('sha256').update(JSON.stringify({ items: canonical })).digest('hex');
}

function compareSku(a: { sku: string }, b: { sku: string }): number {
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

function problem(status: number, cause: string, title: string, extra: Partial<ConstructorParameters<typeof ProblemError>[0]> = {}): ProblemError {
  return new ProblemError({ status, cause, title, ...extra });
}

function unavailable(): ProblemError {
  return problem(503, 'service-unavailable', 'Banco indisponível', { headers: { 'Retry-After': UNAVAILABLE_RETRY_AFTER_SECONDS } });
}

export function createCheckoutRepository(pool: Pool, telemetry: Telemetry, logger: Logger): CheckoutRepository {
  const db = createDb(pool);

  return {
    async create({ idempotencyKey, correlationId, request }) {
      const items = [...request.items].sort(compareSku);
      const hash = payloadHash(items);
      // O passo em andamento decide o que um 55P03 significa.
      let step: 'key' | 'rest' = 'key';

      try {
        return await telemetry.withSpan(
          'checkout.create',
          { kind: SpanKind.CLIENT, attributes: { 'db.system.name': 'postgresql' } },
          async () => {
            try {
              return await runInTransaction(db, async (trx): Promise<CheckoutResult> => {
                // A chave aponta para o pedido (FK), então o pedido nasce antes dela. Se a chave já
                // existir, a transação é desfeita e esse pedido some junto.
                const order = await trx.insertInto('orders').defaultValues().returning('id').executeTakeFirstOrThrow();

                // 1. Chave. Uma concorrente com a mesma chave espera aqui no índice único.
                const inserted = await trx
                  .insertInto('idempotency_keys')
                  .values({ key: idempotencyKey, payload_hash: hash, order_id: order.id })
                  .onConflict((oc) => oc.column('key').doNothing())
                  .returning('key')
                  .executeTakeFirst();
                step = 'rest';

                if (!inserted) {
                  const existing = await trx
                    .selectFrom('idempotency_keys')
                    .innerJoin('orders', 'orders.id', 'idempotency_keys.order_id')
                    .select(['idempotency_keys.payload_hash', 'orders.id', 'orders.status'])
                    .where('idempotency_keys.key', '=', idempotencyKey)
                    .executeTakeFirstOrThrow();
                  if (existing.payload_hash !== hash) {
                    throw new Rollback(problem(422, 'idempotency-key-reused', 'Idempotency-Key já usada com outro corpo'));
                  }
                  const rows = await trx.selectFrom('order_items').select(['quantity', 'unit_price_cents']).where('order_id', '=', existing.id).execute();
                  const total = rows.reduce((sum, row) => sum + row.quantity * row.unit_price_cents, 0);
                  throw new Rollback({ kind: 'replay', orderId: existing.id, status: existing.status as CheckoutAccepted['status'], total });
                }

                // 2. Preços do banco; o que o cliente viu só serve para avisá-lo.
                const products = await trx
                  .selectFrom('products')
                  .select(['sku', 'price_cents'])
                  .where('sku', 'in', items.map((item) => item.sku))
                  .execute();
                const priceBySku = new Map(products.map((row) => [row.sku, row.price_cents]));
                if (items.some((item) => !priceBySku.has(item.sku))) {
                  throw new Rollback(problem(422, 'unknown-sku', 'SKU inexistente'));
                }
                const changed = items
                  .filter((item) => priceBySku.get(item.sku) !== item.expectedUnitPrice)
                  .map((item) => ({ sku: item.sku, unitPrice: priceBySku.get(item.sku) as number }));
                if (changed.length > 0) {
                  throw new Rollback(problem(409, 'price-changed', 'Preço alterado', { currentPrices: changed }));
                }

                // 3. Itens, com o preço do banco.
                const priced = items.map((item) => ({ ...item, unitPrice: priceBySku.get(item.sku) as number }));
                await trx
                  .insertInto('order_items')
                  .values(priced.map((item) => ({ order_id: order.id, sku: item.sku, quantity: item.quantity, unit_price_cents: item.unitPrice })))
                  .execute();

                // 4. Mensagem de saída: o worker continua o trace da requisição.
                const carrier: Record<string, string> = {};
                propagator.inject(context.active(), carrier, carrierSetter);
                await trx
                  .insertInto('outbox')
                  .values({ order_id: order.id, correlation_id: correlationId, traceparent: carrier['traceparent'] ?? null })
                  .execute();

                // 5. Reserva por último, um UPDATE por SKU em ordem de SKU: a mesma ordem de lock em todo
                // pedido evita deadlock.
                for (const item of priced) {
                  const result = await trx
                    .updateTable('inventory')
                    .set({ reserved: (eb) => eb('reserved', '+', item.quantity) })
                    .where('sku', '=', item.sku)
                    .where((eb) => eb(eb('on_hand', '-', eb.ref('reserved')), '>=', item.quantity))
                    .executeTakeFirst();
                  if (result.numUpdatedRows === 0n) {
                    throw new Rollback(problem(409, 'out-of-stock', 'Sem estoque suficiente'));
                  }
                }

                const total = priced.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
                return { kind: 'accepted', orderId: order.id, status: 'pending', total };
              });
            } catch (error) {
              // O ROLLBACK já foi feito pelo invólucro; aqui só se separa recusa de falha.
              if (error instanceof Rollback) return error.outcome;
              throw error;
            }
          },
        ).then((outcome) => {
          if (outcome instanceof ProblemError) throw outcome;
          return outcome;
        });
      } catch (error) {
        if (error instanceof ProblemError) throw error;
        if (isUnavailable(error)) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === '55P03' && step === 'key') {
            throw problem(409, 'idempotency-key-in-progress', 'Esta Idempotency-Key ainda está em andamento');
          }
          logger.warn({ event: 'checkout.db_unavailable', err: error, step }, 'o banco não atendeu o checkout');
          throw unavailable();
        }
        throw error;
      }
    },
  };
}
