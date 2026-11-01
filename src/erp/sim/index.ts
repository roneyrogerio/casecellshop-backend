import type { Kysely, Transaction } from 'kysely';
import type { Pool } from 'pg';
import type { Clock } from '../../shared/clock.ts';
import {
  createErpDb,
  runInTransaction,
  type ErpSimDb,
} from '../../db/database.ts';
import type {
  ErpCatalogItem,
  ErpOrderItem,
  ErpOrderRequest,
} from '../erp-client.ts';
import {
  ErpNetworkError,
  type ErpRequest,
  type ErpResponse,
  type ErpTransport,
} from '../transport.ts';

const CATALOG_PAGE_SIZE = 50;

export interface SimulatedErpOptions {
  pool: Pool;
  // Atrasos do roteiro (lento, fatura adiada) correm neste relógio, fora de transação.
  clock: Clock;
  // Sem a H1b, cada criação vira uma fatura nova, mesmo com a referência repetida.
  withoutH1b?: boolean;
}

export type ErpSimOperation = ErpRequest['op'];

// Cada comportamento vale para uma chamada só (design.md, "Roteiro do ERP simulado").
export type ErpSimBehavior =
  | { mode: 'normal' }
  | { mode: 'slow'; delayMs: number }
  | { mode: 'unavailable' }
  | { mode: 'reject' }
  | { mode: 'status'; status: number; body?: unknown }
  | { mode: 'invoice_no_response' }
  | { mode: 'invoice_after'; delayMs: number }
  | { mode: 'fast_502_then_invoice'; delayMs: number }
  | { mode: 'hang' };

export interface ErpSimMatch {
  op?: ErpSimOperation;
  // Só na criação e na consulta, que têm referência.
  reference?: string;
}

export interface ErpSimScript {
  enqueue(behavior: ErpSimBehavior, match?: ErpSimMatch): void;
  // Vale quando nenhum comportamento da fila casa com a chamada; começa em `normal`.
  setDefault(behavior: ErpSimBehavior): void;
  // Espera as faturas adiadas cujo prazo o relógio já alcançou terminarem de gravar.
  drain(): Promise<void>;
}

export interface SimulatedErp {
  transport: ErpTransport;
  script: ErpSimScript;
}

// Aborta a transação de criação para desfazer a fatura e os itens já baixados; o
// invólucro devolve a conexão sã ao pool. Nunca sai deste módulo.
class InvoiceRefused extends Error {
  readonly code: 'out_of_stock' | 'unknown_product';
  readonly sku: string;

  constructor(code: 'out_of_stock' | 'unknown_product', sku: string) {
    super(`Fatura recusada pelo ERP simulado: ${code}`);
    this.code = code;
    this.sku = sku;
  }
}

// Tudo o que as funções do simulador compartilham; vive só enquanto o simulador vive.
interface Sim {
  db: Kysely<ErpSimDb>;
  clock: Clock;
  withoutH1b: boolean;
  queue: { behavior: ErpSimBehavior; match: ErpSimMatch }[];
  defaultBehavior: ErpSimBehavior;
  // Gravações já iniciadas: o drain espera por elas, para o teste contar faturas sem sleep.
  writes: Set<Promise<unknown>>;
}

function orderFromRow(row: { id: string; reference: string }) {
  return { erpOrderId: row.id, reference: row.reference };
}

// O motivo do sinal, como o contrato do transporte manda; embrulha o que não for Error.
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Chamada ao ERP abortada');
}

function abortedPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener('abort', () => reject(abortReason(signal)), {
      once: true,
    });
  });
}

function trackWrite({ writes }: Sim, write: Promise<unknown>): void {
  // A gravação de uma chamada abortada não tem a quem reportar o erro.
  const tracked: Promise<unknown> = write
    .catch(() => undefined)
    .finally(() => {
      writes.delete(tracked);
    });
  writes.add(tracked);
}

