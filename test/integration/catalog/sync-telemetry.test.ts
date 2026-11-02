import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { counterValue, seedCatalog, skuRange } from '../../helpers/catalog.ts';
import {
  familyOf,
  metricValue,
  type Exposition,
} from '../../helpers/metrics.ts';
import {
  failErpPageAfter,
  olderReadFinishesAfterNewer,
  putErpCatalog,
  putErpProducts,
  readLastCompleted,
  ROUND_COMPLETED,
  ROUND_FAILED,
  useSyncDatabase,
} from '../../helpers/sync.ts';
import { interceptPool } from '../../helpers/worker.ts';

// OBS-02 e OBS-07 da sincronização: os contadores de correção e de SKU ausente, o gauge da idade, o span da rodada
// e os dois eventos de log, todos lidos de onde o operador os vê (o /metrics, os spans e as linhas de log).

const db = useSyncDatabase();

const CORRECTIONS = 'casecellshop.catalog.sync.corrections';
const FIELD = 'casecellshop.catalog.sync.field';
const MISSING = 'casecellshop.catalog.sync.missing_skus';
const AGE = 'casecellshop.catalog.sync.age';

describe('OBS-02 as correções por campo e os SKUs ausentes da sincronização no /metrics', () => {
  it('OBS-02 cada campo que o ERP corrige soma uma vez no contador por campo, e uma segunda rodada sem divergência não soma nada', async () => {
    await seedCatalog(db.pool, [
      { sku: 'T-001', name: 'Antigo', priceCents: 1000, onHand: 5 },
      { sku: 'T-002', name: 'Igual', priceCents: 2000, onHand: 7 },
      { sku: 'T-003', name: 'Capinha T-003', priceCents: 3000, onHand: 5 },
      { sku: 'T-004', name: 'Capinha T-004', priceCents: 3000, onHand: 3 },
    ]);
    await putErpProducts(db.erpPool, [
      { sku: 'T-001', name: 'Novo', priceCents: 1500, onHand: 5 },
      { sku: 'T-002', name: 'Igual', priceCents: 2000, onHand: 7 },
      { sku: 'T-003', name: 'Capinha T-003', priceCents: 3000, onHand: 9 },
      { sku: 'T-004', name: 'Capinha T-004', priceCents: 3100, onHand: 3 },
    ]);
    const rig = db.rig();

    await rig.sync.runRound();

    const fields = async () => {
      const families = await rig.scrape();
      return (['price', 'name', 'on_hand'] as const).map((field) =>
        counterValue(families, CORRECTIONS, { [FIELD]: field }),
      );
    };
    // price: T-001 e T-004; name: T-001; on_hand: T-003.
    expect(await fields()).toEqual([2, 1, 1]);

    await rig.sync.runRound();

    expect(await fields()).toEqual([2, 1, 1]);
  });

  it('OBS-02 o comando que não afeta a linha (leitura mais antiga que a gravada) não conta correção, e a rodada que a gravou conta', async () => {
    const { older, newer } = await olderReadFinishesAfterNewer(db, 'T-010');

    for (const field of ['price', 'name', 'on_hand'] as const) {
      expect(
        counterValue(await newer.scrape(), CORRECTIONS, { [FIELD]: field }),
        `correções de ${field} da rodada mais nova`,
      ).toBe(1);
      expect(
        counterValue(await older.scrape(), CORRECTIONS, { [FIELD]: field }),
        `correções de ${field} da rodada mais antiga`,
      ).toBe(0);
    }
  });

  it('OBS-02 cada SKU ausente zerado soma uma vez no contador de SKUs ausentes, e o evento de fim traz os SKUs lidos, os ausentes e a duração', async () => {
    const present = skuRange('T', 3, 20);
    const absent = skuRange('T', 2, 23);
    await seedCatalog(
      db.pool,
      [...present, ...absent].map((sku) => ({ sku, onHand: 5 })),
    );
    await putErpProducts(
      db.erpPool,
      present.map((sku) => ({ sku, onHand: 5 })),
    );
    const rig = db.rig();

    const result = await rig.sync.runRound();

    expect(result).toEqual({ complete: true, skuCount: 3, missingCount: 2 });
    expect(counterValue(await rig.scrape(), MISSING)).toBe(2);
    const [completed] = rig.logs.eventsOf(ROUND_COMPLETED);
    expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBe(1);
    expect(completed?.['level']).toBe('info');
    expect(completed?.['skuCount']).toBe(3);
    expect(completed?.['missingCount']).toBe(2);
    expect(completed?.['duration_ms']).toBeTypeOf('number');
    expect(completed?.['duration_ms']).toBeGreaterThanOrEqual(0);
    expect(rig.logs.eventsOf(ROUND_FAILED)).toEqual([]);
  });

  it('OBS-02 a rodada que falha numa página do ERP escreve o evento de falha com a causa e a página, em warn, e não conta SKU ausente', async () => {
    await seedCatalog(db.pool, [{ sku: 'T-999', onHand: 5 }]);
    await putErpCatalog(db.erpPool, 'T', 120);
    const rig = db.rig();
    failErpPageAfter(rig.world, 1);

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(false);
    const failures = rig.logs.eventsOf(ROUND_FAILED);
    expect(failures.length).toBe(1);
    expect(failures[0]?.['level']).toBe('warn');
    expect(failures[0]?.['cause']).toBe('ECONNREFUSED');
    expect(failures[0]?.['page']).toBe(2);
    expect(rig.logs.eventsOf(ROUND_COMPLETED)).toEqual([]);
    expect(counterValue(await rig.scrape(), MISSING)).toBe(0);
  });

  it('OBS-02 a rodada que falha no banco escreve o evento de falha com o err, em warn, e não grava last_completed_at', async () => {
    await seedCatalog(db.pool, [{ sku: 'T-050' }]);
    await putErpProducts(db.erpPool, [{ sku: 'T-050', priceCents: 1234 }]);
    const probe = interceptPool(db.pool, {
      match: /"products"/i,
      fail: () => new Error('falha injetada pelo teste'),
    });
    const rig = db.rig({ pool: probe.pool });

    // Se a falha do banco sai como rejeição ou como rodada incompleta, o desenho não diz; o laço sobrevive nos dois.
    await rig.sync.runRound().catch(() => undefined);

    expect(probe.fired, 'a falha injetada disparou').toBeGreaterThan(0);
    const failures = rig.logs.eventsOf(ROUND_FAILED);
    expect(failures.length).toBe(1);
    expect(failures[0]?.['level']).toBe('warn');
    expect(failures[0]?.['err']).toBeDefined();
    expect(failures[0]?.['cause']).toBeUndefined();
    expect(rig.logs.eventsOf(ROUND_COMPLETED)).toEqual([]);
    expect(await readLastCompleted(db.pool)).toBeNull();
  });
});

