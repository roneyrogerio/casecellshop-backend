import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_SYNC_CONFIG } from '../../../src/catalog/config.ts';
import {
  expectOneDatabaseFailureLogged,
  holdErpPage,
  putErpProducts,
  readLastCompleted,
  ROUND_COMPLETED,
  ROUND_FAILED,
  STATE_LOAD_FAILED,
  until,
  useSyncDatabase,
} from '../../helpers/sync.ts';
import { interceptPool } from '../../helpers/worker.ts';

// CAT-15 (AD-009, "Subida com o banco fora"): o worker não lê o banco na subida (a idade da sincronização é da API),
// então o banco fora na subida é a falha da primeira rodada. O start não pode rejeitar, porque o restante do processo
// (relay, reconciliador) já subiu antes dela, e as rodadas seguem.

const db = useSyncDatabase();

describe('CAT-15 a subida da sincronização com o banco fora', () => {
  it('CAT-15 o start não rejeita, a primeira rodada falha em round.failed (warn, com o err), as rodadas seguem e a primeira completa grava o last_completed_at', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'ST-001', priceCents: 1234 }]);
    // O banco fora: o primeiro comando da sincronização falha, uma vez; os seguintes passam.
    const probe = interceptPool(db.pool, {
      match: /./,
      fail: () => new Error('falha injetada pelo teste: banco fora na subida'),
      times: 1,
    });
    const rig = db.rig({ pool: probe.pool });

    await expect(rig.sync.start()).resolves.toBeUndefined();

    await rig.untilRounds(1);
    expect(probe.fired, 'a falha injetada disparou').toBe(1);
    expectOneDatabaseFailureLogged(rig.logs);
    expect(rig.logs.eventsOf(ROUND_COMPLETED)).toEqual([]);
    expect(await readLastCompleted(db.pool)).toBeNull();

    // O laço segue: a próxima rodada começa um intervalo depois, e agora o banco responde.
    await until(() => {
      rig.clock.advance(DEFAULT_CATALOG_SYNC_CONFIG.intervalMs);
      expect(rig.logs.eventsOf(ROUND_COMPLETED).length).toBeGreaterThanOrEqual(
        1,
      );
    });
    expect(rig.logs.eventsOf(ROUND_FAILED).length).toBe(1);
    expect(await readLastCompleted(db.pool)).not.toBeNull();
  });

  it('CAT-15 o start não lê o sync_state: a leitura da última rodada saiu do worker, e não há evento state.load_failed', async () => {
    await putErpProducts(db.erpPool, [{ sku: 'ST-002', priceCents: 1234 }]);
    // Só conta os SELECT em sync_state (a rodada não lê essa tabela, só a atualiza no fim).
    const probe = interceptPool(db.pool, {
      match: /select[^]*from "sync_state"/i,
    });
    const rig = db.rig({ pool: probe.pool });
    // A primeira rodada fica presa na leitura do ERP: tudo o que o start fazia no banco já aconteceu.
    const hold = holdErpPage(db, rig.world);

    await expect(rig.sync.start()).resolves.toBeUndefined();
    await hold.parked();

    expect(probe.matched, 'leituras do sync_state na subida').toBe(0);
    expect(rig.logs.eventsOf(STATE_LOAD_FAILED)).toEqual([]);
    hold.release();
  });
});
