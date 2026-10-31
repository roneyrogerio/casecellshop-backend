import { describe, expect, it } from 'vitest';
import { createSemaphore } from './semaphore.ts';

// Deixa as continuações das promessas rodarem sem esperar tempo.
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('semáforo das chamadas ao ERP', () => {
  it('ORD-20 sem fila, quem adquire toma todas as permissões livres', async () => {
    const semaphore = createSemaphore(3);

    expect(await semaphore.acquireFree()).toBe(3);
  });

  it('ORD-20 quem espera é atendido em ordem de chegada', async () => {
    const semaphore = createSemaphore(1);
    expect(await semaphore.acquireFree()).toBe(1);
    const served: string[] = [];
    const waiting = (['B', 'C'] as const).map((name) =>
      semaphore.acquireFree().then((taken) => {
        served.push(name);
        return taken;
      }),
    );
    await flush();
    expect(served).toEqual([]);

    semaphore.release(1);
    await flush();
    expect(served).toEqual(['B']);

    semaphore.release(1);
    await flush();
    expect(served).toEqual(['B', 'C']);
    expect(await Promise.all(waiting)).toEqual([1, 1]);
  });

  it('ORD-20 quem chega no mesmo tique de um release não passa à frente de quem já esperava', async () => {
    const semaphore = createSemaphore(1);
    expect(await semaphore.acquireFree()).toBe(1);
    const served: string[] = [];
    const waitingB = semaphore.acquireFree().then((taken) => {
      served.push('B');
      return taken;
    });
    await flush();

    // A permissão volta e, no mesmo tique síncrono, C chega: B esperava antes e tem de ser atendido primeiro.
    semaphore.release(1);
    const arrivingC = semaphore.acquireFree().then((taken) => {
      served.push('C');
      return taken;
    });
    await flush();
    expect(served).toEqual(['B']);

    semaphore.release(1);
    await flush();
    expect(served).toEqual(['B', 'C']);
    expect(await Promise.all([waitingB, arrivingC])).toEqual([1, 1]);
  });
});
