import { describe, expect, it } from 'vitest';
import {
  familyOf,
  metricValue,
  scrapeMetrics,
} from '../../test/helpers/metrics.ts';
import { createTelemetry } from '../shared/telemetry.ts';
import { catalogMetrics } from './telemetry.ts';

// OBS-07 (AD-029): o gauge é lido na coleta, por um callback registrado com `observe(name, callback)` (o
// TypedMetrics de src/shared/telemetry-instruments.ts): o callback recebe a função que grava o valor, e o `observe`
// devolve o remover do callback. O teste mora aqui porque um teste de `shared/` não pode importar uma pasta de
// negócio (AD-025), e o gauge real é o `casecellshop.catalog.sync.age`. O /metrics é o do exportador do Prometheus,
// sem simulação.

const SYNC_AGE = 'casecellshop.catalog.sync.age';

describe('OBS-07 observe: o gauge lido na coleta', () => {
  it('OBS-07 a coleta lê o valor que o callback grava, e cada nova coleta lê de novo', async () => {
    const telemetry = createTelemetry();
    const metrics = catalogMetrics(telemetry);
    let seconds = 12;

    metrics.observe(SYNC_AGE, (observe) => {
      observe(seconds);
    });

    expect(metricValue(await scrapeMetrics(telemetry), SYNC_AGE)).toBe(12);
    seconds = 47;
    expect(metricValue(await scrapeMetrics(telemetry), SYNC_AGE)).toBe(47);
    await telemetry.shutdown();
  });

  it('OBS-07 o callback que ainda não gravou nada não deixa ponto na coleta, e depois grava o valor atualizado a cada coleta', async () => {
    const telemetry = createTelemetry();
    const metrics = catalogMetrics(telemetry);
    let seconds: number | undefined;

    metrics.observe(SYNC_AGE, (observe) => {
      if (seconds !== undefined) observe(seconds);
    });

    const empty = await scrapeMetrics(telemetry);
    expect(familyOf(empty, SYNC_AGE)?.samples ?? []).toEqual([]);

    seconds = 0;
    expect(metricValue(await scrapeMetrics(telemetry), SYNC_AGE)).toBe(0);

    // Não se testa a volta ao "sem gravação": o SDK, com a temporalidade cumulativa do exportador Prometheus, mantém
    // o último ponto, e a especificação só desaconselha (SHOULD NOT). No desenho, a idade da sincronização só fica
    // sem gravação antes da primeira rodada completa e nunca volta a ficar.
    seconds = 7;
    expect(metricValue(await scrapeMetrics(telemetry), SYNC_AGE)).toBe(7);
    await telemetry.shutdown();
  });

  it('OBS-07 o callback assíncrono é esperado: o valor gravado depois de um await entra na coleta', async () => {
    const telemetry = createTelemetry();
    const metrics = catalogMetrics(telemetry);

    metrics.observe(SYNC_AGE, async (observe) => {
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      observe(33);
    });

    expect(metricValue(await scrapeMetrics(telemetry), SYNC_AGE)).toBe(33);
    await telemetry.shutdown();
  });

  it('OBS-07 o remover devolvido tira o callback: as coletas seguintes não o chamam mais', async () => {
    const telemetry = createTelemetry();
    const metrics = catalogMetrics(telemetry);
    let calls = 0;

    const remove = metrics.observe(SYNC_AGE, (observe) => {
      calls += 1;
      observe(calls);
    });

    await scrapeMetrics(telemetry);
    await scrapeMetrics(telemetry);
    expect(calls).toBe(2);

    remove();
    await scrapeMetrics(telemetry);
    await scrapeMetrics(telemetry);

    expect(calls).toBe(2);
    await telemetry.shutdown();
  });

  it('OBS-07 criar os instrumentos da declaração, que tem um gauge, não lança, e os outros instrumentos seguem gravando', async () => {
    const telemetry = createTelemetry();

    const metrics = catalogMetrics(telemetry);
    metrics.add('casecellshop.catalog.origin.loads', 1, {
      'casecellshop.catalog.origin.outcome': 'ok',
    });

    expect(
      metricValue(
        await scrapeMetrics(telemetry),
        'casecellshop.catalog.origin.loads',
        { 'casecellshop.catalog.origin.outcome': 'ok' },
      ),
    ).toBe(1);
    await telemetry.shutdown();
  });
});
