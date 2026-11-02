import type { Clock } from './clock.ts';
import { eventLogger, type AppLogger } from './logging.ts';
import { PROCESS_LOG_EVENTS } from './telemetry.ts';

// design.md, "Parâmetros": 25 s no processo; o compose dá 30 s antes do SIGKILL.
export const SHUTDOWN_TIMEOUT_MS = 25_000;

// Só o primeiro desfecho (fim, falha ou prazo) loga e sai; o que chegar
// depois seria um segundo exit com código possivelmente diferente.
function createFinisher(
  exit: (code: number) => void,
): (code: number, report: () => void) => void {
  let finished = false;
  return (code, report) => {
    if (finished) return;
    finished = true;
    report();
    exit(code);
  };
}

// FND-17: o tratador do sinal, com o prazo no relógio injetável para que o
// teste o avance sem esperar 25 s reais.
export function createShutdownHandler(options: {
  logger: AppLogger;
  stop: () => Promise<void>;
  clock: Clock;
  exit: (code: number) => void;
}): (signal: string) => void {
  const log = eventLogger(options.logger, PROCESS_LOG_EVENTS);
  let shuttingDown = false;
  const finish = createFinisher(options.exit);

  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(
      'casecellshop.process.shutdown.started',
      { signal },
      'encerramento iniciado',
    );

    void options.clock.sleep(SHUTDOWN_TIMEOUT_MS).then(() => {
      finish(1, () => {
        log.error(
          'casecellshop.process.shutdown.timed_out',
          {},
          'encerramento passou do prazo',
        );
      });
    });

    options.stop().then(
      () => {
        finish(0, () => {
          log.info(
            'casecellshop.process.shutdown.completed',
            {},
            'encerramento concluído',
          );
        });
      },
      (error: unknown) => {
        finish(1, () => {
          log.error(
            'casecellshop.process.shutdown.failed',
            { err: error },
            'falha no encerramento',
          );
        });
      },
    );
  };
}

// Encerra de forma graciosa no SIGTERM/SIGINT. `stop` deve parar de aceitar
// trabalho e esperar o que está em voo; se passar do prazo, sai com erro em
// vez de esperar o SIGKILL do Docker.
export function installGracefulShutdown(options: {
  logger: AppLogger;
  stop: () => Promise<void>;
  clock: Clock;
}): void {
  const handle = createShutdownHandler({
    ...options,
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', () => {
    handle('SIGTERM');
  });
  process.on('SIGINT', () => {
    handle('SIGINT');
  });
}
