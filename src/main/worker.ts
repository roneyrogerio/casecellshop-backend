import { createServer } from 'node:http';
import { systemClock } from '../clock.ts';
import { envPort, requireEnv } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { installGracefulShutdown } from '../lifecycle.ts';
import { createLogger } from '../logging.ts';
import { createTelemetry } from '../telemetry.ts';
import { createWorker } from '../worker.ts';

const logger = createLogger({ serviceName: 'casecellshop-worker' });
const telemetry = createTelemetry({ serviceName: 'casecellshop-worker' });
const databaseUrl = requireEnv('DATABASE_URL');
// Pools separados (10 cada): a chamada ao ERP simulado não disputa conexão com a loja.
const pool = createPool(databaseUrl, logger);
const erpPool = createPool(databaseUrl, logger);
const worker = createWorker({ pool, erpPool, logger, telemetry, clock: systemClock });

// O worker não tem API; expõe só o /metrics.
const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    telemetry.metricsHandler(req, res);
    return;
  }
  res.statusCode = 404;
  res.end();
});
const metricsPort = envPort('WORKER_METRICS_PORT', 9464);

await worker.start();
metricsServer.listen(metricsPort, () => {
  logger.info({ event: 'worker_metrics_started', port: metricsPort }, 'métricas do worker ouvindo');
});

installGracefulShutdown({
  logger,
  stop: async () => {
    await worker.stop();
    await new Promise<void>((resolve, reject) => {
      metricsServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      metricsServer.closeAllConnections();
    });
    await pool.end();
    await erpPool.end();
    await telemetry.shutdown();
  },
});
