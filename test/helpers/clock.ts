import type { Clock } from '../../src/clock.ts';

// Relógio manual para os testes, no lugar do sleep. O design.md só diz que
// `Clock` é uma porta (src/clock.ts); este formato (now, sleep, advance) é a
// suposição do test-writer e deve ser ajustado aqui se a porta for outra.
export interface ManualClock extends Clock {
  advance(ms: number): void;
}

export function createManualClock(startMs = Date.UTC(2026, 0, 1)): ManualClock {
  let current = startMs;
  const sleepers: { at: number; wake: () => void }[] = [];
  return {
    now: () => current,
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        sleepers.push({ at: current + ms, wake: resolve });
      });
    },
    advance(ms: number) {
      current += ms;
      for (const sleeper of sleepers.splice(0)) {
        if (sleeper.at <= current) sleeper.wake();
        else sleepers.push(sleeper);
      }
    },
  } as ManualClock;
}
