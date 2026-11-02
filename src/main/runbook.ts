// Linha de comando do runbook da DLQ: `node src/main/runbook.ts redrive` e
// `node src/main/runbook.ts cancel <orderId>` (design.md, "Worker:
// reconciliação e runbook").
import { cancelOrder, describeCancel, redriveDlq } from '../billing/runbook.ts';
import { DEFAULT_WORKER_CONFIG } from '../billing/worker.ts';
import { OrderId } from '../contract/orders.ts';
import { createPool } from '../db/pool.ts';
import { createErpClient } from '../erp/acl.ts';
import { createSimulatedErp } from '../erp/sim/index.ts';
import { systemClock } from '../shared/clock.ts';
import { requireEnv } from '../shared/config.ts';
import { createLogger } from '../shared/logging.ts';
import { createSqsClientFromEnv } from './sqs-client.ts';

const USAGE = 'uso: node src/main/runbook.ts redrive | cancel <orderId>';

// Erro de uso vai para o stderr, sem pilha, e o processo sai com código diferente de 0.
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [command, orderIdArgument] = process.argv.slice(2);
if (command !== 'redrive' && command !== 'cancel')
  fail(`comando ausente ou desconhecido. ${USAGE}`);
let orderId = '';
if (command === 'cancel') {
  const parsed = OrderId.safeParse(orderIdArgument);
  if (!parsed.success)
    fail(`o orderId é obrigatório e deve ser um UUID. ${USAGE}`);
  orderId = parsed.data;
}

let exitCode = 0;
const logger = createLogger({ serviceName: 'casecellshop-runbook' });
try {
  if (command === 'redrive') {
    const client = createSqsClientFromEnv();
    try {
      const { before, remaining } = await redriveDlq({
        client,
        dlqUrl: requireEnv('BILLING_DLQ_URL'),
        clock: systemClock,
      });
      process.stdout.write(
        `${before - remaining} mensagens saíram da DLQ (restam ${remaining})\n`,
      );
    } finally {
      client.destroy();
    }
  } else {
    const pool = createPool(requireEnv('DATABASE_URL'), logger);
    try {
      // O ERP simulado e a camada anticorrupção, como no worker: o cancelamento consulta o ERP antes (AD-031).
      const sim = createSimulatedErp({ pool, clock: systemClock });
      const erp = createErpClient({
        transport: sim.transport,
        invoiceReader: sim.invoiceReader,
        clock: systemClock,
        timeoutMs: DEFAULT_WORKER_CONFIG.erpTimeoutMs,
      });
      const { message, failed } = describeCancel(
        orderId,
        await cancelOrder({ pool, erp }, orderId),
      );
      process.stdout.write(`${message}\n`);
      if (failed) exitCode = 1;
    } finally {
      await pool.end();
    }
  }
} catch (error) {
  process.stderr.write(
    `falha no runbook: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  exitCode = 1;
}
process.exitCode = exitCode;
