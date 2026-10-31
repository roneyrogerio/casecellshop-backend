import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSimulatedErpClient } from '../../../src/erp/sim/index.ts';
import { createTelemetry } from '../../../src/telemetry.ts';
import { createWorker } from '../../../src/worker.ts';
import { createManualClock } from '../../helpers/clock.ts';
import { createPool, startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('FND-04 fatura do ERP simulado sobrevive ao reinício do worker', () => {
  it('FND-04 uma fatura criada pelo ERP simulado continua lá depois de o worker reiniciar', async () => {
    const sku = 'FND04-CAPA-AZUL';
    const reference = 'pedido-fnd04-0001';
    await database.pool.query(
      'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, $3, $4)',
      [sku, 'Capa azul', 4990, 10],
    );

    const logger = pino({ level: 'silent' });
    const telemetry = createTelemetry();
    const clock = createManualClock();
    const firstErpPool = createPool(database.uri);

    // Primeira vida do worker: ele sobe e o ERP simulado fatura o pedido.
    let created: Awaited<ReturnType<ReturnType<typeof createSimulatedErpClient>['createOrder']>>;
    try {
      const firstWorker = createWorker({ pool: database.pool, erpPool: firstErpPool, logger, telemetry, clock });
      await firstWorker.start();
      const firstClient = createSimulatedErpClient({ pool: firstErpPool, clock });
      created = await firstClient.createOrder({
        reference,
        items: [{ sku, quantity: 2, unitPriceCents: 4990 }],
      });
      expect(created.reference).toBe(reference);
      await firstWorker.stop();
    } finally {
      await firstErpPool.end();
    }

    // Segunda vida: instância nova do worker e do cliente, com um pool novo sobre o mesmo banco.
    const restartedErpPool = createPool(database.uri);
    try {
      const secondWorker = createWorker({ pool: database.pool, erpPool: restartedErpPool, logger, telemetry, clock });
      await secondWorker.start();
      const secondClient = createSimulatedErpClient({ pool: restartedErpPool, clock });

      const found = await secondClient.findOrderByReference(reference);
      expect(found).toEqual(created);

      const invoices = await database.pool.query<{ total: string; total_cents: string }>(
        'SELECT count(*)::text AS total, coalesce(sum(total_cents), 0)::text AS total_cents FROM erp_sim.invoices WHERE reference = $1',
        [reference],
      );
      expect(invoices.rows[0]?.total).toBe('1');
      // H3: a fatura sai pelo preço enviado (2 x 4990).
      expect(invoices.rows[0]?.total_cents).toBe('9980');

      await secondWorker.stop();
    } finally {
      await restartedErpPool.end();
    }
  });

  it('FND-04 uma referência que o ERP simulado nunca faturou não existe depois do reinício', async () => {
    const pool = createPool(database.uri);
    try {
      const client = createSimulatedErpClient({ pool, clock: createManualClock() });
      expect(await client.findOrderByReference('pedido-fnd04-inexistente')).toBeNull();
    } finally {
      await pool.end();
    }
  });
});
