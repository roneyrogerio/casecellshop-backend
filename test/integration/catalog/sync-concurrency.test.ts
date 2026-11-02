import { describe, expect, it } from 'vitest';
import { settle, track } from '../../helpers/async.ts';
import { seedCatalog } from '../../helpers/catalog.ts';
import {
  checkoutBody,
  line,
  postCheckout,
  startCheckoutHarness,
} from '../../helpers/checkout.ts';
import {
  createNaiveCatalogSync,
  holdErpPage,
  putErpProducts,
  readLastCompleted,
  readStoreRow,
  ROUND_COMPLETED,
  roundsFinished,
  until,
  useSyncDatabase,
  type SyncFactory,
} from '../../helpers/sync.ts';
import { createGate, interceptPool } from '../../helpers/worker.ts';

// CAT-08 e CAT-09 contra o PostgreSQL real: a rodada presa (no ERP ou entre dois comandos) não prende o estoque, e
// uma rodada lenta não se sobrepõe à seguinte. As janelas são forçadas por um portão, sem sleep, e os dois
// cenários rodam também na sincronização ingênua, que precisa reprovar (o controle negativo).

const db = useSyncDatabase();

const INTERVAL_MS = 60_000;
const PRODUCTS = [
  { sku: 'K-001', priceCents: 1000 },
  { sku: 'K-002', priceCents: 1000 },
];

type Stuck = 'erp_page' | 'between_commands';

// Prende a rodada, faz um checkout dos dois SKUs enquanto ela está presa e solta a rodada.
async function checkoutWhileRoundIsStuck(stuck: Stuck, factory?: SyncFactory) {
  // A loja guarda 8 e o ERP diz 10: a rodada só grava o SKU que difere, e o teste precisa dos dois comandos de estoque.
  await seedCatalog(
    db.pool,
    PRODUCTS.map((product) => ({ ...product, onHand: 8 })),
  );
  await putErpProducts(
    db.erpPool,
    PRODUCTS.map((product) => ({ ...product, onHand: 10 })),
  );
  const checkout = await startCheckoutHarness(db.database);
  db.teardown(() => checkout.close());

  // Entre os comandos: o segundo comando de estoque da rodada espera o portão, depois de o primeiro SKU ter sido
  // gravado por inteiro.
  const gate = createGate();
  let stockCommands = 0;
  const probe = interceptPool(db.pool, {
    match: /(update|insert\s+into)\s+"inventory"/i,
    before: async () => {
      stockCommands += 1;
      if (stuck === 'between_commands' && stockCommands === 2)
        await gate.park();
    },
  });
  const rig = db.rig({
    pool: probe.pool,
    ...(factory ? { factory } : {}),
  });
  // Registradas depois da sincronização: o teardown solta o portão e a página antes de parar a sincronização.
  const hold = stuck === 'erp_page' ? holdErpPage(db, rig.world) : undefined;
  db.teardown(() => gate.releaseAll());

  const round = track(rig.sync.runRound());
  await (hold ? hold.parked() : gate.waitForParked(1));

  const res = await postCheckout(
    checkout.server,
    checkoutBody(...PRODUCTS.map((product) => line(product))),
  );
  expect(round.settled, 'a rodada seguia presa durante o checkout').toBe(false);

  hold?.release();
  gate.releaseAll();
  await round.result;
  return {
    status: res.status,
    rows: await Promise.all(
      PRODUCTS.map((product) => readStoreRow(db.pool, product.sku)),
    ),
  };
}

describe('CAT-08 uma rodada não prende as linhas de estoque: um checkout concorrente não recebe 503', () => {
  it.each(['erp_page', 'between_commands'] as const)(
    'CAT-08 com a rodada presa (%s), um checkout dos dois SKUs recebe 202, e a reserva sobrevive à rodada',
    async (stuck) => {
      const { status, rows } = await checkoutWhileRoundIsStuck(stuck);

      expect(status).toBe(202);
      expect(rows.map((row) => row.reserved)).toEqual([1, 1]);
      expect(rows.map((row) => row.onHand)).toEqual([10, 10]);
    },
  );

  it.each(['erp_page', 'between_commands'] as const)(
    'CAT-08 controle negativo (%s): a sincronização que segura as linhas travadas durante a rodada faz o checkout receber 503',
    async (stuck) => {
      const { status } = await checkoutWhileRoundIsStuck(
        stuck,
        createNaiveCatalogSync({ holdRowLocks: true }),
      );

      expect(status).toBe(503);
    },
  );
});

async function holdFirstPageAndStart(factory?: SyncFactory) {
  await putErpProducts(db.erpPool, [{ sku: 'W-001' }]);
  const rig = db.rig(factory ? { factory } : {});
  const hold = holdErpPage(db, rig.world);
  // O start() não é esperado: a spec não diz se ele devolve antes ou depois da rodada da subida.
  const starting = track(rig.sync.start());
  await hold.parked();
  return { rig, hold, starting };
}

