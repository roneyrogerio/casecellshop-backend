import { createApp } from '../app.ts';
import { createStuckOrderMonitor } from '../billing/stuck-orders.ts';
import { registerOutboxAgeGauge } from '../billing/outbox-age.ts';
import { registerSyncAgeGauge } from '../catalog/sync-age.ts';
import { registerInventoryGauges } from '../checkout/inventory-gauges.ts';
import { billingMetrics } from '../billing/telemetry.ts';
import { catalogMetrics } from '../catalog/telemetry.ts';
import { checkoutMetrics } from '../checkout/telemetry.ts';
import { createPool } from '../db/pool.ts';
import { systemClock } from '../shared/clock.ts';
import { envPort, requireEnv } from '../shared/config.ts';
import { installGracefulShutdown } from '../shared/lifecycle.ts';
import { createLogger, eventLogger } from '../shared/logging.ts';
import { createTelemetry } from '../shared/telemetry.ts';
import { MAIN_LOG_EVENTS } from './telemetry.ts';

const logger = createLogger({ serviceName: 'casecellshop-api' });
const telemetry = createTelemetry({ serviceName: 'casecellshop-api' });
// OBS-08: cria já na subida os instrumentos que esta entrada grava, para as séries nascerem em 0 sem depender da
// ordem em que os módulos os pedem (o `increase()` não conta o primeiro evento de uma série que nasce com ele).
checkoutMetrics(telemetry);
catalogMetrics(telemetry);
billingMetrics(telemetry);
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

// Os sinais lidos do banco (AD-008) saem pela API, não pelo worker; cada réplica os registra, e a marca no banco
// garante que o counter de pedidos sem desfecho conte cada pedido uma vez.
const removeGauges = [
  registerOutboxAgeGauge({ pool, telemetry, logger }),
  registerSyncAgeGauge({ pool, telemetry, logger }),
  registerInventoryGauges({ pool, telemetry, logger }),
];
const stuckOrders = createStuckOrderMonitor({
  pool,
  logger,
  telemetry,
  clock: systemClock,
});
await stuckOrders.start();

installGracefulShutdown({
  logger,
  clock: systemClock,
  stop: async () => {
    // Para de aceitar conexões, termina as requisições em voo e só então fecha o banco.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
    // O monitor e os gauges usam o pool: param antes de fechá-lo.
    await stuckOrders.stop();
    for (const remove of removeGauges) remove();
    await pool.end();
    await telemetry.shutdown();
  },
});
