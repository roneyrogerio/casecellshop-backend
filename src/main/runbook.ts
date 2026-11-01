// Linha de comando do runbook da DLQ: `node src/main/runbook.ts redrive` e
// `node src/main/runbook.ts cancel <orderId>` (design.md, "Worker:
// reconciliação e runbook").
import { cancelOrder, redriveDlq } from '../billing/runbook.ts';
import { OrderId } from '../contract/orders.ts';
import { createPool } from '../db/pool.ts';
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
        `${before - remaining} mensagens movidas da DLQ para a fila (restam ${remaining})\n`,
      );
    } finally {
      client.destroy();
    }
  } else {
    const pool = createPool(requireEnv('DATABASE_URL'), logger);
    try {
      const { changed } = await cancelOrder(pool, orderId);
      process.stdout.write(
        changed
          ? `pedido ${orderId} cancelado\n`
          : `pedido ${orderId} não mudou: já tinha desfecho\n`,
      );
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