// A rodada da subida passa do intervalo (três vezes) enquanto está presa na leitura do ERP.
async function slowInitialRound(factory?: SyncFactory) {
  const { rig, hold, starting } = await holdFirstPageAndStart(factory);
  rig.clock.advance(3 * INTERVAL_MS);
  await settle(20);
  return {
    rig,
    hold,
    starting,
    readsDuringSlowRound: rig.world.transport.sendsOf('listCatalog').length,
  };
}

// Duas rodadas pedidas ao mesmo tempo, com a primeira presa na leitura do ERP.
async function twoDirectRounds(factory?: SyncFactory) {
  await putErpProducts(db.erpPool, [{ sku: 'W-002' }]);
  const rig = db.rig(factory ? { factory } : {});
  const hold = holdErpPage(db, rig.world);
  const first = track(rig.sync.runRound());
  const second = track(rig.sync.runRound());
  await hold.parked();
  await settle(20);
  const readsWhileFirstIsStuck =
    rig.world.transport.sendsOf('listCatalog').length;
  hold.release();
  await Promise.all([first.result, second.result]);
  return { rig, readsWhileFirstIsStuck };
}

describe('CAT-09 uma rodada lenta não se sobrepõe à seguinte', () => {
  it('CAT-09 a rodada da subida passa de três intervalos: nenhuma outra lê o ERP até o fim dela, e a seguinte começa logo em seguida, sem esperar outro intervalo', async () => {
    const { rig, hold, readsDuringSlowRound } = await slowInitialRound();

    expect(readsDuringSlowRound).toBe(1);

    hold.release();
    await until(() =>
      expect(rig.world.transport.sendsOf('listCatalog').length).toBe(2),
    );
    await rig.untilRounds(2);
    await settle(20);

    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(2);
    expect(rig.world.transport.maxInFlight).toBe(1);
    // O intervalo da terceira conta do início da segunda.
    expect(rig.clock.pendingWaits()).toEqual([rig.clock.now() + INTERVAL_MS]);
  });

  it('CAT-09 controle negativo: o laço que dispara uma rodada por intervalo sem esperar a anterior lê o ERP duas vezes ao mesmo tempo', async () => {
    const { rig, hold, readsDuringSlowRound } = await slowInitialRound(
      createNaiveCatalogSync(),
    );

    expect(readsDuringSlowRound).toBe(2);
    expect(rig.world.transport.maxInFlight).toBe(2);
    hold.release();
  });

  it('CAT-09 duas rodadas diretas ao mesmo tempo: a segunda só lê o ERP depois de a primeira terminar', async () => {
    const { rig, readsWhileFirstIsStuck } = await twoDirectRounds();

    expect(readsWhileFirstIsStuck).toBe(1);
    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(2);
    expect(rig.world.transport.maxInFlight).toBe(1);
  });

  it('CAT-09 controle negativo: sem a exclusão entre rodadas, as duas leituras do ERP andam juntas', async () => {
    const { rig, readsWhileFirstIsStuck } = await twoDirectRounds(
      createNaiveCatalogSync(),
    );

    expect(readsWhileFirstIsStuck).toBe(2);
    expect(rig.world.transport.maxInFlight).toBe(2);
  });

  it('CAT-09 uma rodada rápida: a seguinte começa um intervalo depois do início da anterior, nem antes', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'W-003' }]);
    const rig = db.rig();
    const startedAt = rig.clock.now();

    await rig.sync.start();
    await rig.untilRounds(1);

    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(1);
    expect(rig.clock.pendingWaits()).toEqual([startedAt + INTERVAL_MS]);
    rig.clock.advance(INTERVAL_MS - 1);
    await settle(20);
    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(1);

    rig.clock.advance(1);
    await rig.untilRounds(2);

    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(2);
  });

  it('CAT-09 chamar start() duas vezes não cria um segundo laço: cada intervalo gera uma rodada só', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'W-004' }]);
    const rig = db.rig();

    await rig.sync.start();
    await rig.sync.start();
    await rig.untilRounds(1);
    rig.clock.advance(INTERVAL_MS);
    await rig.untilRounds(2);
    await settle(20);

    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(2);
    expect(roundsFinished(rig.logs)).toBe(2);
  });

  it('CAT-09 o stop() espera a rodada em andamento terminar e grava o que ela leu; depois dele nenhuma rodada começa', async () => {
    const { rig, hold } = await holdFirstPageAndStart();

    const stopping = track(rig.sync.stop());
    await settle(20);
    expect(stopping.settled, 'o stop() esperou a rodada').toBe(false);
    hold.release();
    await stopping.result;

    expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBe(1);
    expect(await readLastCompleted(db.pool)).not.toBeNull();
    rig.clock.advance(5 * INTERVAL_MS);
    await settle(20);
    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(1);
  });

  it('CAT-09 o stop() com o laço dormindo no intervalo termina na hora, sem esperar o próximo intervalo', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'W-005' }]);
    const rig = db.rig();
    await rig.sync.start();
    await rig.untilRounds(1);

    const stopping = track(rig.sync.stop());
    await settle(20);

    expect(stopping.settled).toBe(true);
    rig.clock.advance(10 * INTERVAL_MS);
    await settle(20);
    expect(rig.world.transport.sendsOf('listCatalog').length).toBe(1);
  });
});
