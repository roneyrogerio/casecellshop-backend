import { describe, expect, it } from 'vitest';
import { counterValue, seedCatalog, skuRange } from '../../helpers/catalog.ts';
import {
  expectNoSkuInMetrics,
  expectOnlyKeys,
  stringList,
} from '../../helpers/sku-logs.ts';
import {
  failErpPageAfter,
  olderReadFinishesAfterNewer,
  putErpCatalog,
  putErpProducts,
  useSyncDatabase,
  type SyncRig,
} from '../../helpers/sync.ts';
import type { LogLine } from '../../helpers/logs.ts';

// OBS-01 (o sku nos logs da sincronização): uma linha casecellshop.catalog.sync.sku.corrected por SKU cuja correção
// entrou no counter de correções, com os campos corrigidos, e uma linha casecellshop.catalog.sync.sku.zeroed por SKU
// ausente do ERP que foi zerado e contado no counter de ausentes. Nenhuma métrica ganha o sku.

const db = useSyncDatabase();

const CORRECTED = 'casecellshop.catalog.sync.sku.corrected';
const ZEROED = 'casecellshop.catalog.sync.sku.zeroed';
const CORRECTIONS = 'casecellshop.catalog.sync.corrections';
const FIELD = 'casecellshop.catalog.sync.field';
const MISSING = 'casecellshop.catalog.sync.missing_skus';
const FIELDS = ['price', 'name', 'on_hand'] as const;

// O campo `fields` de cada linha de correção, por SKU, em ordem alfabética.
function correctedFields(lines: readonly LogLine[]): Record<string, string[]> {
  return Object.fromEntries(
    lines.map((entry) => [
      String(entry['sku']),
      stringList(entry['fields']).sort(),
    ]),
  );
}

// O counter de correções soma, por campo, tantas vezes quantas as linhas de correção citam o campo.
async function expectLinesMatchCounter(rig: SyncRig): Promise<void> {
  const families = await rig.scrape();
  const lines = rig.logs.eventsOf(CORRECTED);
  for (const field of FIELDS) {
    const inLines = lines.filter((entry) =>
      stringList(entry['fields']).includes(field),
    ).length;
    expect(
      counterValue(families, CORRECTIONS, { [FIELD]: field }),
      `correções de ${field} no counter e nas linhas`,
    ).toBe(inLines);
  }
}

describe('OBS-01 sync.sku.corrected: uma linha por SKU corrigido, com os campos', () => {
  it('OBS-01 cada SKU que o ERP corrige gera uma linha com o sku e os campos corrigidos; o SKU sem mudança e o SKU novo não geram linha', async () => {
    await seedCatalog(db.pool, [
      { sku: 'T-001', name: 'Capinha T-001', priceCents: 1000, onHand: 5 },
      { sku: 'T-002', name: 'Antigo', priceCents: 2000, onHand: 5 },
      { sku: 'T-003', name: 'Antigo', priceCents: 3000, onHand: 5 },
      { sku: 'T-004', name: 'Igual', priceCents: 4000, onHand: 7 },
    ]);
    await putErpProducts(db.erpPool, [
      { sku: 'T-001', name: 'Capinha T-001', priceCents: 1500, onHand: 5 },
      { sku: 'T-002', name: 'Novo', priceCents: 2000, onHand: 9 },
      { sku: 'T-003', name: 'Novo', priceCents: 3100, onHand: 4 },
      { sku: 'T-004', name: 'Igual', priceCents: 4000, onHand: 7 },
      { sku: 'T-005', name: 'Produto novo', priceCents: 5000, onHand: 3 },
    ]);
    const rig = db.rig();

    await rig.sync.runRound();

    const lines = rig.logs.eventsOf(CORRECTED);
    expect(correctedFields(lines)).toEqual({
      'T-001': ['price'],
      'T-002': ['name', 'on_hand'],
      'T-003': ['name', 'on_hand', 'price'],
    });
    expect(lines, 'uma linha por SKU corrigido').toHaveLength(3);
    for (const entry of lines) {
      expect(entry['level']).toBe('info');
      expectOnlyKeys(entry, ['sku', 'fields']);
    }
    await expectLinesMatchCounter(rig);
  });

  it('OBS-01 uma segunda rodada sem divergência não gera linha de correção', async () => {
    await seedCatalog(db.pool, [
      { sku: 'T-010', name: 'Antigo', priceCents: 1000, onHand: 5 },
    ]);
    await putErpProducts(db.erpPool, [
      { sku: 'T-010', name: 'Novo', priceCents: 1100, onHand: 6 },
    ]);
    const rig = db.rig();

    await rig.sync.runRound();
    expect(rig.logs.eventsOf(CORRECTED)).toHaveLength(1);
    await rig.sync.runRound();

    expect(rig.logs.eventsOf(CORRECTED), 'nenhuma linha nova').toHaveLength(1);
  });

  it('OBS-01 só a rodada cuja correção entrou no counter escreve a linha: a leitura mais antiga que a gravada não escreve, a mais nova escreve', async () => {
    const { older, newer } = await olderReadFinishesAfterNewer(db, 'T-020');

    expect(correctedFields(newer.logs.eventsOf(CORRECTED))).toEqual({
      'T-020': ['name', 'on_hand', 'price'],
    });
    expect(older.logs.eventsOf(CORRECTED)).toEqual([]);
    await expectLinesMatchCounter(newer);
    await expectLinesMatchCounter(older);
  });

  it('OBS-01 o /metrics do worker, depois das correções e dos ausentes, não tem rótulo sku nem skus nem valor de SKU', async () => {
    await seedCatalog(db.pool, [
      { sku: 'T-030', name: 'Antigo', priceCents: 1000, onHand: 5 },
      { sku: 'T-031', onHand: 5 },
    ]);
    await putErpProducts(db.erpPool, [
      { sku: 'T-030', name: 'Novo', priceCents: 1200, onHand: 5 },
    ]);
    const rig = db.rig();

    await rig.sync.runRound();

    // O sku foi ao log (a prova de que a rodada o conhece) e a nenhuma métrica.
    expect(correctedFields(rig.logs.eventsOf(CORRECTED))).toEqual({
      'T-030': ['name', 'price'],
    });
    expect(rig.logs.eventsOf(ZEROED).map((entry) => entry['sku'])).toEqual([
      'T-031',
    ]);
    await expectNoSkuInMetrics(rig.telemetry, ['T-030', 'T-031']);
  });
});

