import { createServer } from 'node:http';
import { createReconciler } from '../billing/reconciliation.ts';
import { createRelay } from '../billing/relay.ts';
import { createWorker, DEFAULT_WORKER_CONFIG } from '../billing/worker.ts';
import { createQueue } from '../queue/sqs.ts';
import { createSqsClientFromEnv } from './sqs-client.ts';
import { createPool } from '../db/pool.ts';
import { createErpClient } from '../erp/acl.ts';
import { createSimulatedErp } from '../erp/sim/index.ts';
import { systemClock } from '../shared/clock.ts';
import { envChoice, envPort, requireEnv } from '../shared/config.ts';
import { installGracefulShutdown } from '../shared/lifecycle.ts';
import { createLogger, eventLogger } from '../shared/logging.ts';
import { createSemaphore } from '../shared/semaphore.ts';
import { createTelemetry } from '../shared/telemetry.ts';
import { MAIN_LOG_EVENTS } from './telemetry.ts';

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
const simMode = envChoice(
  'ERP_SIM_MODE',
  ['normal', 'slow', 'unavailable'],
  'normal',
);
const sim = createSimulatedErp({ pool: erpPool, clock: systemClock });
sim.script.setDefault(SIM_MODES[simMode]);
const erp = createErpClient({
  transport: sim.transport,
  clock: systemClock,
  timeoutMs: DEFAULT_WORKER_CONFIG.erpTimeoutMs,
  telemetry,
});

const sqsClient = createSqsClientFromEnv();
const billingQueue = createQueue(sqsClient, requireEnv('BILLING_QUEUE_URL'));
// Um limite só para todas as chamadas ao ERP do processo (design.md, "Worker: envio").
const semaphore = createSemaphore(DEFAULT_WORKER_CONFIG.erpConcurrency);
const worker = createWorker({
  pool,
  queue: billingQueue,
  erp,
  semaphore,
  logger,
  telemetry,
  clock: systemClock,
});
const relay = createRelay({
  pool,
  queue: billingQueue,
  logger,
  telemetry,
  clock: systemClock,
});
// A reconciliação divide o semáforo do worker: o limite de chamadas ao ERP vale para o processo todo.
const reconciler = createReconciler({
  pool,
  dlq: createQueue(sqsClient, requireEnv('BILLING_DLQ_URL')),
  erp,
  semaphore,
  logger,
  telemetry,
  clock: systemClock,
});

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
await relay.start();
await reconciler.start();
metricsServer.listen(metricsPort, () => {
  eventLogger(logger, MAIN_LOG_EVENTS).info(
    'casecellshop.worker.metrics_server.started',
    { port: metricsPort },
    'métricas do worker ouvindo',
  );
});

installGracefulShutdown({
  logger,
  stop: async () => {
    // Em conjunto: parar em sequência somaria as esperas e estouraria o prazo de encerramento.
    await Promise.all([relay.stop(), reconciler.stop(), worker.stop()]);
    sqsClient.destroy();
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
