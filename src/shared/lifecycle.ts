import type { Clock } from './clock.ts';
import { eventLogger, type AppLogger } from './logging.ts';
import { PROCESS_LOG_EVENTS } from './telemetry.ts';

// design.md, "Parâmetros": 25 s no processo; o compose dá 30 s antes do SIGKILL.
export const SHUTDOWN_TIMEOUT_MS = 25_000;

// FND-17: o tratador do sinal, com o prazo no relógio injetável (stub do M6).
export function createShutdownHandler(_options: {
  logger: AppLogger;
  stop: () => Promise<void>;
  clock: Clock;
  exit: (code: number) => void;
}): (signal: string) => void {
  throw new Error('não implementado');
}

// Encerra de forma graciosa no SIGTERM/SIGINT. `stop` deve parar de aceitar
// trabalho e esperar o que está em voo; se passar do prazo, sai com erro em
// vez de esperar o SIGKILL do Docker.
export function installGracefulShutdown(options: {
  logger: AppLogger;
  stop: () => Promise<void>;
}): void {
  const log = eventLogger(options.logger, PROCESS_LOG_EVENTS);
  let shuttingDown = false;
  const handle = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(
      'casecellshop.process.shutdown.started',
      { signal },
      'encerramento iniciado',
    );

    const deadline = setTimeout(() => {
      log.error(
        'casecellshop.process.shutdown.timed_out',
        {},
        'encerramento passou do prazo',
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    options
      .stop()
      .then(() => {
        log.info(
          'casecellshop.process.shutdown.completed',
          {},
          'encerramento concluído',
        );
        process.exit(0);
      })
      .catch((error: unknown) => {
        log.error(
          'casecellshop.process.shutdown.failed',
          { err: error },
          'falha no encerramento',
        );
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => {
    handle('SIGTERM');
  });
  process.on('SIGINT', () => {
    handle('SIGINT');
  });
}
