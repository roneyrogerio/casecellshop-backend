import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.ts';
import {
  createLoopRunner,
  type LoopRunner,
  type LoopRunnerOptions,
  type SleepingLoopRunner,
} from './loop-runner.ts';

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

// Relógio manual local: os testes de src/shared/ não importam test/helpers (AD-025). O tempo só anda em advance().
function createManualClock(): Clock & { advance: (ms: number) => void } {
  let current = 0;
  const timers: { at: number; wake: () => void }[] = [];
  return {
    now: () => current,
    sleep: (ms) =>
      new Promise<void>((wake) => {
        timers.push({ at: current + ms, wake });
      }),
    advance(ms) {
      current += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= current) timer.wake();
        else timers.push(timer);
      }
    },
  };
}

// Laço que dorme em `pause(intervalMs)` a cada volta, como a reconciliação e o monitor de pedidos sem desfecho.
function createSleepingLoop(intervalMs: number, clock: Clock) {
  const state = { iterations: 0, endedStopping: [] as boolean[] };
  const runner: SleepingLoopRunner = createLoopRunner({
    clock,
    run: async (isRunning) => {
      while (isRunning()) {
        state.iterations += 1;
        await runner.pause(intervalMs);
      }
      // Quando o laço acorda, o estado já tem de ser 'stopping' (o stop() ainda espera por ele).
      state.endedStopping.push(runner.isStopping());
    },
  });
  return { runner, state };
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
async function runPendingStartScenario(
  create: (options: LoopRunnerOptions) => LoopRunner,
) {
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
    expect(
      harness.runs[0]?.isRunning(),
      'o laço é avisado de que deve parar',
    ).toBe(false);

    harness.runs[0]?.finish();
    await settle();
    expect(
      events,
      'o laço terminou, o drain começou e o stop() ainda espera',
    ).toEqual(['drain começou']);

    drain.resolve();
    await stopping;
    expect(events).toEqual([
      'drain começou',
      'drain terminou',
      'onStopped',
      'stop resolveu',
    ]);
    expect(runner.isStopping()).toBe(false);
  });

  it('ORD-20 um stop() com o laço parado resolve sem chamar o drain', async () => {
    let calls = 0;
    const runner = createLoopRunner({
      run: createLoopHarness().run,
      drain: () => {
        calls += 1;
        return Promise.resolve();
      },
      onStopped: () => {
        calls += 1;
      },
    });

    await runner.stop();

    expect(calls).toBe(0);
    expect(runner.isStopping()).toBe(false);
  });

  it('ORD-20 stop(), start() e stop() em sequência: o segundo stop() para de fato o laço novo', async () => {
    const harness = createLoopHarness();
    const runner = createLoopRunner({ run: harness.run });
    await runner.start();

    const firstStop = runner.stop();
    harness.runs[0]?.finish();
    await firstStop;
    await runner.start();
    expect(
      harness.runs,
      'o start() depois do stop() abre um laço novo',
    ).toHaveLength(2);
    expect(harness.runs[1]?.isRunning()).toBe(true);

    const secondStop = runner.stop();
    expect(
      harness.runs[1]?.isRunning(),
      'o segundo stop() manda o laço novo parar',
    ).toBe(false);
    expect(
      await resolvedWithin(secondStop),
      'o segundo stop() espera o laço novo terminar',
    ).toBe(false);
    harness.runs[1]?.finish();
    await secondStop;

    expect(runner.isStopping()).toBe(false);
    expect(harness.runs.some((entry) => entry.isRunning())).toBe(false);
  });

  it('ORD-20 um stop() chamado enquanto um start() está pendente faz esse start() desistir', async () => {
    const outcome = await runPendingStartScenario(createLoopRunner);

    expect(
      outcome.loopsStarted,
      'o start() pendente não abre um segundo laço',
    ).toBe(1);
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

  it('ORD-14 o stop() muda o estado para stopping antes de esperar o laço, e só resolve quando o laço termina', async () => {
    const harness = createLoopHarness();
    const events: string[] = [];
    const runner = createLoopRunner({ run: harness.run });
    await runner.start();

    const stopping = runner.stop().then(() => events.push('stop resolveu'));
    expect(
      runner.isStopping(),
      'o estado já é stopping na volta síncrona do stop()',
    ).toBe(true);
    expect(harness.runs[0]?.isRunning(), 'o laço já vê isRunning() falso').toBe(
      false,
    );
    await settle();
    expect(events, 'o stop() ainda espera o laço').toEqual([]);

    harness.runs[0]?.finish();
    await stopping;
    expect(events).toEqual(['stop resolveu']);
    expect(runner.isStopping()).toBe(false);
  });

  it('ORD-14 o stop() acorda o laço que dorme em pause() sem o relógio andar, já com o estado em stopping', async () => {
    const clock = createManualClock();
    const { runner, state } = createSleepingLoop(60_000, clock);
    await runner.start();
    await settle();
    expect(state.iterations, 'o laço fez a primeira volta e dorme').toBe(1);

    const stopping = runner.stop();

    expect(
      await resolvedWithin(stopping),
      'o stop() não espera o intervalo inteiro',
    ).toBe(true);
    expect(clock.now(), 'o relógio não andou').toBe(0);
    expect(state.iterations, 'o laço não começou outra volta').toBe(1);
    expect(
      state.endedStopping,
      'o laço acordou com o runner em stopping',
    ).toEqual([true]);
    expect(runner.isStopping()).toBe(false);
  });

  it('OBS-04 sem stop(), o sono do pause() termina quando o relógio passa o intervalo, e não antes', async () => {
    const clock = createManualClock();
    const { runner, state } = createSleepingLoop(1000, clock);
    await runner.start();
    await settle();
    expect(state.iterations).toBe(1);

    clock.advance(999);
    await settle();
    expect(state.iterations, 'faltando 1 ms o laço ainda dorme').toBe(1);

    clock.advance(1);
    await settle();
    expect(state.iterations, 'no intervalo cheio o laço acorda').toBe(2);

    clock.advance(1000);
    await settle();
    expect(state.iterations, 'e dorme de novo pelo intervalo seguinte').toBe(3);

    const stopping = runner.stop();
    await stopping;
    expect(state.iterations).toBe(3);
  });

  it('ORD-14 um pause() chamado depois de o stop() começar resolve na hora, sem o relógio andar', async () => {
    const clock = createManualClock();
    const harness = createLoopHarness();
    const runner = createLoopRunner({ run: harness.run, clock });
    await runner.start();

    // O laço ainda não terminou: o runner fica em stopping enquanto o teste chama o pause().
    const stopping = runner.stop();
    expect(runner.isStopping()).toBe(true);

    const late = runner.pause(60_000);

    expect(
      await resolvedWithin(late),
      'o pause() tardio não dorme o intervalo',
    ).toBe(true);
    expect(clock.now()).toBe(0);

    harness.runs[0]?.finish();
    await stopping;
  });

  it('ORD-22 chamado duas vezes durante o encerramento, o stop() devolve o mesmo encerramento e roda o drain uma vez', async () => {
    const harness = createLoopHarness();
    let drainCalls = 0;
    const runner = createLoopRunner({
      run: harness.run,
      drain: () => {
        drainCalls += 1;
        return Promise.resolve();
      },
    });
    await runner.start();

    const first = runner.stop();
    const second = runner.stop();
    harness.runs[0]?.finish();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(drainCalls).toBe(1);
  });
});
