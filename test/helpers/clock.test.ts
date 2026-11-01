import { describe, expect, it } from 'vitest';
import { settle, track } from './async.ts';
import { createManualClock, watchSleeps } from './clock.ts';

// FND-13: o relógio manual dos testes só avança até a próxima espera pendente.
describe('FND-13 relógio manual: avanço até a próxima espera', () => {
  it('FND-13 pendingWaits lista os vencimentos das esperas pendentes, do mais próximo ao mais distante, e some com as acordadas', () => {
    const clock = createManualClock(1_000);
    void clock.sleep(5_000);
    void clock.sleep(500);
    void clock.sleep(10_000);

    expect(clock.pendingWaits()).toEqual([1_500, 6_000, 11_000]);

    clock.advance(500);

    expect(clock.pendingWaits()).toEqual([6_000, 11_000]);
  });

  it('FND-13 advanceToNext para exatamente no vencimento da próxima espera, acorda só ela e não passa para a seguinte', async () => {
    const clock = createManualClock(0);
    const first = track(clock.sleep(1_000));
    const second = track(clock.sleep(10_000));

    expect(clock.advanceToNext()).toBe(true);
    await settle();

    expect(clock.now()).toBe(1_000);
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);

    expect(clock.advanceToNext()).toBe(true);
    await settle();

    expect(clock.now()).toBe(10_000);
    expect(second.settled).toBe(true);
  });

  it('FND-13 advanceToNext acorda juntas as esperas que vencem no mesmo instante', async () => {
    const clock = createManualClock(0);
    const waits = [track(clock.sleep(2_000)), track(clock.sleep(2_000))];
    const later = track(clock.sleep(2_001));

    clock.advanceToNext();
    await settle();

    expect(waits.map((wait) => wait.settled)).toEqual([true, true]);
    expect(later.settled).toBe(false);
    expect(clock.now()).toBe(2_000);
  });

  it('FND-13 advanceToNext sem espera pendente devolve false e não mexe no relógio', () => {
    const clock = createManualClock(7_000);

    expect(clock.advanceToNext()).toBe(false);
    expect(clock.now()).toBe(7_000);
  });

  it('FND-13 watchSleeps anota as esperas e anda junto com o relógio de dentro', async () => {
    const inner = createManualClock(0);
    const { clock, sleeps } = watchSleeps(inner);
    const wait = track(clock.sleep(300));

    expect(sleeps).toEqual([300]);
    expect(clock.pendingWaits()).toEqual([300]);
    expect(clock.advanceToNext()).toBe(true);
    await settle();

    expect(wait.settled).toBe(true);
    expect(inner.now()).toBe(300);
    expect(clock.now()).toBe(300);
  });
});
