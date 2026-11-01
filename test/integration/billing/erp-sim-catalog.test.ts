import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';
import { createErpHarness, orderFor, seedErpProduct } from '../../helpers/erp.ts';

// O catálogo lista todos os produtos do erp_sim; por isso este arquivo tem o
// próprio banco, onde os 51 produtos semeados são os únicos.

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
  for (let index = 1; index <= 51; index += 1) {
    const suffix = String(index).padStart(3, '0');
    await seedErpProduct(database.pool, {
      sku: `CATALOGO-${suffix}`,
      name: `Capa ${suffix}`,
      priceCents: 1000 + index,
      onHand: index,
    });
  }
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('catálogo do ERP simulado, pela camada anticorrupção', () => {
  it('ORD-21 a primeira página traz 50 produtos com SKU, nome, preço em centavos e estoque, e hasNext verdadeiro', async () => {
    const { client } = createErpHarness(database.erpPool);

    const result = await client.listCatalog(1);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page.items).toHaveLength(50);
    expect(result.page.hasNext).toBe(true);
    expect(result.page.items[0]).toEqual({ sku: 'CATALOGO-001', name: 'Capa 001', priceCents: 1001, onHand: 1 });
  });

  it('ORD-21 a segunda página traz o produto que sobrou e hasNext falso; uma página além do fim vem vazia', async () => {
    const { client } = createErpHarness(database.erpPool);

    const second = await client.listCatalog(2);
    const beyond = await client.listCatalog(3);

    expect(second).toEqual({
      kind: 'ok',
      page: { items: [{ sku: 'CATALOGO-051', name: 'Capa 051', priceCents: 1051, onHand: 51 }], hasNext: false },
    });
    expect(beyond).toEqual({ kind: 'ok', page: { items: [], hasNext: false } });
  });

  it('ORD-21 uma reposição no ERP aparece na página seguinte do catálogo', async () => {
    const { client } = createErpHarness(database.erpPool);
    await database.pool.query('UPDATE erp_sim.products SET on_hand = 77, price_cents = 2222 WHERE sku = $1', [
      'CATALOGO-002',
    ]);

    const result = await client.listCatalog(1);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page.items[1]).toEqual({ sku: 'CATALOGO-002', name: 'Capa 002', priceCents: 2222, onHand: 77 });
  });

  it('ORD-21 com o catálogo indisponível a listagem é transitória', async () => {
    const { client, sim } = createErpHarness(database.erpPool);
    sim.script.enqueue({ mode: 'unavailable' }, { op: 'listCatalog' });

    expect((await client.listCatalog(1)).kind).toBe('transient');
    expect((await client.listCatalog(1)).kind).toBe('ok');
  });

  it('ORD-21 uma criação que baixa o estoque aparece no catálogo com o novo estoque', async () => {
    const { client } = createErpHarness(database.erpPool);

    expect((await client.createOrder(orderFor('pedido-catalogo-0001', 'CATALOGO-003', 3))).kind).toBe('ok');
    const result = await client.listCatalog(1);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.page.items[2]).toMatchObject({ sku: 'CATALOGO-003', onHand: 0 });
  });
});
