// Semáforo em ordem de chegada para as chamadas ao ERP. O worker adquire as permissões
// antes de reivindicar, para o lease não correr enquanto a mensagem espera a vez.
export interface Semaphore {
  // Espera ao menos uma permissão livre e toma todas as que estiverem livres naquele instante.
  acquireFree(): Promise<number>;
  release(count: number): void;
}

export function createSemaphore(size: number): Semaphore {
  let free = size;
  const waiters: ((count: number) => void)[] = [];

  return {
    acquireFree() {
      // Com fila, quem chega espera atrás dela, mesmo havendo permissão livre.
      if (free > 0 && waiters.length === 0) {
        const taken = free;
        free = 0;
        return Promise.resolve(taken);
      }
      return new Promise<number>((resolve) => waiters.push(resolve));
    },
    release(count) {
      if (count <= 0) return;
      // Entrega direta ao primeiro da fila: quem chega no mesmo tique não passa à frente.
      const next = waiters.shift();
      if (next) {
        next(free + count);
        free = 0;
      } else {
        free += count;
      }
    },
  };
}
