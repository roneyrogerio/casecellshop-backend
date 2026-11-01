import type { Clock } from '../../src/shared/clock.ts';

// Relógio manual para os testes, no lugar do sleep. O design.md só diz que
// `Clock` é uma porta (src/shared/clock.ts); este formato (now, sleep, advance) é a
// suposição do test-writer e deve ser ajustado aqui se a porta for outra.
export interface ManualClock extends Clock {
  advance(ms: number): void;
  // Instantes em que as esperas pendentes vencem, do mais próximo ao mais distante.
  pendingWaits(): readonly number[];
  // Avança até o vencimento da próxima espera pendente, sem passar dela, e a acorda (e as que vencem junto).
  // Devolve `false`, sem mexer no relógio, quando não há espera pendente. É o avanço dos testes que esperam
  // por um efeito: um passo fixo por volta de uma espera real passaria por cima do timeout de uma chamada (FND-13).
  advanceToNext: () => boolean;
}

export function createManualClock(startMs = Date.UTC(2026, 0, 1)): ManualClock {
  let current = startMs;
  const sleepers: { at: number; wake: () => void }[] = [];
  function advance(ms: number): void {
    current += ms;
    for (const sleeper of sleepers.splice(0)) {
      if (sleeper.at <= current) sleeper.wake();
      else sleepers.push(sleeper);
    }
  }
  function pendingWaits(): readonly number[] {
    return sleepers.map((sleeper) => sleeper.at).sort((a, b) => a - b);
  }
  return {
    now: () => current,
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        sleepers.push({ at: current + ms, wake: resolve });
      });
    },
    advance,
    pendingWaits,
    advanceToNext() {
      const [next] = pendingWaits();
      if (next === undefined) return false;
      advance(Math.max(0, next - current));
      return true;
    },
  };
}

// Anota cada espera pedida ao relógio, para o teste só avançá-lo depois de o laço ter dormido: sem isso o
// avanço cairia no vazio e o laço esperaria para sempre. O relógio devolvido anda junto com o `inner`.
export function watchSleeps(inner: ManualClock = createManualClock()): {
  clock: ManualClock;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  const clock: ManualClock = {
    ...inner,
    sleep(ms) {
      sleeps.push(ms);
      return inner.sleep(ms);
    },
  };
  return { clock, sleeps };
}
