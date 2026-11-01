import { describe, expect, it } from 'vitest';
import { createLoopRunner, type LoopRunner, type LoopRunnerOptions } from './loop-runner.ts';

// Deixa as continuações das promessas rodarem, sem relógio nem temporizador.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Cada chamada a `run` fica registrada e só termina quando o teste manda: o laço é controlado por promessa.
function createLoopHarness() {
  const runs: { isRunning: () => boolean; finish: () => void }[] = [];
  const run: LoopRunnerOptions['run'] = (isRunning) => {
    const loop = deferred();
    runs.push({ isRunning, finish: loop.resolve });
    return loop.promise;
  };
  return { runs, run };
}

async function resolvedWithin(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await settle();
  return done;
}

// Versão ingênua do controle negativo: só uma flag `running`, sem a contagem de chamadas. É o que o
// createLoopRunner seria sem a proteção de ordem do A28.
function createNaiveRunner(options: LoopRunnerOptions): LoopRunner {
  let running = false;
  let stopping: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  return {
    async start() {
      if (stopping) await stopping;
      if (!running) {
        running = true;
        loop = options.run(() => running);
      }
    },
    stop() {
      if (stopping) return stopping;
      if (!running) return Promise.resolve();
      running = false;
      options.onStopping?.();
      const finished = (async () => {
        await loop;
        await options.drain?.();
      })().finally(() => {
        stopping = undefined;
      });
      stopping = finished;
      return finished;
    },
    isStopping: () => stopping !== undefined,
  };
}

// stop(), start() e stop() chamados sem esperar um ao outro: o start() pendente tem de desistir.
async function runPendingStartScenario(create: (options: LoopRunnerOptions) => LoopRunner) {
  const harness = createLoopHarness();
  const runner = create({ run: harness.run });
  await runner.start();
  const firstStop = runner.stop();
  const pendingStart = runner.start();
  const secondStop = runner.stop();
  await settle();
  harness.runs[0]?.finish();
  await Promise.all([firstStop, pendingStart, secondStop]);
  return {
    loopsStarted: harness.runs.length,
    anyLoopStillRunning: harness.runs.some((entry) => entry.isRunning()),
  };
}

