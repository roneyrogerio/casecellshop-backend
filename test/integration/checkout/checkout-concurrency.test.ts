import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CheckoutAccepted, Problem } from '../../../src/contract/index.ts';
import {
  APP_POOL_SIZE,
  checkoutBody,
  countKeyRows,
  countOrdersWithSku,
  countOutboxWithSku,
  createAppPool,
  footprint,
  header,
  line,
  newKey,
  PATIENT_LIMITS,
  PATIENT_LOCK_TIMEOUT_MS,
  postCheckout,
  readInventory,
  seedProduct,
  startCheckoutHarness,
  stockViolations,
  type CheckoutHarness,
} from '../../helpers/checkout.ts';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

let database: TestDatabase;
// Harness dos testes de atomicidade, unicidade e ordem de lock (CHK-01, CHK-03, CHK-07): lock_timeout
// e statement_timeout folgados, para não medirem a latência da máquina (ver PATIENT_LIMITS).
let harness: CheckoutHarness;
// Harness com os limites de produção (2 s e 5 s), só para o CHK-08, que prova o corte pelo lock_timeout.
let productionHarness: CheckoutHarness;

beforeAll(async () => {
  database = await startMigratedDatabase();
  harness = await startCheckoutHarness(database, APP_POOL_SIZE, PATIENT_LIMITS);
  productionHarness = await startCheckoutHarness(database, APP_POOL_SIZE);
}, 120_000);

afterAll(async () => {
  await productionHarness?.close();
  await harness?.close();
  await database?.stop();
});

const SIMULTANEOUS = 50;
const STOCK = 5;
const ROUNDS = 3;

function problemType(body: unknown): string {
  return Problem.parse(body).type;
}

// Barreira sem sleep: a promessa abre quando o último participante chega.
function createBarrier(parties: number): { arrive(): Promise<void> } {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async arrive() {
      arrived += 1;
      if (arrived === parties) open();
      await opened;
    },
  };
}

describe('CHK-01 reserva atômica sob concorrência', () => {
  it(`CHK-01 ${SIMULTANEOUS} checkouts simultâneos com estoque ${STOCK} aceitam exatamente ${STOCK}, em ${ROUNDS} rodadas, com o pool fixado em ${APP_POOL_SIZE}`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const product = await seedProduct(database.pool, { priceCents: 1990, onHand: STOCK });

      const responses = await Promise.all(
        Array.from({ length: SIMULTANEOUS }, () => postCheckout(harness.server, checkoutBody(line(product)))),
      );

      const statuses = responses.map((res) => res.status);
      expect(
        statuses.filter((status) => status >= 500),
        `rodada ${round}: houve 5xx`,
      ).toEqual([]);
      const accepted = responses.filter((res) => res.status === 202);
      const rejected = responses.filter((res) => res.status === 409);
      expect(accepted, `rodada ${round}: aceitos`).toHaveLength(STOCK);
      expect(rejected, `rodada ${round}: recusados`).toHaveLength(SIMULTANEOUS - STOCK);
      for (const res of rejected) expect(problemType(res.body)).toBe('/problems/out-of-stock');
      const orderIds = accepted.map((res) => CheckoutAccepted.parse(res.body).orderId);
      expect(new Set(orderIds).size).toBe(STOCK);

      const inventory = await readInventory(database.pool, product.sku);
      expect(inventory.reserved, `rodada ${round}: reserved`).toBe(STOCK);
      expect(stockViolations(inventory)).toEqual([]);
      expect(await countOrdersWithSku(database.pool, product.sku)).toBe(STOCK);
      expect(await countOutboxWithSku(database.pool, product.sku)).toBe(STOCK);
    }
  });
});

describe('CHK-02 controle negativo da reserva', () => {
  // Repositório ingênuo: lê o disponível, espera todos lerem (a janela forçada) e grava sem condição.
  async function naiveReserve(pool: pg.Pool, sku: string, quantity: number, barrier: { arrive(): Promise<void> }): Promise<boolean> {
    const read = await pool.query<{ available: number }>('select on_hand - reserved as available from inventory where sku = $1', [sku]);
    if ((read.rows[0]?.available ?? 0) < quantity) return false;
    await barrier.arrive();
    await pool.query('update inventory set reserved = reserved + $2 where sku = $1', [sku, quantity]);
    return true;
  }

  it('CHK-02 a versão ingênua, com a janela forçada entre ler e gravar, vende além do estoque no mesmo cenário do CHK-01', async () => {
    const product = await seedProduct(database.pool, { priceCents: 1990, onHand: STOCK });
    const naivePool = createAppPool(database.uri, APP_POOL_SIZE);
    try {
      const barrier = createBarrier(SIMULTANEOUS);

      const outcomes = await Promise.all(Array.from({ length: SIMULTANEOUS }, () => naiveReserve(naivePool, product.sku, 1, barrier)));

      const sold = outcomes.filter(Boolean).length;
      const inventory = await readInventory(database.pool, product.sku);
      // Todos leram 5 disponíveis antes de qualquer gravação: a ingênua aceita mais do que há.
      expect(sold).toBeGreaterThan(STOCK);
      expect(inventory.reserved).toBeGreaterThan(inventory.onHand);
      // A mesma conferência que o CHK-01 exige vazia acusa a violação.
      expect(stockViolations(inventory)).not.toEqual([]);
    } finally {
      await naivePool.end();
    }
  });
});

