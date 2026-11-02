import { describe, expect, it } from 'vitest';
import { MIN_CALL_DELAY_MS, SETTLE_WINDOW_MS } from './call-permit.ts';
import { DEFAULT_LATE_CHECK_CONFIG } from './late-check.ts';

// Parâmetros da verificação tardia (design.md, "Parâmetros"): intervalo de 5 min, até 100 pedidos por rodada,
// janela de assentamento de 15 min e atraso mínimo de 45 s para a permissão de chamada do pedido falho.

describe('ORD-23 parâmetros da verificação tardia', () => {
  it('ORD-23 o padrão é a rodada de 5 min com até 100 pedidos, a janela de assentamento de 15 min e o atraso mínimo de 45 s', () => {
    expect(DEFAULT_LATE_CHECK_CONFIG).toEqual({
      intervalMs: 300_000,
      maxOrders: 100,
      settleWindowMs: 900_000,
      minDelayMs: 45_000,
    });
  });

  it('ORD-23 a janela e o atraso mínimo da verificação são os mesmos da permissão de chamada, que o worker, a reconciliação e o cancelamento partilham', () => {
    expect(DEFAULT_LATE_CHECK_CONFIG.settleWindowMs).toBe(SETTLE_WINDOW_MS);
    expect(DEFAULT_LATE_CHECK_CONFIG.minDelayMs).toBe(MIN_CALL_DELAY_MS);
  });

  it('ORD-23 a janela de assentamento é bem maior que a H4 (40 s) e cabe antes da DLQ (~23 min em média)', () => {
    expect(DEFAULT_LATE_CHECK_CONFIG.settleWindowMs).toBeGreaterThan(
      40_000 * 10,
    );
    expect(DEFAULT_LATE_CHECK_CONFIG.settleWindowMs).toBeLessThan(23 * 60_000);
  });
});
