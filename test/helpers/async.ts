import { vi } from 'vitest';

// O relógio manual acorda os timers de forma síncrona, mas as continuações das
// promessas rodam depois. Ceder ao laço de eventos algumas vezes deixa essas
// continuações terminarem sem esperar tempo de parede (nada de sleep).
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Prazo, em tempo real, para o que o teste espera de um efeito (do worker, do relay, da reconciliação, da
// fila): igual ao `testTimeout` do projeto de integração (vitest.config.ts; conferido em test/repo). Serve só
// para a espera não ser eterna; não decide se o teste passa (FND-13). Como o timeout do teste começou a contar
// antes da espera, no projeto `integration` ele dispara primeiro: a falha de um efeito que não veio aparece
// como timeout do teste, e o prazo daqui só vale onde o timeout do Vitest é maior (ou não existe).
export const WAIT_GUARD_MS = 60_000;

// Espera um efeito com o relógio manual andando: a cada volta que falha, `advance` leva o relógio até a próxima
// espera pendente (`ManualClock.advanceToNext`, ou o `advanceIdle` do mundo do worker, que não anda com uma chamada
// ao ERP em andamento). Nunca avança um passo fixo (FND-13).
export function waitAdvancing(
  advance: () => unknown,
  check: () => void | Promise<void>,
): Promise<void> {
  return vi.waitFor(
    async () => {
      try {
        await check();
      } catch (error) {
        advance();
        throw error;
      }
    },
    { timeout: WAIT_GUARD_MS, interval: 20 },
  );
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
