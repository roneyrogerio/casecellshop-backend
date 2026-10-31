import { createServer } from 'node:http';
import { systemClock } from '../clock.ts';
import { envPort, requireEnv } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { installGracefulShutdown } from '../lifecycle.ts';
import { createLogger } from '../logging.ts';
import { createTelemetry } from '../telemetry.ts';
import { createErpClient } from '../erp/acl.ts';
import { createSimulatedErp } from '../erp/sim/index.ts';
import { createWorker, DEFAULT_WORKER_CONFIG } from '../worker.ts';

const logger = createLogger({ serviceName: 'casecellshop-worker' });
const telemetry = createTelemetry({ serviceName: 'casecellshop-worker' });
const databaseUrl = requireEnv('DATABASE_URL');
// Pools separados (10 cada): a chamada ao ERP simulado não disputa conexão com a loja.
const pool = createPool(databaseUrl, logger);
const erpPool = createPool(databaseUrl, logger);

// O ERP simulado e a camada anticorrupção por cima; o modo padrão vem de ERP_SIM_MODE.
const SIM_MODES = {
  normal: { mode: 'normal' },
  slow: { mode: 'slow', delayMs: 3_000 },
  unavailable: { mode: 'unavailable' },
} as const;
const simMode = process.env['ERP_SIM_MODE'] ?? 'normal';
if (!Object.hasOwn(SIM_MODES, simMode)) throw new Error(`ERP_SIM_MODE inválido: ${simMode}`);
const sim = createSimulatedErp({ pool: erpPool, clock: systemClock });
sim.script.setDefault(SIM_MODES[simMode as keyof typeof SIM_MODES]);
const erp = createErpClient({ transport: sim.transport, clock: systemClock, timeoutMs: DEFAULT_WORKER_CONFIG.erpTimeoutMs, telemetry });
const worker = createWorker({ pool, erp, logger, telemetry, clock: systemClock });

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
