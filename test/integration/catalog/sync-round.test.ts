import { describe, expect, it } from 'vitest';
import {
  createSemaphore,
  type Semaphore,
} from '../../../src/shared/semaphore.ts';
import { settle, track } from '../../helpers/async.ts';
import {
  seedCatalog,
  setSyncCompletedAt,
  skuRange,
} from '../../helpers/catalog.ts';
import {
  failErpPageAfter,
  putErpCatalog,
  putErpProducts,
  readLastCompleted,
  readStoreRow,
  removeErpProduct,
  until,
  useSyncDatabase,
} from '../../helpers/sync.ts';

// A rodada da sincronização contra o PostgreSQL real e o ERP simulado: a vitrine em dois estados (CAT-05), a
// defasagem da mudança no ERP (CAT-06) e o SKU removido (CAT-11). O relógio da vitrine é o manual; o do ERP é
// outro, para uma espera da sincronização não estourar o timeout de uma chamada.

const db = useSyncDatabase();

const INTERVAL_MS = 60_000;
// O TTL de 5 s com jitter de ±10% chega a 5,5 s no máximo (design.md, "Parâmetros"); o teste avança o TTL máximo.
const TTL_MAX_MS = 5_500;

interface Listed {
  sku: string;
  unitPrice: number;
  availability: string;
}

async function listed(
  app: Awaited<ReturnType<typeof db.storefront>>,
): Promise<Listed[]> {
  const res = await app.get();
  expect(res.status).toBe(200);
  return (res.body as { items: Listed[] }).items.map((item) => ({
    sku: item.sku,
    unitPrice: item.unitPrice,
    availability: item.availability,
  }));
}

describe('CAT-05 um catálogo ainda não sincronizado responde 503, e depois da primeira rodada completa a vitrine serve o ERP', () => {
  it('CAT-05 antes da rodada GET /products dá 503; depois da primeira rodada completa e de um TTL, 200 com os produtos do ERP simulado', async () => {
    await putErpProducts(db.erpPool, [
      { sku: 'E2E-001', name: 'Capa A', priceCents: 4990, onHand: 20 },
      { sku: 'E2E-002', name: 'Capa B', priceCents: 3990, onHand: 3 },
      { sku: 'E2E-003', name: 'Capa C', priceCents: 2990, onHand: 0 },
    ]);
    const app = await db.storefront();
    const rig = db.rig({ clock: app.clock });

    expect((await app.get()).status).toBe(503);
    expect(await readLastCompleted(db.pool)).toBeNull();

    await rig.sync.start();
    await rig.untilRounds(1);
    app.clock.advance(TTL_MAX_MS);

    expect(await listed(app)).toEqual([
      { sku: 'E2E-001', unitPrice: 4990, availability: 'available' },
      { sku: 'E2E-002', unitPrice: 3990, availability: 'low_stock' },
      { sku: 'E2E-003', unitPrice: 2990, availability: 'out_of_stock' },
    ]);
    const row = await readStoreRow(db.pool, 'E2E-001');
    expect(row.name).toBe('Capa A');
    expect(row.reserved).toBe(0);
    expect(await readLastCompleted(db.pool)).not.toBeNull();
  });

  it('CAT-05 a primeira rodada que falha numa página grava os SKUs lidos, mas a vitrine segue em 503 até uma rodada completa', async () => {
    await putErpCatalog(db.erpPool, 'FIRST', 120);
    const app = await db.storefront();
    const rig = db.rig();
    failErpPageAfter(rig.world, 1);

    const incomplete = await rig.sync.runRound();

    expect(incomplete.complete).toBe(false);
    expect((await readStoreRow(db.pool, 'FIRST-001')).onHand).toBe(10);
    expect(await readLastCompleted(db.pool)).toBeNull();
    app.clock.advance(TTL_MAX_MS);
    expect((await app.get()).status).toBe(503);

    const complete = await rig.sync.runRound();

    expect(complete).toEqual({
      complete: true,
      skuCount: 120,
      missingCount: 0,
    });
    app.clock.advance(TTL_MAX_MS);
    expect((await listed(app)).length).toBe(50);
  });
});