// Semeia a loja e o ERP, e devolve a sincronização montada sobre eles, ainda sem rodada.
async function rigOver(
  store: readonly { sku: string; onHand: number }[],
  erp: readonly { sku: string; onHand: number }[],
): Promise<SyncRig> {
  await seedCatalog(db.pool, store);
  await putErpProducts(db.erpPool, erp);
  return db.rig();
}

// Os SKUs das linhas de SKU zerado até agora, em ordem alfabética.
function zeroedSkus(rig: SyncRig): string[] {
  return rig.logs
    .eventsOf(ZEROED)
    .map((entry) => String(entry['sku']))
    .sort();
}

describe('OBS-01 sync.sku.zeroed: uma linha por SKU ausente que tinha estoque', () => {
  it('OBS-01 o SKU ausente do ERP que já estava sem estoque não gera linha de SKU zerado, e o ausente com estoque gera', async () => {
    const rig = await rigOver(
      [
        { sku: 'T-060', onHand: 0 },
        { sku: 'T-061', onHand: 3 },
      ],
      [{ sku: 'T-062', onHand: 1 }],
    );

    expect((await rig.sync.runRound()).complete).toBe(true);

    expect(zeroedSkus(rig)).toEqual(['T-061']);
  });

  it('OBS-01 numa rodada completa, cada SKU ausente do ERP com estoque gera uma linha com o sku, na mesma conta do counter de ausentes', async () => {
    const present = skuRange('T', 3, 40).map((sku) => ({ sku, onHand: 5 }));
    const absent = skuRange('T', 2, 43).map((sku) => ({ sku, onHand: 5 }));
    const rig = await rigOver([...present, ...absent], present);

    expect((await rig.sync.runRound()).complete).toBe(true);

    expect(zeroedSkus(rig)).toEqual(absent.map((row) => row.sku));
    const lines = rig.logs.eventsOf(ZEROED);
    expect(lines.length, 'uma linha por SKU contado').toBe(
      counterValue(await rig.scrape(), MISSING),
    );
    for (const entry of lines) {
      expect(entry['level']).toBe('warn');
      expectOnlyKeys(entry, ['sku']);
    }
  });

  it('OBS-01 a rodada incompleta não escreve linha de SKU zerado, e a rodada completa seguinte escreve uma só para o SKU ausente', async () => {
    const rig = db.rig();
    failErpPageAfter(rig.world, 1);
    await putErpCatalog(db.erpPool, 'V', 120);
    await seedCatalog(db.pool, [{ sku: 'T-999', onHand: 5 }]);

    expect((await rig.sync.runRound()).complete).toBe(false);
    expect(zeroedSkus(rig)).toEqual([]);

    expect((await rig.sync.runRound()).complete).toBe(true);
    expect(zeroedSkus(rig)).toEqual(['T-999']);
  });

  it('OBS-01 a segunda rodada completa não escreve de novo o SKU que a primeira já zerou', async () => {
    const rig = await rigOver(
      [{ sku: 'T-900', onHand: 4 }],
      [{ sku: 'T-901', onHand: 10 }],
    );

    await rig.sync.runRound();
    expect(zeroedSkus(rig)).toEqual(['T-900']);
    await rig.sync.runRound();

    expect(rig.logs.eventsOf(ZEROED)).toHaveLength(1);
  });
});
