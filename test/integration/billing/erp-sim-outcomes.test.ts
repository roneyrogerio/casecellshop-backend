import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateOrderResult } from '../../../src/erp/erp-client.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import {
  countInvoices,
  createErpHarness,
  erpOnHand,
  invoiceTotals,
  orderFor,
  seedErpProduct,
  uniqueName,
} from '../../helpers/erp.ts';

// ERP simulado em modo normal, com a camada anticorrupção por cima, contra o
// PostgreSQL real. As faturas são contadas direto em erp_sim.invoices.

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

function orderOf(result: CreateOrderResult) {
  if (result.kind !== 'ok') throw new Error(`esperava ok, veio ${result.kind}`);
  return result.order;
}

describe('H1b: a criação é idempotente pela referência', () => {
  it('ORD-21 criar duas vezes com a mesma referência dá uma fatura e devolve o mesmo pedido', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H1B-SKU');
    const reference = uniqueName('pedido-h1b');
    await seedErpProduct(database.pool, { sku, onHand: 10 });

    const first = await client.createOrder(orderFor(reference, sku, 2));
    const second = await client.createOrder(orderFor(reference, sku, 2));

    expect(first.kind).toBe('ok');
    expect(second).toEqual(first);
    expect(orderOf(first).reference).toBe(reference);
    expect(await countInvoices(database.pool, reference)).toBe(1);
    // A segunda criação devolve a fatura que existe e não baixa o estoque de novo.
    expect(await erpOnHand(database.pool, sku)).toBe(8);
  });

  it('ORD-06 20 criações simultâneas com a mesma referência dão uma fatura só', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H1B-RACE-SKU');
    const reference = uniqueName('pedido-h1b-corrida');
    await seedErpProduct(database.pool, { sku, onHand: 100 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        client.createOrder(orderFor(reference, sku, 1)),
      ),
    );

    const ids = new Set(results.map((result) => orderOf(result).erpOrderId));
    expect(ids.size).toBe(1);
    expect(await countInvoices(database.pool, reference)).toBe(1);
    expect(await erpOnHand(database.pool, sku)).toBe(99);
  });

  it('ORD-06 controle negativo: sem a H1b as mesmas 20 criações simultâneas dão 20 faturas', async () => {
    const { client } = createErpHarness(database.erpPool, { withoutH1b: true });
    const sku = uniqueName('NOH1B-RACE-SKU');
    const reference = uniqueName('pedido-sem-h1b-corrida');
    await seedErpProduct(database.pool, { sku, onHand: 100 });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        client.createOrder(orderFor(reference, sku, 1)),
      ),
    );

    expect(await countInvoices(database.pool, reference)).toBe(20);
  });
});

describe('H1a: consulta pela referência', () => {
  it('ORD-21 consultar uma referência faturada dá found com o pedido criado', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H1A-SKU');
    const reference = uniqueName('pedido-h1a');
    await seedErpProduct(database.pool, { sku });
    const created = orderOf(await client.createOrder(orderFor(reference, sku)));

    expect(await client.findOrderByReference(reference)).toEqual({
      kind: 'found',
      order: created,
    });
  });

  it('ORD-21 consultar uma referência nunca faturada dá not_found, e a consulta não cria fatura', async () => {
    const { client } = createErpHarness(database.erpPool);
    const reference = uniqueName('pedido-nunca-faturado');

    expect(await client.findOrderByReference(reference)).toEqual({
      kind: 'not_found',
    });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });
});

describe('modo sem a H1b', () => {
  it('ORD-21 sem a H1b, duas criações com a mesma referência dão duas faturas', async () => {
    const { client } = createErpHarness(database.erpPool, { withoutH1b: true });
    const sku = uniqueName('NOH1B-SKU');
    const reference = uniqueName('pedido-sem-h1b');
    await seedErpProduct(database.pool, { sku });

    const first = orderOf(await client.createOrder(orderFor(reference, sku)));
    const second = orderOf(await client.createOrder(orderFor(reference, sku)));

    expect(second.erpOrderId).not.toBe(first.erpOrderId);
    expect(await countInvoices(database.pool, reference)).toBe(2);
  });

  it('ORD-21 sem a H1b, a consulta pela referência devolve a fatura mais antiga', async () => {
    const { client } = createErpHarness(database.erpPool, { withoutH1b: true });
    const sku = uniqueName('NOH1B-OLDEST-SKU');
    const reference = uniqueName('pedido-sem-h1b-antigo');
    await seedErpProduct(database.pool, { sku });
    const first = orderOf(await client.createOrder(orderFor(reference, sku)));
    await client.createOrder(orderFor(reference, sku));

    expect(await client.findOrderByReference(reference)).toEqual({
      kind: 'found',
      order: first,
    });
  });

  it('ORD-21 a H1a continua valendo sem a H1b: referência nunca faturada dá not_found', async () => {
    const { client } = createErpHarness(database.erpPool, { withoutH1b: true });

    expect(
      await client.findOrderByReference(uniqueName('pedido-sem-h1b-vazio')),
    ).toEqual({ kind: 'not_found' });
  });

  it('ORD-21 o modo sem a H1b vale por instância: uma instância com a H1b, no mesmo banco, continua deduplicando', async () => {
    const withoutH1b = createErpHarness(database.erpPool, { withoutH1b: true });
    const withH1b = createErpHarness(database.erpPool);
    const sku = uniqueName('MIX-SKU');
    const reference = uniqueName('pedido-misto');
    await seedErpProduct(database.pool, { sku });

    await withH1b.client.createOrder(orderFor(reference, sku));
    await withH1b.client.createOrder(orderFor(reference, sku));
    expect(await countInvoices(database.pool, reference)).toBe(1);

    await withoutH1b.client.createOrder(orderFor(reference, sku));
    expect(await countInvoices(database.pool, reference)).toBe(2);
  });
});

