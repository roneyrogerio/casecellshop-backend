import { describe, expect, it } from 'vitest';
import { createSemaphore, withPermit } from './semaphore.ts';

// Deixa as continuações das promessas rodarem sem esperar tempo.
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface Gate {
  // A função que o teste passa ao `withPermit`: registra a entrada e fica presa até `open`.
  run: () => Promise<string>;
  open(): void;
}

function gate(name: string, entered: string[], result = name): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    run: async () => {
      entered.push(name);
      await opened;
      return result;
    },
    open: () => open(),
  };
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

describe('withPermit: uma permissão por chamada ao ERP', () => {
  it('ORD-20 devolve o resultado da função e devolve a permissão ao fim: o semáforo volta a ter todas livres', async () => {
    const semaphore = createSemaphore(3);

    const result = await withPermit(semaphore, () => Promise.resolve('ok'));

    expect(result).toBe('ok');
    expect(await semaphore.acquireFree()).toBe(3);
  });

  it('ORD-20 toma uma permissão só: com a função em andamento, as outras ficam livres na hora, e a dela volta ao fim', async () => {
    const semaphore = createSemaphore(3);
    const entered: string[] = [];
    const held = gate('A', entered);
    const running = withPermit(semaphore, held.run);
    await flush();
    expect(entered).toEqual(['A']);

    // Com a função em andamento, restam 2 livres: quem adquire agora toma as duas e nenhuma a mais.
    expect(await semaphore.acquireFree()).toBe(2);
    semaphore.release(2);

    held.open();
    expect(await running).toBe('A');
    expect(await semaphore.acquireFree()).toBe(3);
  });

  it('ORD-20 devolve a permissão quando a função rejeita, e a rejeição segue para quem chamou', async () => {
    const semaphore = createSemaphore(1);
    const failure = new Error('falha do ERP');

    await expect(
      withPermit(semaphore, () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(await semaphore.acquireFree()).toBe(1);
  });

  it('ORD-20 a chamada que espera a vez entra quando a permissão da rejeitada volta, sem travar a fila', async () => {
    const semaphore = createSemaphore(1);
    const entered: string[] = [];
    let reject: (reason: Error) => void = () => undefined;
    const failing = withPermit(
      semaphore,
      () =>
        new Promise<string>((_resolve, rejectCall) => {
          entered.push('A');
          reject = rejectCall;
        }),
    );
    const next = gate('B', entered);
    const waiting = withPermit(semaphore, next.run);
    await flush();
    expect(entered).toEqual(['A']);

    reject(new Error('falha de A'));
    await expect(failing).rejects.toThrow('falha de A');
    await flush();
    expect(entered).toEqual(['A', 'B']);

    next.open();
    expect(await waiting).toBe('B');
    expect(await semaphore.acquireFree()).toBe(1);
  });

  it('ORD-20 com 1 permissão as chamadas rodam uma por vez, na ordem de chegada', async () => {
    const semaphore = createSemaphore(1);
    const entered: string[] = [];
    const gates = (['A', 'B', 'C'] as const).map((name) => gate(name, entered));
    const calls = gates.map((held) => withPermit(semaphore, held.run));
    await flush();
    expect(entered).toEqual(['A']);

    gates[0]?.open();
    await flush();
    expect(entered).toEqual(['A', 'B']);

    gates[1]?.open();
    await flush();
    expect(entered).toEqual(['A', 'B', 'C']);

    gates[2]?.open();
    expect(await Promise.all(calls)).toEqual(['A', 'B', 'C']);
  });

  it('ORD-20 com N permissões, N chamadas rodam juntas e a N+1 espera até uma terminar', async () => {
    const size = 4;
    const semaphore = createSemaphore(size);
    const entered: string[] = [];
    const names = Array.from({ length: size + 1 }, (_, index) => `C${index}`);
    const gates = names.map((name) => gate(name, entered));
    const calls = gates.map((held) => withPermit(semaphore, held.run));
    await flush();

    expect(entered).toEqual(names.slice(0, size));

    gates[2]?.open();
    await flush();
    expect(entered).toEqual(names);

    for (const held of gates) held.open();
    expect(await Promise.all(calls)).toEqual(names);
    expect(await semaphore.acquireFree()).toBe(size);
  });
});