describe('CAT-06 uma mudança de preço e uma reposição no ERP aparecem na vitrine dentro do limite da meta 2', () => {
  it('CAT-06 depois da mudança no ERP, a vitrine mostra o preço novo e a reposição em intervalo (60 s) + TTL máximo (5,5 s) + a rodada, e não antes', async () => {
    await putErpProducts(db.erpPool, [
      { sku: 'P-001', priceCents: 1000, onHand: 0 },
      { sku: 'P-002', priceCents: 2000, onHand: 20 },
    ]);
    const app = await db.storefront();
    const rig = db.rig({ clock: app.clock, intervalMs: INTERVAL_MS });
    await rig.sync.start();
    await rig.untilRounds(1);
    app.clock.advance(TTL_MAX_MS);
    expect(await listed(app)).toEqual([
      { sku: 'P-001', unitPrice: 1000, availability: 'out_of_stock' },
      { sku: 'P-002', unitPrice: 2000, availability: 'available' },
    ]);

    await putErpProducts(db.erpPool, [
      { sku: 'P-001', priceCents: 1500, onHand: 12 },
      { sku: 'P-002', priceCents: 2500, onHand: 20 },
    ]);
    // Antes da próxima rodada a vitrine segue com o que a loja guardou.
    expect(await listed(app)).toEqual([
      { sku: 'P-001', unitPrice: 1000, availability: 'out_of_stock' },
      { sku: 'P-002', unitPrice: 2000, availability: 'available' },
    ]);

    app.clock.advance(INTERVAL_MS);
    await rig.untilRounds(2);
    app.clock.advance(TTL_MAX_MS);

    expect(await listed(app)).toEqual([
      { sku: 'P-001', unitPrice: 1500, availability: 'available' },
      { sku: 'P-002', unitPrice: 2500, availability: 'available' },
    ]);
  });
});

