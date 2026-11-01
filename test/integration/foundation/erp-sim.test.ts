import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderResult } from '../../../src/erp/erp-client.ts';
import { createPool, startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';
import { createErpHarness, orderFor, seedErpProduct, uniqueName } from '../../helpers/erp.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('FND-04 fatura do ERP simulado sobrevive ao reinício do worker', () => {
  it('FND-04 uma fatura criada pelo ERP simulado continua lá depois de o worker reiniciar', async () => {
    const sku = 'FND04-CAPA-AZUL';
    const reference = 'pedido-fnd04-0001';
    await database.pool.query(
      'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, $3, $4)',
      [sku, 'Capa azul', 4990, 10],
    );

    // Primeira vida do worker: o ERP simulado fatura o pedido por um pool próprio.
    const firstErpPool = createPool(database.uri);
    let created: CreateOrderResult;
    try {
      const first = createErpHarness(firstErpPool);
      created = await first.client.createOrder({
        reference,
        items: [{ sku, quantity: 2, unitPriceCents: 4990 }],
      });
      expect(created).toMatchObject({ kind: 'ok', order: { reference } });
    } finally {
      await firstErpPool.end();
    }

    // Segunda vida: instância nova do simulado e da camada anticorrupção, com um pool novo sobre o mesmo banco.
    const restartedErpPool = createPool(database.uri);
    try {
      const second = createErpHarness(restartedErpPool);

      const found = await second.client.findOrderByReference(reference);
      if (created.kind !== 'ok') throw new Error('a primeira criação deveria ter dado ok');
      expect(found).toEqual({ kind: 'found', order: created.order });

      const invoices = await database.pool.query<{ total: string; total_cents: string }>(
        'SELECT count(*)::text AS total, coalesce(sum(total_cents), 0)::text AS total_cents FROM erp_sim.invoices WHERE reference = $1',
        [reference],
      );
      expect(invoices.rows[0]?.total).toBe('1');
      // H3: a fatura sai pelo preço enviado (2 x 4990).
      expect(invoices.rows[0]?.total_cents).toBe('9980');
    } finally {
      await restartedErpPool.end();
    }
  });

  it('FND-04 uma referência que o ERP simulado nunca faturou não existe depois do reinício', async () => {
    const pool = createPool(database.uri);
    try {
      const { client } = createErpHarness(pool);
      expect(await client.findOrderByReference('pedido-fnd04-inexistente')).toEqual({ kind: 'not_found' });
    } finally {
      await pool.end();
    }
  });
});

function orderOf(result: CreateOrderResult) {
  if (result.kind !== 'ok') throw new Error(`esperava ok, veio ${result.kind}`);
  return result.order;
}

describe('o estado do ERP simulado vive no banco, não na instância', () => {
  it('FND-04 uma instância nova do simulado sobre outro pool enxerga a fatura da primeira', async () => {
    const sku = uniqueName('PERSIST-SKU');
    const reference = uniqueName('pedido-persistente');
    await seedErpProduct(database.pool, { sku });
    const created = orderOf(await createErpHarness(database.erpPool).client.createOrder(orderFor(reference, sku)));

    const otherPool = createPool(database.uri);
    try {
      const found = await createErpHarness(otherPool).client.findOrderByReference(reference);
      expect(found).toEqual({ kind: 'found', order: created });
    } finally {
      await otherPool.end();
    }
  });
});