describe('CHK-03 e CHK-04 idempotência sob concorrência', () => {
  it('CHK-03 a mesma Idempotency-Key em 10 requisições paralelas, com estoque 1, gera um único pedido e todas respondem 202 com o mesmo orderId', async () => {
    // Exijo 202 para todas, e não aceito o 409 idempotency-key-in-progress: a primeira transação
    // dura milissegundos, muito abaixo do lock_timeout, e o design manda a concorrente esperar a
    // primeira e receber o pedido original. O 409 só vale depois do lock_timeout (que aqui é o
    // folgado dos testes de concorrência, para a máquina sobrecarregada não virar 409).
    for (let round = 1; round <= ROUNDS; round += 1) {
      const product = await seedProduct(database.pool, { priceCents: 2500, onHand: 1 });
      const key = newKey();

      const responses = await Promise.all(Array.from({ length: 10 }, () => postCheckout(harness.server, checkoutBody(line(product)), { key })));

      expect(responses.map((res) => res.status), `rodada ${round}`).toEqual(Array.from({ length: 10 }, () => 202));
      const accepted = responses.map((res) => CheckoutAccepted.parse(res.body));
      expect(new Set(accepted.map((body) => body.orderId)).size).toBe(1);
      expect(new Set(accepted.map((body) => body.total))).toEqual(new Set([2500]));
      for (const res of responses) expect(header(res, 'location')).toBe(`/orders/${accepted[0]?.orderId}/status`);

      const inventory = await readInventory(database.pool, product.sku);
      expect(inventory.reserved).toBe(1);
      expect(stockViolations(inventory)).toEqual([]);
      expect(await countOrdersWithSku(database.pool, product.sku)).toBe(1);
      expect(await countOutboxWithSku(database.pool, product.sku)).toBe(1);
      expect(await countKeyRows(database.pool, key)).toBe(1);
    }
  });
});

describe('CHK-07 ordem de lock', () => {
  it('CHK-07 controle negativo: travar o estoque na ordem do pedido, {A,B} contra {B,A}, causa deadlock 40P01', async () => {
    const a = await seedProduct(database.pool, { priceCents: 100, onHand: 100, prefix: 'DLA' });
    const b = await seedProduct(database.pool, { priceCents: 100, onHand: 100, prefix: 'DLB' });
    const first = new pg.Client({ connectionString: database.uri });
    const second = new pg.Client({ connectionString: database.uri });
    await first.connect();
    await second.connect();
    const reserve = 'update inventory set reserved = reserved + 1 where sku = $1';
    try {
      // O deadlock só continua visível com o lock_timeout folgado se o PostgreSQL o detectar antes dele.
      const detection = await database.pool.query<{ ms: number }>("select setting::int as ms from pg_settings where name = 'deadlock_timeout'");
      expect(detection.rows[0]?.ms ?? Number.POSITIVE_INFINITY).toBeLessThan(PATIENT_LOCK_TIMEOUT_MS);

      await first.query('begin');
      await second.query('begin');
      await first.query(reserve, [a.sku]);
      await second.query(reserve, [b.sku]);

      // Cada um pede a linha que o outro segura: o PostgreSQL derruba um dos dois.
      const settled = await Promise.allSettled([first.query(reserve, [b.sku]), second.query(reserve, [a.sku])]);

      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(failures).toHaveLength(1);
      const reason = failures[0]?.reason as { code?: string } | undefined;
      expect(reason?.code).toBe('40P01');
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      await first.end();
      await second.end();
    }
  });

  it('CHK-07 pedidos {A,B} e {B,A} em paralelo, em várias rodadas, terminam sem 5xx e sem deadlock 40P01', async () => {
    const rounds = 10;
    const perDirection = 10;
    const a = await seedProduct(database.pool, { priceCents: 1000, onHand: 10_000, prefix: 'ORDA' });
    const b = await seedProduct(database.pool, { priceCents: 2000, onHand: 10_000, prefix: 'ORDB' });
    expect(a.sku < b.sku).toBe(true);

    for (let round = 1; round <= rounds; round += 1) {
      const forward = Array.from({ length: perDirection }, () => postCheckout(harness.server, checkoutBody(line(a), line(b))));
      const backward = Array.from({ length: perDirection }, () => postCheckout(harness.server, checkoutBody(line(b), line(a))));

      const responses = await Promise.all([...forward, ...backward]);

      expect(
        responses.filter((res) => res.status !== 202).map((res) => res.status),
        `rodada ${round}`,
      ).toEqual([]);
    }

    const total = rounds * perDirection * 2;
    expect((await readInventory(database.pool, a.sku)).reserved).toBe(total);
    expect((await readInventory(database.pool, b.sku)).reserved).toBe(total);
    expect(await countOrdersWithSku(database.pool, a.sku)).toBe(total);
    const deadlockLogs = harness.logLines.filter((entry) => {
      const err = entry['err'] as { code?: string } | undefined;
      return err?.code === '40P01';
    });
    expect(deadlockLogs).toEqual([]);
  });
});