describe('executor de laço (createLoopRunner)', () => {
  it('ORD-20 um segundo start() com o laço rodando não abre outro laço', async () => {
    const harness = createLoopHarness();
    const runner = createLoopRunner({ run: harness.run });

    await runner.start();
    await runner.start();

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.isRunning()).toBe(true);
  });

  it('ORD-20 o stop() só resolve depois de o laço terminar e o drain acabar, nessa ordem', async () => {
    const harness = createLoopHarness();
    const drain = deferred();
    const events: string[] = [];
    const runner = createLoopRunner({
      run: harness.run,
      drain: () => {
        events.push('drain começou');
        return drain.promise.then(() => {
          events.push('drain terminou');
        });
      },
      onStopped: () => events.push('onStopped'),
    });
    await runner.start();

    const stopping = runner.stop().then(() => events.push('stop resolveu'));
    await settle();
    expect(events, 'o drain não roda enquanto o laço não terminou').toEqual([]);
    expect(harness.runs[0]?.isRunning(), 'o laço é avisado de que deve parar').toBe(false);

    harness.runs[0]?.finish();
    await settle();
    expect(events, 'o laço terminou, o drain começou e o stop() ainda espera').toEqual(['drain começou']);

    drain.resolve();
    await stopping;
    expect(events).toEqual(['drain começou', 'drain terminou', 'onStopped', 'stop resolveu']);
    expect(runner.isStopping()).toBe(false);
  });

  it('ORD-20 um stop() com o laço parado resolve sem chamar onStopping nem drain', async () => {
    let calls = 0;
    const runner = createLoopRunner({
      run: createLoopHarness().run,
      onStopping: () => (calls += 1),
      drain: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    await runner.stop();

    expect(calls).toBe(0);
  });

  it('ORD-20 stop(), start() e stop() em sequência: o segundo stop() para de fato o laço novo', async () => {
    const harness = createLoopHarness();
    const runner = createLoopRunner({ run: harness.run });
    await runner.start();

    const firstStop = runner.stop();
    harness.runs[0]?.finish();
    await firstStop;
    await runner.start();
    expect(harness.runs, 'o start() depois do stop() abre um laço novo').toHaveLength(2);
    expect(harness.runs[1]?.isRunning()).toBe(true);

    const secondStop = runner.stop();
    expect(harness.runs[1]?.isRunning(), 'o segundo stop() manda o laço novo parar').toBe(false);
    expect(await resolvedWithin(secondStop), 'o segundo stop() espera o laço novo terminar').toBe(false);
    harness.runs[1]?.finish();
    await secondStop;

    expect(runner.isStopping()).toBe(false);
    expect(harness.runs.some((entry) => entry.isRunning())).toBe(false);
  });

  it('ORD-20 um stop() chamado enquanto um start() está pendente faz esse start() desistir', async () => {
    const outcome = await runPendingStartScenario(createLoopRunner);

    expect(outcome.loopsStarted, 'o start() pendente não abre um segundo laço').toBe(1);
    expect(outcome.anyLoopStillRunning).toBe(false);
  });

  it('ORD-20 controle negativo: a versão ingênua, só com a flag running, abre um laço que sobra no start() pendente', async () => {
    const outcome = await runPendingStartScenario(createNaiveRunner);

    expect(outcome.loopsStarted).toBe(2);
    expect(outcome.anyLoopStillRunning).toBe(true);
  });

  it('ORD-20 um start() chamado depois de um stop() que já resolveu volta a rodar', async () => {
    const harness = createLoopHarness();
    const runner = createLoopRunner({ run: harness.run });
    await runner.start();
    const stopping = runner.stop();
    harness.runs[0]?.finish();
    await stopping;

    await runner.start();

    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.isRunning()).toBe(true);
  });

  it('ORD-14 o onStopping roda no stop() antes da espera do laço e já com o estado em stopping', async () => {
    const harness = createLoopHarness();
    const events: string[] = [];
    let stoppingInsideHook: boolean | undefined;
    let runningInsideHook: boolean | undefined;
    // O gancho precisa do runner, que recebe o gancho: a referência é preenchida logo abaixo.
    const ref: { runner?: LoopRunner } = {};
    const runner = createLoopRunner({
      run: harness.run,
      onStopping: () => {
        events.push('onStopping');
        stoppingInsideHook = ref.runner?.isStopping();
        runningInsideHook = harness.runs[0]?.isRunning();
      },
    });
    ref.runner = runner;
    await runner.start();

    const stopping = runner.stop().then(() => events.push('stop resolveu'));
    expect(events, 'o onStopping roda de forma síncrona no stop()').toEqual(['onStopping']);
    expect(stoppingInsideHook).toBe(true);
    expect(runningInsideHook, 'o laço já vê isRunning() falso quando o gancho acorda a espera').toBe(false);
    await settle();
    expect(events, 'o stop() ainda espera o laço').toEqual(['onStopping']);

    harness.runs[0]?.finish();
    await stopping;
    expect(events).toEqual(['onStopping', 'stop resolveu']);
  });

  it('ORD-14 o onStopping acorda um laço que dorme, e o stop() resolve sem outro empurrão', async () => {
    const wake = deferred();
    const runner = createLoopRunner({
      // Laço que dorme até ser acordado, como a espera da reconciliação.
      run: async (isRunning) => {
        while (isRunning()) await wake.promise;
      },
      onStopping: () => wake.resolve(),
    });
    await runner.start();

    await runner.stop();

    expect(runner.isStopping()).toBe(false);
  });

  it('ORD-22 chamado duas vezes durante o encerramento, o stop() devolve o mesmo encerramento e chama o onStopping uma vez', async () => {
    const harness = createLoopHarness();
    let hookCalls = 0;
    const runner = createLoopRunner({ run: harness.run, onStopping: () => (hookCalls += 1) });
    await runner.start();

    const first = runner.stop();
    const second = runner.stop();
    harness.runs[0]?.finish();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(hookCalls).toBe(1);
  });
});