function samplesOfAge(families: Exposition) {
  return familyOf(families, AGE)?.samples ?? [];
}

describe('OBS-07 o gauge da idade da última rodada completa', () => {
  it('OBS-07 não tem ponto antes da primeira rodada completa, nem depois de uma rodada incompleta', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'G-001' }]);
    const rig = db.rig();

    expect(samplesOfAge(await rig.scrape())).toEqual([]);

    failErpPageAfter(rig.world);
    const result = await rig.sync.runRound();

    expect(result.complete).toBe(false);
    expect(samplesOfAge(await rig.scrape())).toEqual([]);
  });

  it('OBS-07 depois de uma rodada completa a idade é 0 e cresce com o relógio; uma rodada incompleta não a zera, e a próxima completa sim', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'G-002' }]);
    const rig = db.rig();
    await rig.sync.runRound();

    expect(metricValue(await rig.scrape(), AGE)).toBeCloseTo(0, 3);

    rig.clock.advance(42_000);
    expect(metricValue(await rig.scrape(), AGE)).toBeCloseTo(42, 3);

    rig.clock.advance(58_000);
    failErpPageAfter(rig.world);
    expect((await rig.sync.runRound()).complete).toBe(false);
    expect(metricValue(await rig.scrape(), AGE)).toBeCloseTo(100, 3);

    expect((await rig.sync.runRound()).complete).toBe(true);
    expect(metricValue(await rig.scrape(), AGE)).toBeCloseTo(0, 3);
  });

  it('OBS-07 na subida lê o last_completed_at do banco: com o ERP fora, a idade parte dos 90 s gravados e cresce com o relógio', async () => {
    await db.pool.query(
      "update sync_state set last_completed_at = now() - interval '90 seconds'",
    );
    const rig = db.rig();
    rig.world.sim.script.setDefault({ mode: 'unavailable' });

    await rig.sync.start();
    await rig.untilRounds(1);

    expect(rig.logs.eventsOf(ROUND_COMPLETED)).toEqual([]);
    const age = metricValue(await rig.scrape(), AGE);
    expect(age).toBeGreaterThanOrEqual(90);
    expect(age).toBeLessThan(95);

    rig.clock.advance(30_000);
    const later = metricValue(await rig.scrape(), AGE);
    expect(later).toBeGreaterThanOrEqual(120);
    expect(later).toBeLessThan(125);
  });
});

describe('OBS-07 o span da rodada da sincronização', () => {
  it('OBS-07 cada rodada gera um span catalog.sync.round, pai das chamadas ao ErpClient da rodada', async () => {
    await putErpCatalog(db.erpPool, 'SP', 120);
    // O ErpClient embrulhado abre um span por chamada, no lugar dos spans que o ErpClient abrirá: o que o teste
    // confere é que a sincronização chama o ErpClient dentro do span da rodada.
    const rig = db.rig({
      erp: ({ world, telemetry }) => ({
        ...world.erp,
        listCatalog: (page) =>
          telemetry.withSpan(
            'erp.list_catalog',
            { kind: SpanKind.CLIENT },
            () => world.erp.listCatalog(page),
          ),
      }),
    });

    await rig.sync.runRound();
    await rig.sync.runRound();

    const spans = await rig.spans();
    const rounds = spans.filter((span) => span.name === 'catalog.sync.round');
    const calls = spans.filter((span) => span.name === 'erp.list_catalog');
    expect(rounds.length).toBe(2);
    expect(calls.length).toBe(6);
    for (const round of rounds) {
      const children = calls.filter(
        (call) => call.parentSpanContext?.spanId === round.spanContext().spanId,
      );
      expect(children.length, 'chamadas filhas da rodada').toBe(3);
      for (const child of children)
        expect(child.spanContext().traceId).toBe(round.spanContext().traceId);
    }
  });

  it('OBS-07 a rodada incompleta, com o ERP fora, também gera o span catalog.sync.round', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'SP-900' }]);
    const rig = db.rig();
    failErpPageAfter(rig.world);

    expect((await rig.sync.runRound()).complete).toBe(false);

    const rounds = (await rig.spans()).filter(
      (span) => span.name === 'catalog.sync.round',
    );
    expect(rounds.length).toBe(1);
  });
});
