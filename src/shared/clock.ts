// Porta do relógio dos timers do processo. Prazos gravados no banco usam o
// relógio do banco (AGENTS.md); este serve a timeouts, esperas e intervalos,
// e os testes o trocam por um relógio manual para não precisar de sleep.
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
