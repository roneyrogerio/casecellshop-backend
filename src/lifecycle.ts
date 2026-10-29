import type { Logger } from 'pino';

// design.md, "Parâmetros": 25 s no processo; o compose dá 30 s antes do SIGKILL.
export const SHUTDOWN_TIMEOUT_MS = 25_000;

// Encerra de forma graciosa no SIGTERM/SIGINT. `stop` deve parar de aceitar
// trabalho e esperar o que está em voo; se passar do prazo, sai com erro em
// vez de esperar o SIGKILL do Docker.
export function installGracefulShutdown(options: { logger: Logger; stop: () => Promise<void> }): void {
  let shuttingDown = false;
  const handle = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info({ event: 'shutdown_started', signal }, 'encerramento iniciado');

    const deadline = setTimeout(() => {
      options.logger.error({ event: 'shutdown_timeout' }, 'encerramento passou do prazo');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    options
      .stop()
      .then(() => {
        options.logger.info({ event: 'shutdown_completed' }, 'encerramento concluído');
        process.exit(0);
      })
      .catch((error: unknown) => {
        options.logger.error({ event: 'shutdown_failed', err: error }, 'falha no encerramento');
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
