import type { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { createErpClient } from '../../src/erp/acl.ts';
import type { ErpClient, ErpOrderRequest } from '../../src/erp/erp-client.ts';
import {
  createSimulatedErp,
  type SimulatedErp,
} from '../../src/erp/sim/index.ts';
import { settle, track } from './async.ts';
import { createManualClock, type ManualClock } from './clock.ts';
import { startMigratedDatabase, type TestDatabase } from './database.ts';

// Timeout do ERP do design.md (Parâmetros): 10 s.
export const ERP_TIMEOUT_MS = 10_000;
// Limite da H4: o ERP conclui ou abandona uma criação em até 40 s.
export const H4_LIMIT_MS = 40_000;
// Atraso mínimo do design.md: 45 s desde o início da última chamada.
export const MIN_RETRY_DELAY_MS = 45_000;

export interface ErpHarness {
  clock: ManualClock;
  sim: SimulatedErp;
  // A camada anticorrupção por cima do transporte do ERP simulado.
  client: ErpClient;
}

// ERP simulado com a camada anticorrupção por cima, tudo no relógio manual.
export function createErpHarness(
  pool: Pool,
  options: { withoutH1b?: boolean } = {},
): ErpHarness {
  const clock = createManualClock();
  const sim = createSimulatedErp(
    options.withoutH1b === undefined
      ? { pool, clock }
      : { pool, clock, withoutH1b: options.withoutH1b },
  );
  const client = createErpClient({
    transport: sim.transport,
    invoiceReader: sim.invoiceReader,
    clock,
    timeoutMs: ERP_TIMEOUT_MS,
  });
  return { clock, sim, client };
}

// Banco migrado do arquivo de teste e um cenário novo por teste: o ERP simulado com a camada anticorrupção, um
// SKU com estoque e uma referência nova (nomes únicos, sem colisão no mesmo banco).
export function useErpScenarios() {
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await startMigratedDatabase();
  }, 120_000);
  afterAll(async () => {
    await database?.stop();
  });
  const current = (): TestDatabase => {
    if (!database) throw new Error('o banco do arquivo ainda não subiu');
    return database;
  };
  async function newScenario(options: { withoutH1b?: boolean } = {}) {
    const harness = createErpHarness(current().erpPool, options);
    const sku = uniqueName('CENARIO-SKU');
    const reference = uniqueName('pedido-cenario');
    await seedErpProduct(current().pool, { sku, onHand: 1000 });
    return { ...harness, sku, reference, order: orderFor(reference, sku) };
  }
  return { database: current, newScenario };
}

let counter = 0;

// Cada teste cria os próprios dados: nomes únicos evitam colisão no mesmo banco.
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function seedErpProduct(
  pool: Pool,
  product: { sku: string; name?: string; priceCents?: number; onHand?: number },
): Promise<void> {
  await pool.query(
    'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, $3, $4)',
    [
      product.sku,
      product.name ?? 'Capa de teste',
      product.priceCents ?? 4990,
      product.onHand ?? 100,
    ],
  );
}

export function orderFor(
  reference: string,
  sku: string,
  quantity = 1,
  unitPriceCents = 4990,
): ErpOrderRequest {
  return { reference, items: [{ sku, quantity, unitPriceCents }] };
}

export async function countInvoices(
  pool: Pool,
  reference: string,
): Promise<number> {
  const result = await pool.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM erp_sim.invoices WHERE reference = $1',
    [reference],
  );
  return Number(result.rows[0]?.total);
}

export async function invoiceTotals(
  pool: Pool,
  reference: string,
): Promise<number[]> {
  const result = await pool.query<{ total_cents: string }>(
    'SELECT total_cents::text AS total_cents FROM erp_sim.invoices WHERE reference = $1 ORDER BY id',
    [reference],
  );
  return result.rows.map((row) => Number(row.total_cents));
}

export async function erpOnHand(pool: Pool, sku: string): Promise<number> {
  const result = await pool.query<{ on_hand: number }>(
    'SELECT on_hand FROM erp_sim.products WHERE sku = $1',
    [sku],
  );
  return Number(result.rows[0]?.on_hand);
}

// Inicia uma chamada e deixa o transporte registrar o atraso e o timeout no relógio,
// para o teste avançar o relógio só depois de os dois estarem armados.
export async function begin<T>(promise: Promise<T>) {
  const call = track(promise);
  await settle();
  return call;
}

// Avança o relógio e espera as faturas adiadas, cujo prazo foi alcançado, terminarem de gravar.
export async function advanceAndDrain(
  harness: ErpHarness,
  ms: number,
): Promise<void> {
  harness.clock.advance(ms);
  await settle();
  await harness.sim.script.drain();
}