function nextBehavior(sim: Sim, request: ErpRequest): ErpSimBehavior {
  const reference =
    request.op === 'createOrder'
      ? request.body.reference
      : request.op === 'findOrder'
        ? request.reference
        : undefined;
  const index = sim.queue.findIndex(
    ({ match }) =>
      (match.op === undefined || match.op === request.op) &&
      (match.reference === undefined || match.reference === reference),
  );
  if (index < 0) return sim.defaultBehavior;
  const [entry] = sim.queue.splice(index, 1);
  return entry?.behavior ?? sim.defaultBehavior;
}

async function listCatalog({ db }: Sim, page: number): Promise<ErpResponse> {
  const offset = (Math.max(page, 1) - 1) * CATALOG_PAGE_SIZE;
  // Uma linha a mais que a página diz se existe a próxima.
  const rows = await db
    .selectFrom('erp_sim.products')
    .select(['sku', 'name', 'price_cents', 'on_hand'])
    .orderBy('sku')
    .limit(CATALOG_PAGE_SIZE + 1)
    .offset(offset)
    .execute();
  const items: ErpCatalogItem[] = rows
    .slice(0, CATALOG_PAGE_SIZE)
    .map((row) => ({
      sku: row.sku,
      name: row.name,
      priceCents: row.price_cents,
      onHand: row.on_hand,
    }));
  return {
    status: 200,
    body: { items, hasNext: rows.length > CATALOG_PAGE_SIZE },
  };
}

async function findOrder({ db }: Sim, reference: string): Promise<ErpResponse> {
  // Sem a H1b pode haver várias faturas na referência: a mais antiga é a que vale.
  const row = await db
    .selectFrom('erp_sim.invoices')
    .select(['id', 'reference'])
    .where('reference', '=', reference)
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return row
    ? { status: 200, body: orderFromRow(row) }
    : { status: 404, body: { code: 'order_not_found' } };
}

// H2: baixa o estoque uma linha por UPDATE, em ordem de SKU para não haver deadlock.
async function decrementStock(
  trx: Transaction<ErpSimDb>,
  items: ErpOrderItem[],
): Promise<void> {
  const ordered = [...items].sort((a, b) => a.sku.localeCompare(b.sku));
  for (const item of ordered) {
    const updated = await trx
      .updateTable('erp_sim.products')
      .set({ on_hand: (eb) => eb('on_hand', '-', item.quantity) })
      .where('sku', '=', item.sku)
      .where('on_hand', '>=', item.quantity)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      const known = await trx
        .selectFrom('erp_sim.products')
        .select('sku')
        .where('sku', '=', item.sku)
        .executeTakeFirst();
      throw new InvoiceRefused(
        known ? 'out_of_stock' : 'unknown_product',
        item.sku,
      );
    }
  }
}

