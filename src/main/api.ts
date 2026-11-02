import { createApp } from '../app.ts';
import { createPool } from '../db/pool.ts';
import { envPort, requireEnv } from '../shared/config.ts';
import { installGracefulShutdown } from '../shared/lifecycle.ts';
import { createLogger, eventLogger } from '../shared/logging.ts';
import { createTelemetry } from '../shared/telemetry.ts';
import { MAIN_LOG_EVENTS } from './telemetry.ts';

const logger = createLogger({ serviceName: 'casecellshop-api' });
const telemetry = createTelemetry({ serviceName: 'casecellshop-api' });
const pool = createPool(requireEnv('DATABASE_URL'), logger);
const app = createApp({ pool, logger, telemetry });

const port = envPort('PORT', 3000);
const server = app.listen(port, () => {
  eventLogger(logger, MAIN_LOG_EVENTS).info(
    'casecellshop.api.started',
    { port },
    'API ouvindo',
  );
});

installGracefulShutdown({
  logger,
  stop: async () => {
    // Para de aceitar conexões, termina as requisições em voo e só então fecha o banco.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
    await pool.end();
    await telemetry.shutdown();
  },
});