// Quantas conexões do banco esperam por um lock agora, fora a do próprio observador.
async function waitingOnLock(excludePid: number): Promise<number> {
  const result = await database.pool.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> $1",
    [excludePid],
  );
  return result.rows[0]?.n ?? 0;
}

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  return result.rows[0]?.pid ?? 0;
}

describe('CHK-08 lock_timeout', () => {
  it('CHK-08 lock na linha do estoque segurado pelo teste: o checkout responde 503 com Retry-After 5 depois do lock_timeout de 2 s, sem deixar nada', async () => {
    const product = await seedProduct(database.pool, { priceCents: 1500, onHand: 3 });
    const key = newKey();
    const before = await footprint(database.pool);
    const holder = new pg.Client({ connectionString: database.uri });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from inventory where sku = $1 for update', [product.sku]);
      const holderPid = await backendPid(holder);

      const startedAt = Date.now();
      const pending = postCheckout(productionHarness.server, checkoutBody(line(product)), { key });
      // Se o teste falhar antes do await, a promessa solta não pode virar rejeição sem dono.
      void pending.catch(() => undefined);
      // Espera por condição: o checkout está de fato parado num lock do banco.
      await vi.waitFor(async () => expect(await waitingOnLock(holderPid)).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 50 });

      const res = await pending;
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(503);
      expect(header(res, 'retry-after')).toBe('5');
      expect(problemType(res.body)).toBe('/problems/service-unavailable');
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }

    // A transação inteira, inclusive a chave, foi desfeita.
    expect(await footprint(database.pool)).toEqual(before);
    expect(await countKeyRows(database.pool, key)).toBe(0);
    expect((await readInventory(database.pool, product.sku)).reserved).toBe(0);
    // Solto o lock, o cliente repete com a mesma chave e é aceito.
    const retry = await postCheckout(productionHarness.server, checkoutBody(line(product)), { key });
    expect(retry.status).toBe(202);
  });

  it('CHK-08 transação aberta com a mesma Idempotency-Key ainda sem confirmar: o checkout responde 409 idempotency-key-in-progress depois do lock_timeout', async () => {
    const product = await seedProduct(database.pool, { priceCents: 1500, onHand: 3 });
    const key = newKey();
    const holder = new pg.Client({ connectionString: database.uri });
    await holder.connect();
    let before: Awaited<ReturnType<typeof footprint>>;
    try {
      await holder.query('begin');
      const order = await holder.query<{ id: string }>('insert into orders default values returning id');
      await holder.query("insert into idempotency_keys (key, payload_hash, order_id) values ($1, 'hash-do-teste', $2)", [key, order.rows[0]?.id]);
      const holderPid = await backendPid(holder);
      // O que a transação do teste ainda não confirmou não aparece para os outros.
      before = await footprint(database.pool);

      const startedAt = Date.now();
      const pending = postCheckout(productionHarness.server, checkoutBody(line(product)), { key });
      void pending.catch(() => undefined);
      await vi.waitFor(async () => expect(await waitingOnLock(holderPid)).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 50 });

      const res = await pending;
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(409);
      expect(problemType(res.body)).toBe('/problems/idempotency-key-in-progress');
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }

    expect(await footprint(database.pool)).toEqual(before);
    expect(await countKeyRows(database.pool, key)).toBe(0);
    expect((await readInventory(database.pool, product.sku)).reserved).toBe(0);
    const retry = await postCheckout(productionHarness.server, checkoutBody(line(product)), { key });
    expect(retry.status).toBe(202);
  });
});