async function invoice(
  { withoutH1b }: Sim,
  trx: Transaction<ErpSimDb>,
  request: ErpOrderRequest,
): Promise<ErpResponse> {
  const totalCents = request.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPriceCents,
    0,
  );
  // H1b: a unicidade da dedup_key decide; sem ela a chave é nula e nada conflita.
  const created = await trx
    .insertInto('erp_sim.invoices')
    .values({
      reference: request.reference,
      dedup_key: withoutH1b ? null : request.reference,
      items: JSON.stringify(request.items),
      total_cents: totalCents,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .returning(['id', 'reference'])
    .executeTakeFirst();
  if (!created) {
    // O ON CONFLICT espera a outra transação terminar, então a fatura já está visível aqui.
    const existing = await trx
      .selectFrom('erp_sim.invoices')
      .select(['id', 'reference'])
      .where('dedup_key', '=', request.reference)
      .executeTakeFirstOrThrow();
    return { status: 200, body: orderFromRow(existing) };
  }

  await decrementStock(trx, request.items);
  return { status: 201, body: orderFromRow(created) };
}

async function createOrder(
  sim: Sim,
  request: ErpOrderRequest,
): Promise<ErpResponse> {
  try {
    return await runInTransaction(sim.db, (trx) => invoice(sim, trx, request));
  } catch (error) {
    if (error instanceof InvoiceRefused) {
      return { status: 422, body: { code: error.code, sku: error.sku } };
    }
    throw error;
  }
}

function handle(sim: Sim, request: ErpRequest): Promise<ErpResponse> {
  if (request.op === 'createOrder') return createOrder(sim, request.body);
  if (request.op === 'findOrder') return findOrder(sim, request.reference);
  return listCatalog(sim, request.page);
}

// O processamento que começa depois do atraso do `slow` também conta para o drain.
function handleTracked(sim: Sim, request: ErpRequest): Promise<ErpResponse> {
  const response = handle(sim, request);
  trackWrite(sim, response);
  return response;
}

// Espera o atraso ou o aborto, o que vier primeiro; o relógio não cancela o sleep, então
// o ouvinte do sinal é solto quando o atraso vence.
function sleepUnlessAborted(
  clock: Clock,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void clock.sleep(ms).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

// Grava a fatura delayMs depois do início da chamada, mesmo com ela já abortada.
function invoiceLater(sim: Sim, request: ErpRequest, delayMs: number): void {
  if (request.op !== 'createOrder') return;
  void sim.clock.sleep(delayMs).then(() => {
    trackWrite(sim, createOrder(sim, request.body));
  });
}

type FaultyBehavior = Extract<
  ErpSimBehavior,
  {
    mode:
      | 'invoice_no_response'
      | 'invoice_after'
      | 'fast_502_then_invoice'
      | 'hang';
  }
>;

function isFaulty(behavior: ErpSimBehavior): behavior is FaultyBehavior {
  return [
    'invoice_no_response',
    'invoice_after',
    'fast_502_then_invoice',
    'hang',
  ].includes(behavior.mode);
}

// Os comportamentos em que a fatura pode sair sem a chamada ver a resposta.
function sendFaulty(
  sim: Sim,
  behavior: FaultyBehavior,
  request: ErpRequest,
  signal: AbortSignal,
): Promise<ErpResponse> {
  switch (behavior.mode) {
    case 'invoice_no_response':
      // A gravação não depende do sinal: a fatura sai mesmo que a chamada seja abortada.
      if (request.op === 'createOrder')
        trackWrite(sim, createOrder(sim, request.body));
      return abortedPromise(signal);
    case 'invoice_after':
      invoiceLater(sim, request, behavior.delayMs);
      return abortedPromise(signal);
    case 'fast_502_then_invoice':
      invoiceLater(sim, request, behavior.delayMs);
      return Promise.resolve({ status: 502, body: undefined });
    case 'hang':
      return abortedPromise(signal);
  }
}

async function send(
  sim: Sim,
  request: ErpRequest,
  signal: AbortSignal,
): Promise<ErpResponse> {
  const behavior = nextBehavior(sim, request);
  if (isFaulty(behavior)) return sendFaulty(sim, behavior, request, signal);
  switch (behavior.mode) {
    case 'normal':
      return handle(sim, request);
    case 'slow':
      // Abortado durante a espera, não processa.
      await sleepUnlessAborted(sim.clock, behavior.delayMs, signal);
      return handleTracked(sim, request);
    case 'unavailable':
      throw new ErpNetworkError('ECONNREFUSED');
    case 'reject':
      return { status: 422, body: { code: 'rejected' } };
    case 'status':
      return { status: behavior.status, body: behavior.body };
  }
}

// ERP simulado com transporte e roteiro de falhas (M3): H1a (consulta pela
// referência), H1b (fatura idempotente pela referência), H2 (recusa sem estoque) e
// H3 (fatura pelo preço enviado). Tudo no schema erp_sim, que sobrevive ao reinício
// do worker.
export function createSimulatedErp({
  pool,
  clock,
  withoutH1b = false,
}: SimulatedErpOptions): SimulatedErp {
  const sim: Sim = {
    db: createErpDb(pool),
    clock,
    withoutH1b,
    queue: [],
    defaultBehavior: { mode: 'normal' },
    writes: new Set(),
  };

  const script: ErpSimScript = {
    enqueue(behavior, match = {}) {
      sim.queue.push({ behavior, match });
    },
    setDefault(behavior) {
      sim.defaultBehavior = behavior;
    },
    async drain() {
      // Uma gravação pode disparar outra enquanto se espera: repete até esvaziar.
      while (sim.writes.size > 0) await Promise.all(sim.writes);
    },
  };

  return {
    transport: { send: (request, signal) => send(sim, request, signal) },
    script,
  };
}
