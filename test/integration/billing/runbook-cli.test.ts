import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countInvoices } from '../../helpers/erp.ts';
import { dlqTotal, moveToDlq } from '../../helpers/dlq.ts';
import { repoRoot as root } from '../../helpers/repo-root.ts';
import { TEST_REGION } from '../../helpers/sqs.ts';
import {
  acceptOrder,
  createWorld,
  readOrder,
  startWorkerSuite,
  submitOrder,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// A linha de comando do runbook (`node src/main/runbook.ts <comando>`): só a fiação, como processo (saída,
// código de saída, mensagem). A decisão de cada comando é provada em runbook.test.ts, em processo.

const PROCESS_TIMEOUT_MS = 40_000;

let suite: WorkerSuite;

beforeAll(async () => {
  suite = await startWorkerSuite();
}, 180_000);

afterAll(async () => {
  await suite?.stop();
});

afterEach(() => {
  suite.releaseWorlds();
});

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

// As variáveis do worker (design.md, "Fila no SQS"); as credenciais da cadeia padrão do SDK já estão no
// ambiente do teste (startElasticMq).
function runbookEnv(world: QueueWorld): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: suite.database.uri,
    SQS_ENDPOINT: world.emq.endpoint,
    AWS_REGION: TEST_REGION,
    BILLING_QUEUE_URL: world.queues.queueUrl,
    BILLING_DLQ_URL: world.queues.dlqUrl,
  };
}

function runRunbook(args: string[], env: NodeJS.ProcessEnv): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/main/runbook.ts', ...args], {
      cwd: root,
      env,
      timeout: PROCESS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Uma mensagem de erro para o operador, e não a pilha de uma exceção.
function expectClearFailure(finished: Finished): void {
  expect(finished.code, `saída do processo: ${finished.stderr}`).not.toBe(0);
  expect(finished.code, 'o processo terminou por conta própria').not.toBeNull();
  expect(finished.stderr.trim()).not.toBe('');
  expect(finished.stderr).not.toMatch(/^\s+at\s.+:\d+:\d+\)?\s*$/m);
}

describe('ORD-07 e ORD-15 linha de comando do runbook', () => {
  it('ORD-07 redrive: sai com 0, imprime quantas mensagens saíram da DLQ e a DLQ fica vazia', async () => {
    const world = await createWorld(suite, { maxReceiveCount: 1 });
    const orders = [
      await submitOrder(suite, world),
      await submitOrder(suite, world),
    ];
    await moveToDlq(world, orders.length, 1);

    const finished = await runRunbook(['redrive'], runbookEnv(world));

    expect(finished.code, finished.stderr).toBe(0);
    expect(finished.stdout).toMatch(/\b2\b/);
    expect(await dlqTotal(world)).toBe(0);
  });

  it('ORD-15 cancel <orderId>: sai com 0, imprime o resultado e deixa o pedido failed com o motivo cancelled', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);

    const finished = await runRunbook(
      ['cancel', order.orderId],
      runbookEnv(world),
    );

    expect(finished.code, finished.stderr).toBe(0);
    expect(finished.stdout.trim()).not.toBe('');
    const row = await readOrder(suite.pool, order.orderId);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('cancelled');
    expect(await countInvoices(suite.database.pool, order.orderId)).toBe(0);
  });

  it('ORD-15 cancel de um pedido que não está pending também sai com 0 e diz que nada mudou', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);
    await suite.pool.query(
      "update orders set status = 'invoiced', outcome_at = now() where id = $1",
      [order.orderId],
    );

    const finished = await runRunbook(
      ['cancel', order.orderId],
      runbookEnv(world),
    );

    expect(finished.code, finished.stderr).toBe(0);
    expect(finished.stdout.trim()).not.toBe('');
    expect((await readOrder(suite.pool, order.orderId)).status).toBe(
      'invoiced',
    );
  });

  it('ORD-15 cancel sem o orderId sai com código diferente de 0 e uma mensagem clara, sem tocar no banco', async () => {
    const world = await createWorld(suite);

    expectClearFailure(await runRunbook(['cancel'], runbookEnv(world)));
  });

  it('ORD-15 cancel com um orderId que não é um UUID sai com código diferente de 0 e uma mensagem clara', async () => {
    const world = await createWorld(suite);

    expectClearFailure(
      await runRunbook(['cancel', 'isto-nao-e-um-uuid'], runbookEnv(world)),
    );
  });

  it('ORD-07 sem comando, ou com um comando que não existe, sai com código diferente de 0 e uma mensagem clara', async () => {
    const world = await createWorld(suite);

    expectClearFailure(await runRunbook([], runbookEnv(world)));
    expectClearFailure(await runRunbook(['apagar-tudo'], runbookEnv(world)));
  });
});
