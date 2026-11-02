import { describe, expect, it } from 'vitest';
import { seedCatalog } from '../../helpers/catalog.ts';
import {
  afterNextErpPage,
  billLocally,
  CATALOG_WRITES,
  createNaiveCatalogSync,
  isBefore,
  putErpProducts,
  readLastCompleted,
  readRowVersions,
  readStoreRow,
  ROUND_COMPLETED,
  useSyncDatabase,
  type ErpSeed,
  type RowVersions,
  type StoreRow,
} from '../../helpers/sync.ts';
import { interceptPool } from '../../helpers/worker.ts';

// CAT-14 (AD-009, "Só o que mudou"): a rodada lê o catálogo inteiro, mas só grava o SKU cujo preço, nome ou
// estoque no ERP difere do que a loja guardava em t0, o SKU novo e o SKU ausente. O SKU igual não recebe comando
// algum, nem em products nem em inventory. Prova-se de dois lados: pela fronteira (os comandos de escrita que
// chegam ao pool) e pelo banco (o xmin da linha só troca quando a linha é gravada).

const db = useSyncDatabase();

const SKUS = ['CH-001', 'CH-002', 'CH-003'];

function stored(sku: string, change: Partial<ErpSeed> = {}): ErpSeed {
  return {
    sku,
    name: `Capa ${sku}`,
    priceCents: 1000,
    onHand: 10,
    ...change,
  };
}

// A loja e o ERP com os mesmos três SKUs, iguais campo a campo.
async function seedEqualStoreAndErp(): Promise<void> {
  await seedCatalog(
    db.pool,
    SKUS.map((sku) => stored(sku)),
  );
  await putErpProducts(
    db.erpPool,
    SKUS.map((sku) => stored(sku)),
  );
}

describe('CAT-14 a rodada não grava o SKU que não mudou no ERP', () => {
  it('CAT-14 nada mudou: nenhum comando de escrita em products nem em inventory, as linhas ficam como estavam, e a rodada ainda completa', async () => {
    await seedEqualStoreAndErp();
    const before = await readRowVersions(db.pool, SKUS);
    const probe = interceptPool(db.pool, { match: CATALOG_WRITES });
    const rig = db.rig({ pool: probe.pool });

    const result = await rig.sync.runRound();

    expect(result).toEqual({ complete: true, skuCount: 3, missingCount: 0 });
    expect(probe.matched, 'comandos de escrita no catálogo').toBe(0);
    expect(await readRowVersions(db.pool, SKUS)).toEqual(before);
    expect(await readLastCompleted(db.pool)).not.toBeNull();
    expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBe(1);
  });

  it('CAT-14 a rodada seguinte à que gravou tudo, com o ERP igual, não grava nada e mantém o last_completed_at avançando', async () => {
    await putErpProducts(
      db.erpPool,
      SKUS.map((sku) => stored(sku)),
    );
    const probe = interceptPool(db.pool, { match: CATALOG_WRITES });
    const rig = db.rig({ pool: probe.pool });

    await rig.sync.runRound();
    const firstWrites = probe.matched;
    const afterFirst = await readRowVersions(db.pool, SKUS);
    const completedFirst = await readLastCompleted(db.pool);
    await rig.sync.runRound();

    expect(
      firstWrites,
      'a primeira rodada insere os SKUs novos',
    ).toBeGreaterThan(0);
    expect(probe.matched, 'a segunda rodada não escreve').toBe(firstWrites);
    expect(await readRowVersions(db.pool, SKUS)).toEqual(afterFirst);
    const completedSecond = await readLastCompleted(db.pool);
    expect(completedFirst).not.toBeNull();
    expect(completedSecond).not.toBeNull();
    expect(
      await isBefore(db.pool, completedFirst ?? '', completedSecond ?? ''),
      'o last_completed_at avança mesmo sem nenhum SKU gravado',
    ).toBe(true);
    expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBe(2);
  });

  it('CAT-14 controle negativo: a sincronização que grava todo SKU a cada rodada é vista pelas duas medidas', async () => {
    await seedEqualStoreAndErp();
    const before = await readRowVersions(db.pool, SKUS);
    const probe = interceptPool(db.pool, { match: CATALOG_WRITES });
    const rig = db.rig({
      pool: probe.pool,
      factory: createNaiveCatalogSync(),
    });

    await rig.sync.runRound();

    expect(probe.matched).toBeGreaterThan(0);
    expect(await readRowVersions(db.pool, SKUS)).not.toEqual(before);
  });

  // O que cada mudança deixa na linha: a tabela gravada, o valor lido da loja e o esperado.
  type Table = keyof RowVersions;
  type Written = [Table, (row: StoreRow) => unknown, unknown];
  it.each<[string, Partial<ErpSeed>, Written]>([
    ['o preço', { priceCents: 1500 }, ['product', (r) => r.priceCents, 1500]],
    [
      'o nome',
      { name: 'Capa renomeada' },
      ['product', (r) => r.name, 'Capa renomeada'],
    ],
    ['o estoque', { onHand: 7 }, ['inventory', (r) => r.onHand, 7]],
  ])(
    'CAT-14 só %s de um SKU mudou no ERP: só ele recebe comando, os outros dois ficam como estavam',
    async (_label, change, [table, read, expected]) => {
      await seedEqualStoreAndErp();
      const before = await readRowVersions(db.pool, SKUS);
      await putErpProducts(db.erpPool, [stored('CH-002', change)]);
      const probe = interceptPool(db.pool, { match: CATALOG_WRITES });
      const rig = db.rig({ pool: probe.pool });

      const result = await rig.sync.runRound();

      expect(result.complete).toBe(true);
      expect(probe.matched, 'o SKU que mudou recebeu comando').toBeGreaterThan(
        0,
      );
      const after = await readRowVersions(db.pool, SKUS);
      expect(after['CH-001']).toEqual(before['CH-001']);
      expect(after['CH-003']).toEqual(before['CH-003']);
      expect(read(await readStoreRow(db.pool, 'CH-002'))).toBe(expected);
      expect(after['CH-002']?.[table]).not.toBe(before['CH-002']?.[table]);
    },
  );

  it('CAT-14 um SKU novo no ERP é inserido, e um SKU da loja ausente do ERP é zerado, sem tocar nos SKUs iguais', async () => {
    await seedCatalog(db.pool, [
      ...SKUS.map((sku) => stored(sku)),
      stored('CH-ABS', { onHand: 5 }),
    ]);
    await putErpProducts(db.erpPool, [
      ...SKUS.map((sku) => stored(sku)),
      stored('CH-NEW', { priceCents: 2500, onHand: 4 }),
    ]);
    const before = await readRowVersions(db.pool, [...SKUS, 'CH-ABS']);
    const rig = db.rig();

    const result = await rig.sync.runRound();

    expect(result).toEqual({ complete: true, skuCount: 4, missingCount: 1 });
    const added = await readStoreRow(db.pool, 'CH-NEW');
    expect([added.priceCents, added.onHand]).toEqual([2500, 4]);
    expect((await readStoreRow(db.pool, 'CH-ABS')).onHand).toBe(0);
    const after = await readRowVersions(db.pool, [...SKUS, 'CH-ABS']);
    for (const sku of SKUS) expect(after[sku], sku).toEqual(before[sku]);
    expect(after['CH-ABS']?.inventory).not.toBe(before['CH-ABS']?.inventory);
  });
});

