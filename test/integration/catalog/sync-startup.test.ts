import { describe, expect, it } from 'vitest';
import { familyOf, metricValue } from '../../helpers/metrics.ts';
import {
  expectOneDatabaseFailureLogged,
  holdErpPage,
  putErpProducts,
  readLastCompleted,
  ROUND_COMPLETED,
  until,
  useSyncDatabase,
} from '../../helpers/sync.ts';
import { interceptPool } from '../../helpers/worker.ts';

// A subida da sincronização (AD-009) com o banco fora na leitura inicial do last_completed_at: o worker não pode
// cair por isso, porque o restante do processo (relay, reconciliador) já subiu antes dela.

const db = useSyncDatabase();

const AGE = 'casecellshop.catalog.sync.age';

describe('OBS-07 a subida da sincronização com o banco fora na leitura inicial da idade', () => {
  it('OBS-07 o start não rejeita, registra a falha em warn com o err, deixa o gauge sem ponto até a primeira rodada completa e o laço segue', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'ST-001', priceCents: 1234 }]);
    // Só a leitura do last_completed_at (um SELECT em sync_state) falha, uma vez; a rodada não lê essa tabela.
    const probe = interceptPool(db.pool, {
      match: /select[^]*from "sync_state"/i,
      fail: () => new Error('falha injetada pelo teste: banco fora na subida'),
      times: 1,
    });
    const rig = db.rig({ pool: probe.pool });
    // A primeira rodada fica presa na leitura do ERP: o gauge é lido antes de ela completar.
    const hold = holdErpPage(db, rig.world);

    await expect(rig.sync.start()).resolves.toBeUndefined();

    expect(probe.fired, 'a falha injetada disparou').toBe(1);
    expectOneDatabaseFailureLogged(rig.logs);

    await hold.parked();
    expect(familyOf(await rig.scrape(), AGE)?.samples ?? []).toEqual([]);

    hold.release();
    await until(() => {
      expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBe(1);
    });
    expect(await readLastCompleted(db.pool)).not.toBeNull();
    expect(metricValue(await rig.scrape(), AGE)).toBeCloseTo(0, 3);
  });
});
