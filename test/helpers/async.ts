// O relógio manual acorda os timers de forma síncrona, mas as continuações das
// promessas rodam depois. Ceder ao laço de eventos algumas vezes deixa essas
// continuações terminarem sem esperar tempo de parede (nada de sleep).
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Acompanha uma promessa sem esperá-la, para o teste afirmar que ela ainda
// não terminou antes de o relógio chegar ao prazo.
export function track<T>(promise: Promise<T>): {
  readonly settled: boolean;
  result: Promise<T>;
} {
  const state = { settled: false };
  const result = promise.finally(() => {
    state.settled = true;
  });
  // O teste espera `result`; sem este tratamento, uma rejeição antes disso seria não tratada.
  result.catch(() => undefined);
  return {
    get settled() {
      return state.settled;
    },
    result,
  };
}
