import { describe, expect, it } from 'vitest';
import { familyOf, metricValue } from '../../helpers/metrics.ts';
import {
  expectOneStateLoadFailureLogged,
  holdErpPage,
  putErpProducts,
  readLastCompleted,
  ROUND_COMPLETED,
  ROUND_FAILED,
  until,
  useSyncDatabase,
} from '../../helpers/sync.ts';
import { interceptPool } from '../../helpers/worker.ts';

// CAT-15 (AD-009, "Subida com o banco fora"): a subida da sincronização com o banco fora na leitura inicial do
// last_completed_at. O worker não pode cair por isso, porque o restante do processo (relay, reconciliador) já subiu
// antes dela; a falha sai no evento próprio da leitura do estado, e não como falha de rodada.

const db = useSyncDatabase();

const AGE = 'casecellshop.catalog.sync.age';

describe('CAT-15 a subida da sincronização com o banco fora na leitura inicial da idade', () => {
  it('CAT-15 o start não rejeita, registra a falha em state.load_failed em warn com o err e sem round.failed, deixa o gauge sem ponto até a primeira rodada completa e o laço segue', async () => {
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

    // Espera a rodada prender antes de qualquer asserção: se uma falhar, a soltura do teardown acha a chamada presa.
    await hold.parked();
    expect(probe.fired, 'a falha injetada disparou').toBe(1);
    expectOneStateLoadFailureLogged(rig.logs);

    expect(familyOf(await rig.scrape(), AGE)?.samples ?? []).toEqual([]);

    hold.release();
    await until(() => {
      expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBe(1);
    });
    expect(rig.logs.eventsOf(ROUND_FAILED).length).toBe(0);
    expect(await readLastCompleted(db.pool)).not.toBeNull();
    expect(metricValue(await rig.scrape(), AGE)).toBeCloseTo(0, 3);
  });
});
