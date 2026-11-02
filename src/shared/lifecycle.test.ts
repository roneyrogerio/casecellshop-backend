import { describe, expect, it } from 'vitest';
import { settle } from '#test-helpers/async.ts';
import { createManualClock } from '#test-helpers/clock.ts';
import { captureLogs } from '#test-helpers/logs.ts';
import { createShutdownHandler, SHUTDOWN_TIMEOUT_MS } from './lifecycle.ts';

// FND-17: o prazo do encerramento gracioso corre no relógio injetável. Tudo em memória: o `exit` é um registro dos
// códigos, o `stop` é uma promessa que o teste resolve ou rejeita, e o tempo só anda em advance().

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// O logger de produção (createLogger) escrevendo as linhas JSON em memória, pelo captureLogs.
function rig() {
  const logs = captureLogs('casecellshop-api');
  const clock = createManualClock();
  const exits: number[] = [];
  const stopping = deferred();
  let stopCalls = 0;
  const handler = createShutdownHandler({
    logger: logs.logger,
    clock,
    exit: (code) => {
      exits.push(code);
    },
    stop: () => {
      stopCalls += 1;
      return stopping.promise;
    },
  });
  return {
    handler,
    clock,
    exits,
    stopping,
    stopCalls: () => stopCalls,
    eventsOf: (event: string) => logs.eventsOf(event),
    events: () => logs.lines.map((line) => line['event']),
  };
}

const STARTED = 'casecellshop.process.shutdown.started';
const COMPLETED = 'casecellshop.process.shutdown.completed';
const FAILED = 'casecellshop.process.shutdown.failed';
const TIMED_OUT = 'casecellshop.process.shutdown.timed_out';

describe('FND-17 encerramento gracioso pelo relógio injetável', () => {
  it('FND-17 o prazo é de 25 s', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(25_000);
  });

  it('FND-17 stop que nunca termina: nenhum exit antes de 25 s, e aos 25 s exit(1) uma vez com o log timed_out', async () => {
    const t = rig();

    t.handler('SIGTERM');
    await settle();
    t.clock.advance(SHUTDOWN_TIMEOUT_MS - 1);
    await settle();

    expect(t.exits, 'antes do prazo não sai').toEqual([]);
    expect(t.eventsOf(TIMED_OUT)).toEqual([]);

    t.clock.advance(1);
    await settle();

    expect(t.exits).toEqual([1]);
    const timedOut = t.eventsOf(TIMED_OUT);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]?.['level']).toBe('error');
    expect(t.eventsOf(COMPLETED)).toEqual([]);
  });

  it('FND-17 stop que termina: exit(0) uma vez com o log completed, e o prazo que vence depois não sai de novo nem loga timed_out', async () => {
    const t = rig();

    t.handler('SIGTERM');
    await settle();
    expect(t.exits, 'o stop ainda não terminou').toEqual([]);
    t.stopping.resolve();
    await settle();

    expect(t.exits).toEqual([0]);
    expect(t.eventsOf(COMPLETED)).toHaveLength(1);

    t.clock.advance(SHUTDOWN_TIMEOUT_MS * 2);
    await settle();

    expect(t.exits, 'o prazo vencido depois do desfecho não faz nada').toEqual([
      0,
    ]);
    expect(t.eventsOf(TIMED_OUT)).toEqual([]);
    expect(t.eventsOf(COMPLETED)).toHaveLength(1);
  });

  it('FND-17 stop que rejeita: exit(1) uma vez com o log failed e o erro, e o prazo que vence depois não sai de novo', async () => {
    const t = rig();

    t.handler('SIGINT');
    await settle();
    t.stopping.reject(new Error('falha ao parar'));
    await settle();

    expect(t.exits).toEqual([1]);
    const failed = t.eventsOf(FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['level']).toBe('error');
    expect(JSON.stringify(failed[0]?.['err'])).toContain('falha ao parar');
    expect(t.eventsOf(COMPLETED)).toEqual([]);

    t.clock.advance(SHUTDOWN_TIMEOUT_MS * 2);
    await settle();

    expect(t.exits).toEqual([1]);
    expect(t.eventsOf(TIMED_OUT)).toEqual([]);
  });

  it('FND-17 o stop que termina depois do prazo não faz o processo sair uma segunda vez', async () => {
    const t = rig();

    t.handler('SIGTERM');
    await settle();
    t.clock.advance(SHUTDOWN_TIMEOUT_MS);
    await settle();
    expect(t.exits).toEqual([1]);

    t.stopping.resolve();
    await settle();

    expect(t.exits, 'o processo sai uma vez só').toEqual([1]);
    expect(t.eventsOf(COMPLETED)).toEqual([]);
  });

  it('FND-17 um segundo sinal é ignorado: o stop é chamado uma vez só, e não há outro log started nem outro prazo', async () => {
    const t = rig();

    t.handler('SIGTERM');
    t.handler('SIGINT');
    await settle();

    expect(t.stopCalls()).toBe(1);
    expect(t.eventsOf(STARTED)).toHaveLength(1);

    t.stopping.resolve();
    await settle();
    t.handler('SIGTERM');
    await settle();
    t.clock.advance(SHUTDOWN_TIMEOUT_MS * 2);
    await settle();

    expect(t.stopCalls(), 'nem depois do desfecho').toBe(1);
    expect(t.exits).toEqual([0]);
    expect(t.events()).toEqual([STARTED, COMPLETED]);
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'FND-17 o primeiro sinal %s loga casecellshop.process.shutdown.started em info, com o signal',
    async (signal) => {
      const t = rig();

      t.handler(signal);
      await settle();

      const started = t.eventsOf(STARTED);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ level: 'info', signal });
      expect(t.exits, 'só o início: nada de saída ainda').toEqual([]);
    },
  );
});
