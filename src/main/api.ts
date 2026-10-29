import { createApp } from '../app.ts';
import { envPort, requireEnv } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { installGracefulShutdown } from '../lifecycle.ts';
import { createLogger } from '../logging.ts';
import { createTelemetry } from '../telemetry.ts';

const logger = createLogger({ service: 'api' });
const telemetry = createTelemetry({ serviceName: 'casecellshop-api' });
const pool = createPool(requireEnv('DATABASE_URL'), logger);
const app = createApp({ pool, logger, telemetry });

const port = envPort('PORT', 3000);
const server = app.listen(port, () => {
  logger.info({ event: 'api_started', port }, 'API ouvindo');
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