describe('H2: o ERP recusa faturar sem estoque', () => {
  it('ORD-08 sem estoque no erp_sim.products a criação é permanent out_of_stock, sem fatura e sem baixar estoque', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H2-SKU');
    const reference = uniqueName('pedido-h2');
    await seedErpProduct(database.pool, { sku, onHand: 1 });

    const result = await client.createOrder(orderFor(reference, sku, 2));

    expect(result).toEqual({ kind: 'permanent', reason: 'out_of_stock' });
    expect(await countInvoices(database.pool, reference)).toBe(0);
    expect(await erpOnHand(database.pool, sku)).toBe(1);
  });

  it('ORD-08 estoque zerado também é permanent out_of_stock', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H2-ZERO-SKU');
    const reference = uniqueName('pedido-h2-zero');
    await seedErpProduct(database.pool, { sku, onHand: 0 });

    expect(await client.createOrder(orderFor(reference, sku, 1))).toEqual({
      kind: 'permanent',
      reason: 'out_of_stock',
    });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });

  it('ORD-21 SKU desconhecido do ERP é permanent rejected, sem fatura', async () => {
    const { client } = createErpHarness(database.erpPool);
    const reference = uniqueName('pedido-sku-desconhecido');

    const result = await client.createOrder(
      orderFor(reference, uniqueName('SKU-QUE-NAO-EXISTE')),
    );

    expect(result).toEqual({ kind: 'permanent', reason: 'rejected' });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });

  it('ORD-21 um item sem estoque desfaz o pedido inteiro: o outro item não perde estoque e não há fatura', async () => {
    const { client } = createErpHarness(database.erpPool);
    const withStock = uniqueName('H2-A-SKU');
    const withoutStock = uniqueName('H2-B-SKU');
    const reference = uniqueName('pedido-h2-parcial');
    await seedErpProduct(database.pool, { sku: withStock, onHand: 10 });
    await seedErpProduct(database.pool, { sku: withoutStock, onHand: 0 });

    const result = await client.createOrder({
      reference,
      items: [
        { sku: withStock, quantity: 3, unitPriceCents: 4990 },
        { sku: withoutStock, quantity: 1, unitPriceCents: 4990 },
      ],
    });

    expect(result).toEqual({ kind: 'permanent', reason: 'out_of_stock' });
    expect(await countInvoices(database.pool, reference)).toBe(0);
    expect(await erpOnHand(database.pool, withStock)).toBe(10);
  });

  it('ORD-21 depois da recusa por falta de estoque a referência continua sem pedido no ERP', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H2-FIND-SKU');
    const reference = uniqueName('pedido-h2-consulta');
    await seedErpProduct(database.pool, { sku, onHand: 0 });
    await client.createOrder(orderFor(reference, sku));

    expect(await client.findOrderByReference(reference)).toEqual({
      kind: 'not_found',
    });
  });

  it('ORD-21 com estoque, a criação fatura e baixa o estoque do ERP', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H2-OK-SKU');
    const reference = uniqueName('pedido-h2-ok');
    await seedErpProduct(database.pool, { sku, onHand: 5 });

    expect((await client.createOrder(orderFor(reference, sku, 5))).kind).toBe(
      'ok',
    );

    expect(await countInvoices(database.pool, reference)).toBe(1);
    expect(await erpOnHand(database.pool, sku)).toBe(0);
  });
});

describe('H3: o ERP fatura pelo preço unitário enviado', () => {
  it('ORD-21 a fatura sai pelo preço unitário enviado, não pelo preço do cadastro do ERP', async () => {
    const { client } = createErpHarness(database.erpPool);
    const sku = uniqueName('H3-SKU');
    const reference = uniqueName('pedido-h3');
    await seedErpProduct(database.pool, { sku, priceCents: 4990 });

    await client.createOrder(orderFor(reference, sku, 2, 3990));

    expect(await invoiceTotals(database.pool, reference)).toEqual([7980]);
  });

  it('ORD-21 com vários itens a fatura soma quantidade vezes o preço enviado de cada um', async () => {
    const { client } = createErpHarness(database.erpPool);
    const skuA = uniqueName('H3-A-SKU');
    const skuB = uniqueName('H3-B-SKU');
    const reference = uniqueName('pedido-h3-multi');
    await seedErpProduct(database.pool, { sku: skuA, priceCents: 1000 });
    await seedErpProduct(database.pool, { sku: skuB, priceCents: 2000 });

    await client.createOrder({
      reference,
      items: [
        { sku: skuA, quantity: 3, unitPriceCents: 1500 },
        { sku: skuB, quantity: 1, unitPriceCents: 2500 },
      ],
    });

    expect(await invoiceTotals(database.pool, reference)).toEqual([7000]);
  });
});