describe('CAT-11 um SKU removido do ERP aparece como esgotado depois de uma rodada completa e volta se reaparecer; uma rodada que falha no meio não zera nada', () => {
  it('CAT-11 o SKU removido fica com on_hand 0 e a reserva intacta, a vitrine o mostra esgotado, e ele volta quando reaparece no ERP', async () => {
    await putErpProducts(
      db.erpPool,
      ['R-001', 'R-002', 'R-003'].map((sku) => ({ sku, onHand: 10 })),
    );
    const app = await db.storefront();
    const rig = db.rig();
    expect(await rig.sync.runRound()).toEqual({
      complete: true,
      skuCount: 3,
      missingCount: 0,
    });
    await db.pool.query(
      "update inventory set reserved = 2 where sku = 'R-002'",
    );

    await removeErpProduct(db.erpPool, 'R-002');
    expect(await rig.sync.runRound()).toEqual({
      complete: true,
      skuCount: 2,
      missingCount: 1,
    });

    const gone = await readStoreRow(db.pool, 'R-002');
    expect(gone.onHand).toBe(0);
    expect(gone.reserved).toBe(2);
    expect(gone.name).toBe('Capinha R-002');
    expect((await readStoreRow(db.pool, 'R-001')).onHand).toBe(10);
    app.clock.advance(TTL_MAX_MS);
    expect((await listed(app)).map((item) => item.availability)).toEqual([
      'available',
      'out_of_stock',
      'available',
    ]);

    await putErpProducts(db.erpPool, [{ sku: 'R-002', onHand: 9 }]);
    expect(await rig.sync.runRound()).toEqual({
      complete: true,
      skuCount: 3,
      missingCount: 0,
    });
    expect((await readStoreRow(db.pool, 'R-002')).onHand).toBe(9);
    app.clock.advance(TTL_MAX_MS);
    expect((await listed(app)).map((item) => item.availability)).toEqual([
      'available',
      'available',
      'available',
    ]);
  });

  it('CAT-11 uma rodada que falha na segunda de três páginas grava os SKUs lidos, não zera o ausente nem os SKUs das páginas seguintes e não grava last_completed_at', async () => {
    const skus = skuRange('M', 120);
    await seedCatalog(db.pool, [
      ...skus.map((sku) => ({ sku, onHand: 4, priceCents: 1000 })),
      { sku: 'M-999', onHand: 4 },
    ]);
    await setSyncCompletedAt(db.pool, new Date('2020-01-01T00:00:00Z'));
    const before = await readLastCompleted(db.pool);
    await putErpCatalog(db.erpPool, 'M', 120, { priceCents: 2000, onHand: 9 });
    const rig = db.rig();
    failErpPageAfter(rig.world, 1);

    const result = await rig.sync.runRound();

    expect(result).toEqual({ complete: false, skuCount: 50, missingCount: 0 });
    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(2);
    const read = await readStoreRow(db.pool, 'M-050');
    expect([read.priceCents, read.onHand]).toEqual([2000, 9]);
    for (const untouched of ['M-051', 'M-100', 'M-120', 'M-999']) {
      const row = await readStoreRow(db.pool, untouched);
      expect(row.onHand, `on_hand de ${untouched}`).toBe(4);
    }
    expect((await readStoreRow(db.pool, 'M-120')).priceCents).toBe(1000);
    expect(await readLastCompleted(db.pool)).toBe(before);

    const next = await rig.sync.runRound();

    expect(next).toEqual({ complete: true, skuCount: 120, missingCount: 1 });
    expect((await readStoreRow(db.pool, 'M-999')).onHand).toBe(0);
    expect((await readStoreRow(db.pool, 'M-120')).onHand).toBe(9);
    expect(await readLastCompleted(db.pool)).not.toBe(before);
  });

  it.each([
    ['o ERP fora do ar', { mode: 'unavailable' }],
    ['o ERP com 503', { mode: 'status', status: 503 }],
    ['o ERP com 401 (erro de configuração)', { mode: 'status', status: 401 }],
  ] as const)(
    'CAT-11 com %s já na primeira página, a rodada fica incompleta e nada é gravado nem zerado',
    async (_label, behavior) => {
      await seedCatalog(db.pool, [
        { sku: 'F-001', onHand: 6, priceCents: 700 },
      ]);
      await putErpProducts(db.erpPool, [
        { sku: 'F-001', priceCents: 900, onHand: 1 },
        { sku: 'F-002', onHand: 1 },
      ]);
      const rig = db.rig();
      rig.world.sim.script.enqueue(behavior, { op: 'listCatalog' });

      const result = await rig.sync.runRound();

      expect(result).toEqual({ complete: false, skuCount: 0, missingCount: 0 });
      const row = await readStoreRow(db.pool, 'F-001');
      expect([row.priceCents, row.onHand]).toEqual([700, 6]);
      await expect(readStoreRow(db.pool, 'F-002')).rejects.toThrow(
        'não existe na loja',
      );
      expect(await readLastCompleted(db.pool)).toBeNull();
    },
  );
});

describe('ORD-20 a leitura do catálogo pela sincronização usa uma permissão do semáforo de chamadas ao ERP', () => {
  it('ORD-20 com todas as permissões tomadas, a rodada não chama o ERP; ao soltá-las ela segue e devolve todas', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'SEM-001' }]);
    const inner = createSemaphore(3);
    // Conta os pedidos de permissão para o teste saber que a rodada já chegou à fila do semáforo.
    let requests = 0;
    const semaphore: Semaphore = {
      acquireFree: () => {
        requests += 1;
        return inner.acquireFree();
      },
      release: (count) => inner.release(count),
    };
    const rig = db.rig({ semaphore });
    const taken = await semaphore.acquireFree();

    const round = track(rig.sync.runRound());
    await until(() => expect(requests).toBeGreaterThan(1));
    await settle();

    expect(round.settled).toBe(false);
    expect(rig.world.transport.sends.length).toBe(0);
    semaphore.release(taken);
    expect((await round.result).complete).toBe(true);
    const free = track(semaphore.acquireFree());
    await settle();
    expect(free.settled).toBe(true);
    expect(await free.result).toBe(3);
  });

  it('ORD-20 com uma permissão só, as 3 páginas passam uma a uma: cada chamada devolve a permissão antes da seguinte', async () => {
    await putErpCatalog(db.erpPool, 'ONE', 120);
    const rig = db.rig({ semaphore: createSemaphore(1) });

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(true);
    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(3);
    expect(rig.world.transport.maxInFlight).toBe(1);
  });
});
