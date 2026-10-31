// Semáforo em ordem de chegada para as chamadas ao ERP. O worker adquire as permissões
// antes de reivindicar, para o lease não correr enquanto a mensagem espera a vez.
export interface Semaphore {
  // Espera ao menos uma permissão livre e toma todas as que estiverem livres naquele instante.
  acquireFree(): Promise<number>;
  release(count: number): void;
}

export function createSemaphore(size: number): Semaphore {
  let free = size;
  const waiters: (() => void)[] = [];

  return {
    async acquireFree() {
      // Quem chega com permissões livres e fila não passa à frente de quem já espera.
      while (free === 0 || waiters.length > 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        if (free > 0) break;
      }
      const taken = free;
      free = 0;
      return taken;
    },
    release(count) {
      if (count <= 0) return;
      free += count;
      waiters.shift()?.();
    },
  };
}
