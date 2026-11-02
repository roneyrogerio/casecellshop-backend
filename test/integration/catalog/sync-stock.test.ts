import { describe, expect, it } from 'vitest';
import { seedCatalog } from '../../helpers/catalog.ts';
import {
  afterNextErpPage,
  billLocally,
  countRowsNotSyncedAtT0,
  createNaiveCatalogSync,
  databaseNow,
  isBefore,
  olderReadFinishesAfterNewer,
  putErpProducts,
  readLastCompleted,
  readStoreRow,
  setLastCompleted,
  useSyncDatabase,
  type SyncFactory,
} from '../../helpers/sync.ts';

// CAT-07 (AD-009): a sincronização grava o estoque do ERP descontando a baixa que a loja fez depois do t0, e uma
// leitura mais antiga nunca sobrescreve uma mais nova. A baixa local é injetada pelo ERP simulado, entre a
// resposta dele e o UPDATE do SKU (a janela forçada); cada cenário roda também na sincronização ingênua, que
// precisa reprovar (o controle negativo).

const db = useSyncDatabase();

async function saleDuringRound(factory?: SyncFactory) {
  await seedCatalog(db.pool, [
    { sku: 'S-001', onHand: 10, reserved: 3, priceCents: 1000 },
  ]);
  await putErpProducts(db.erpPool, [
    { sku: 'S-001', priceCents: 1000, onHand: 10 },
  ]);
  const rig = db.rig(factory ? { factory } : {});
  afterNextErpPage(rig.world, () => billLocally(db.pool, 'S-001', 3));
  const result = await rig.sync.runRound();
  return { result, row: await readStoreRow(db.pool, 'S-001') };
}

async function olderReadFinishesLast(factory?: SyncFactory) {
  const { completedByNewer } = await olderReadFinishesAfterNewer(
    db,
    'S-010',
    factory,
  );
  return {
    row: await readStoreRow(db.pool, 'S-010'),
    completedByNewer,
    completedAtEnd: await readLastCompleted(db.pool),
  };
}