describe('CAT-14 a baixa local durante a rodada, com o ERP igual ao guardado em t0, não gera comando', () => {
  it('CAT-14 uma baixa local entre o t0 e o fim da rodada, com o ERP igual ao snapshot: nenhum comando, e o on_hand final é o da loja depois da baixa, sem devolver a unidade', async () => {
    await seedCatalog(db.pool, [
      { sku: 'CS-001', onHand: 10, reserved: 3, priceCents: 1000 },
      stored('CS-002'),
    ]);
    await putErpProducts(db.erpPool, [
      { sku: 'CS-001', priceCents: 1000, onHand: 10 },
      stored('CS-002'),
    ]);
    // O ERP ainda não viu a baixa: devolve 10, o mesmo valor que a loja guardava em t0.
    const probe = interceptPool(db.pool, { match: CATALOG_WRITES });
    const rig = db.rig({ pool: probe.pool });
    let afterSale: Awaited<ReturnType<typeof readRowVersions>> = {};
    let soldRow: Awaited<ReturnType<typeof readStoreRow>> | undefined;
    afterNextErpPage(rig.world, async () => {
      await billLocally(db.pool, 'CS-001', 3);
      afterSale = await readRowVersions(db.pool, ['CS-001', 'CS-002']);
      soldRow = await readStoreRow(db.pool, 'CS-001');
    });

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(true);
    expect(probe.matched, 'comandos de escrita no catálogo').toBe(0);
    const row = await readStoreRow(db.pool, 'CS-001');
    expect(row.onHand).toBe(7);
    expect(row.soldTotal).toBe(3);
    expect(row.reserved).toBe(0);
    expect(row.inventorySyncedAt).toBe(soldRow?.inventorySyncedAt);
    expect(await readRowVersions(db.pool, ['CS-001', 'CS-002'])).toEqual(
      afterSale,
    );
    expect(await readLastCompleted(db.pool)).not.toBeNull();
  });
});
