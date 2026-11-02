import { describe, expect, it } from 'vitest';
import {
  failErpPageAfter,
  putErpCatalog,
  ROUND_COMPLETED,
  ROUND_FAILED,
  useSyncDatabase,
  type SyncRig,
} from '../../helpers/sync.ts';

// OBS-01 (decisão do mantenedor de 02/11/2026): o log da rodada da sincronização sai dentro do span
// `catalog.sync.round`, fora de requisição e de tentativa. Leva o trace_id e o span_id daquele span e não leva
// correlationId; os campos de identificação saem como em todo log. A regra por contexto, sem banco, está em
// src/shared/logging.test.ts.

const db = useSyncDatabase();

const IDENTIFICATION = ['time', 'level', 'service', 'env', 'version', 'msg'];

// O único span `catalog.sync.round` do teste, com os identificadores que o log tem de repetir.
async function roundSpanIds(
  rig: SyncRig,
): Promise<{ traceId: string; spanId: string }> {
  const rounds = (await rig.spans()).filter(
    (span) => span.name === 'catalog.sync.round',
  );
  expect(rounds).toHaveLength(1);
  const context = rounds[0]?.spanContext();
  return { traceId: context?.traceId ?? '', spanId: context?.spanId ?? '' };
}

function expectRoundLine(
  line: Record<string, unknown> | undefined,
  event: string,
  ids: { traceId: string; spanId: string },
): void {
  expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(line?.['event']).toBe(event);
  expect(line?.['trace_id']).toBe(ids.traceId);
  expect(line?.['span_id']).toBe(ids.spanId);
  expect(line, 'a rodada não tem requisição nem tentativa').not.toHaveProperty(
    'correlationId',
  );
  for (const key of IDENTIFICATION) expect(line, key).toHaveProperty(key);
}

describe('OBS-01 o log da rodada da sincronização leva o trace_id e o span_id do span, e não o correlationId', () => {
  it('OBS-01 round.completed sai com o trace_id e o span_id do span catalog.sync.round e sem correlationId', async () => {
    await putErpCatalog(db.erpPool, 'OBS01A', 3);
    const rig = db.rig();

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(true);
    const completed = rig.logs.eventsOf(ROUND_COMPLETED);
    expect(completed).toHaveLength(1);
    expectRoundLine(completed[0], ROUND_COMPLETED, await roundSpanIds(rig));
  });

  it('OBS-01 round.failed (o ERP fora do ar) sai com o trace_id e o span_id do span catalog.sync.round e sem correlationId', async () => {
    await putErpCatalog(db.erpPool, 'OBS01B', 3);
    const rig = db.rig();
    failErpPageAfter(rig.world, 0);

    const result = await rig.sync.runRound();

    expect(result.complete).toBe(false);
    const failed = rig.logs.eventsOf(ROUND_FAILED);
    expect(failed).toHaveLength(1);
    expectRoundLine(failed[0], ROUND_FAILED, await roundSpanIds(rig));
  });

  it('OBS-01 duas rodadas têm spans distintos, e cada log leva os identificadores do próprio span', async () => {
    await putErpCatalog(db.erpPool, 'OBS01C', 2);
    const rig = db.rig();

    await rig.sync.runRound();
    await rig.sync.runRound();

    const spans = (await rig.spans()).filter(
      (span) => span.name === 'catalog.sync.round',
    );
    const lines = rig.logs.eventsOf(ROUND_COMPLETED);
    expect(spans).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line['span_id'])).toEqual(
      spans.map((span) => span.spanContext().spanId),
    );
    expect(new Set(lines.map((line) => line['span_id'])).size).toBe(2);
    for (const line of lines) expect(line).not.toHaveProperty('correlationId');
  });
});