describe('CAT-07 um SKU com vendas durante a rodada é atualizado nela, sem devolver unidade baixada pela loja', () => {
  it('CAT-07 uma baixa local entre o t0 e o UPDATE do SKU: o on_hand final é o do ERP menos a baixa, e a reserva não é tocada', async () => {
    const { result, row } = await saleDuringRound();

    expect(result.complete).toBe(true);
    expect(row.onHand).toBe(7);
    expect(row.soldTotal).toBe(3);
    expect(row.reserved).toBe(0);
  });

  it('CAT-07 controle negativo: a sincronização ingênua, que grava o valor do ERP sem descontar a baixa, devolve a unidade vendida', async () => {
    const { row } = await saleDuringRound(createNaiveCatalogSync());

    expect(row.soldTotal).toBe(3);
    expect(row.onHand).toBe(10);
  });

  it('CAT-07 a baixa que o ERP já tinha visto sai duas vezes, e o erro é para menos; a rodada seguinte, sem vendas, corrige', async () => {
    await seedCatalog(db.pool, [{ sku: 'S-002', onHand: 10, reserved: 3 }]);
    // O ERP já baixou as 3 unidades (10 → 7) quando a loja as baixa durante a rodada.
    await putErpProducts(db.erpPool, [{ sku: 'S-002', onHand: 7 }]);
    const rig = db.rig();
    afterNextErpPage(rig.world, () => billLocally(db.pool, 'S-002', 3));

    await rig.sync.runRound();

    expect((await readStoreRow(db.pool, 'S-002')).onHand).toBe(4);

    await rig.sync.runRound();

    expect((await readStoreRow(db.pool, 'S-002')).onHand).toBe(7);
  });

  it('CAT-07 o desconto tem piso em zero: o ERP com 2 e uma baixa local de 5 deixam on_hand 0, sem violar o CHECK', async () => {
    await seedCatalog(db.pool, [{ sku: 'S-003', onHand: 6, reserved: 5 }]);
    await putErpProducts(db.erpPool, [{ sku: 'S-003', onHand: 2 }]);
    const rig = db.rig();
    afterNextErpPage(rig.world, () => billLocally(db.pool, 'S-003', 5));

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(true);
    expect((await readStoreRow(db.pool, 'S-003')).onHand).toBe(0);
  });

  it('CAT-07 um SKU que vende em toda rodada é atualizado em todas, em vez de ser pulado', async () => {
    await seedCatalog(db.pool, [{ sku: 'S-004', onHand: 10, reserved: 3 }]);
    await putErpProducts(db.erpPool, [{ sku: 'S-004', onHand: 10 }]);
    const rig = db.rig();
    let previousSyncedAt = (await readStoreRow(db.pool, 'S-004'))
      .inventorySyncedAt;

    for (let round = 1; round <= 3; round += 1) {
      afterNextErpPage(rig.world, () => billLocally(db.pool, 'S-004', 1));
      await rig.sync.runRound();
      const row = await readStoreRow(db.pool, 'S-004');

      // O ERP segue com 10 e a loja baixou 1 durante a rodada: 10 − 1, sempre; pular a linha deixaria 8, 7...
      expect(row.onHand, `on_hand na rodada ${round}`).toBe(9);
      expect(row.soldTotal).toBe(round);
      expect(row.inventorySyncedAt).not.toBe(previousSyncedAt);
      previousSyncedAt = row.inventorySyncedAt;
    }
  });

  it('CAT-07 o reserved nunca é tocado, nem quando o ERP tem menos unidades que as reservadas', async () => {
    await seedCatalog(db.pool, [{ sku: 'S-005', onHand: 6, reserved: 4 }]);
    await putErpProducts(db.erpPool, [{ sku: 'S-005', onHand: 2 }]);

    await db.rig().sync.runRound();

    const row = await readStoreRow(db.pool, 'S-005');
    expect(row.onHand).toBe(2);
    expect(row.reserved).toBe(4);
  });

  it('CAT-07 uma leitura mais antiga (t0 menor) que termina depois de uma mais nova não sobrescreve preço, nome nem estoque', async () => {
    const { row, completedByNewer, completedAtEnd } =
      await olderReadFinishesLast();

    expect(row.name).toBe('v2');
    expect(row.priceCents).toBe(1200);
    expect(row.onHand).toBe(8);
    expect(completedAtEnd).toBe(completedByNewer);
  });

  it('CAT-07 controle negativo: a gravação sem a condição de synced_at deixa a leitura antiga sobrescrever a nova', async () => {
    const { row } = await olderReadFinishesLast(createNaiveCatalogSync());

    expect(row.name).toBe('v1');
    expect(row.priceCents).toBe(1100);
    expect(row.onHand).toBe(9);
  });

  it('CAT-07 o t0 é guardado antes da leitura do ERP, e o synced_at de toda linha e o last_completed_at valem o t0', async () => {
    await seedCatalog(db.pool, [{ sku: 'S-006' }, { sku: 'S-007' }]);
    await putErpProducts(db.erpPool, [{ sku: 'S-006' }, { sku: 'S-007' }]);
    const rig = db.rig();
    let readAt = '';
    afterNextErpPage(rig.world, async () => {
      readAt = await databaseNow(db.pool);
    });

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(true);
    const completedAt = await readLastCompleted(db.pool);
    expect(completedAt).not.toBeNull();
    expect(readAt).not.toBe('');
    expect(await isBefore(db.pool, completedAt ?? '', readAt)).toBe(true);
    expect(await countRowsNotSyncedAtT0(db.pool)).toBe(0);
  });

  it('CAT-07 o last_completed_at só avança: uma rodada completa não o troca por um t0 mais velho que o gravado', async () => {
    await seedCatalog(db.pool, [{ sku: 'S-008' }]);
    await putErpProducts(db.erpPool, [{ sku: 'S-008' }]);
    await setLastCompleted(db.pool, '2100-01-01 00:00:00+00');
    const before = await readLastCompleted(db.pool);

    const result = await db.rig().sync.runRound();

    expect(result.complete).toBe(true);
    expect(await readLastCompleted(db.pool)).toBe(before);
  });
});
