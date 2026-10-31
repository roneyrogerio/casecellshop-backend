// Ciclo de vida comum dos laços em segundo plano (worker, relay e reconciliação): start() e
// stop() idempotentes, com a ordem das chamadas protegida.

export interface LoopRunnerOptions {
  // O laço em si: roda enquanto `isRunning()` for verdadeiro e nunca rejeita.
  run: (isRunning: () => boolean) => Promise<void>;
  // Logo depois de o estado virar 'stopping' e antes da espera: acorda um laço que dorme.
  onStopping?: () => void;
  // Espera extra do encerramento, além do laço (as tentativas em andamento do worker).
  drain?: () => Promise<unknown>;
  onStarted?: () => void;
  onStopped?: () => void;
}

export interface LoopRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  // 'stopping' é o intervalo em que o stop() espera o laço: quem recebe trabalho fora do laço
  // (o pollOnce do worker) consulta aqui.
  isStopping(): boolean;
}

export function createLoopRunner(options: LoopRunnerOptions): LoopRunner {
  // Um estado só: fora de 'stopping', start() e as rodadas diretas funcionam, inclusive depois de um stop().
  let state: 'stopped' | 'running' | 'stopping' = 'stopped';
  let stopped: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  // Ordem das chamadas a start() e stop(): um start() que esperava o stop() desiste se outro stop()
  // veio depois dele, para o último a resolver deixar o laço parado.
  let calls = 0;
  let lastStopCall = 0;

  const isRunning = () => state === 'running';

  async function waitForLoop(): Promise<void> {
    try {
      // Para de receber e espera o que está em andamento; o prazo é do lifecycle.
      await loop;
      await options.drain?.();
    } finally {
      state = 'stopped';
    }
    options.onStopped?.();
  }

  return {
    async start() {
      calls += 1;
      const mine = calls;
      // Um start() durante o stop() espera o encerramento e então reinicia, a não ser que outro stop() tenha vindo depois dele.
      while (state === 'stopping') await stopped;
      if (state === 'stopped' && lastStopCall < mine) {
        state = 'running';
        loop = options.run(isRunning);
        options.onStarted?.();
      }
    },
    // Sem `async`: devolve a própria promessa do encerramento, para quem espera nela ver o stop() antes do start().
    stop() {
      calls += 1;
      lastStopCall = calls;
      if (state === 'stopping' && stopped) return stopped;
      if (state !== 'running') return Promise.resolve();
      state = 'stopping';
      options.onStopping?.();
      stopped = waitForLoop();
      return stopped;
    },
    isStopping: () => state === 'stopping',
  };
}
