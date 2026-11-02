import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { describeCancel } from '../../../src/billing/runbook.ts';
import { countInvoices } from '../../helpers/erp.ts';
import { dlqTotal, moveToDlq } from '../../helpers/dlq.ts';
import { erpHasInvoice } from '../../helpers/erp-invoice.ts';
import {
  PAST_WINDOW_SECONDS,
  WITHIN_WINDOW_SECONDS,
} from '../../helpers/late-check.ts';
import { repoRoot as root } from '../../helpers/repo-root.ts';
import { TEST_REGION } from '../../helpers/sqs.ts';
import {
  acceptOrder,
  ageLastCall,
  createWorld,
  markSentBefore,
  readOrder,
  readOutbox,
  submitOrder,
  useWorkerSuite,
  type QueueWorld,
  type WorkerSuite,
} from '../../helpers/worker.ts';

// A linha de comando do runbook (`node src/main/runbook.ts <comando>`): só a fiação, como processo (saída,
// código de saída, mensagem). A decisão de cada comando é provada em runbook.test.ts, em processo.

const PROCESS_TIMEOUT_MS = 40_000;

const suiteOf = useWorkerSuite();
let suite: WorkerSuite;

beforeEach(() => {
  suite = suiteOf();
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

// Roda `cancel <orderId>` e confere o que vale para todo resultado (AD-031): o código de saída esperado e uma
// única linha no stdout, com o orderId.
async function cancelViaCli(
  world: QueueWorld,
  orderId: string,
  expectedCode: 0 | 1,
): Promise<Finished> {
  const finished = await runRunbook(['cancel', orderId], runbookEnv(world));
  expect(finished.code, finished.stderr).toBe(expectedCode);
  expect(finished.stdout.trim().split('\n')).toHaveLength(1);
  expect(finished.stdout).toContain(orderId);
  return finished;
}

async function expectOrderIs(
  orderId: string,
  status: string,
  failureReason: string | null,
): Promise<void> {
  const row = await readOrder(suite.pool, orderId);
  expect(row.status).toBe(status);
  expect(row.failureReason).toBe(failureReason);
}

async function markInvoiced(orderId: string): Promise<void> {
  await suite.pool.query(
    "update orders set status = 'invoiced', outcome_at = now() where id = $1",
    [orderId],
  );
}

// O cancel de um pedido faturado sai com 0 e imprime a mensagem de unchanged (AD-031); o pedido segue faturado.
async function cancelUnchangedViaCli(
  world: QueueWorld,
  orderId: string,
): Promise<Finished> {
  const finished = await cancelViaCli(world, orderId, 0);

  expect(finished.stdout.trim()).toBe(
    describeCancel(orderId, { kind: 'unchanged' }).message,
  );
  await expectOrderIs(orderId, 'invoiced', null);
  return finished;
}

describe('ORD-07 e ORD-15 linha de comando do runbook', () => {
  it('ORD-07 e OBS-09 redrive: sai com 0, imprime que 2 mensagens saíram da DLQ e quantas restam (0), e a DLQ fica vazia', async () => {
    const world = await createWorld(suite, { maxReceiveCount: 1 });
    const orders = [
      await submitOrder(suite, world),
      await submitOrder(suite, world),
    ];
    await moveToDlq(world, orders.length, 1);

    const finished = await runRunbook(['redrive'], runbookEnv(world));

    expect(finished.code, finished.stderr).toBe(0);
    // A saída diz quantas saíram da DLQ (before - remaining), e não quantas chegaram à fila (OBS-09).
    expect(finished.stdout).toContain('saíram da DLQ');
    expect(finished.stdout).toMatch(/\b2\b/);
    expect(finished.stdout).toMatch(/rest\w*\W{0,3}0\b/i);
    expect(await dlqTotal(world)).toBe(0);
  });

  it('ORD-15 cancel <orderId>: sai com 0, imprime uma linha com o orderId e deixa o pedido failed com o motivo cancelled', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);

    await cancelViaCli(world, order.orderId, 0);

    await expectOrderIs(order.orderId, 'failed', 'cancelled');
    expect(await countInvoices(suite.database.pool, order.orderId)).toBe(0);
  });

  it('ORD-26 cancel de um pedido enviado há mais que a janela de assentamento, que o ERP não tem, sai com 0 e cancela', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);
    await markSentBefore(suite.pool, order.orderId);
    await ageLastCall(suite.pool, order.orderId, PAST_WINDOW_SECONDS);

    await cancelViaCli(world, order.orderId, 0);

    await expectOrderIs(order.orderId, 'failed', 'cancelled');
  });

  it('ORD-15 cancel de um pedido que não está pending também sai com 0 e diz que nada mudou', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);
    await markInvoiced(order.orderId);

    const finished = await cancelUnchangedViaCli(world, order.orderId);

    expect(finished.code).toBe(0);
  });

  // O achado do app-check: o cancel de um pedido faturado saía com 1 ("tente de novo em cerca de 15 min") e
  // regravava last_call_at e call_token, o que reiniciava a janela da verificação tardia dele.
  for (const { name, ageSeconds, erpHasIt } of [
    {
      name: 'dentro da janela de assentamento',
      ageSeconds: WITHIN_WINDOW_SECONDS,
      erpHasIt: false,
    },
    {
      name: 'fora da janela, com a fatura no ERP',
      ageSeconds: PAST_WINDOW_SECONDS,
      erpHasIt: true,
    },
  ]) {
    it(`ORD-26 cancel de um pedido já faturado ${name} sai com 0, imprime a mensagem de unchanged e não regrava a outbox`, async () => {
      const world = await createWorld(suite);
      const order = await acceptOrder(suite);
      await markSentBefore(suite.pool, order.orderId);
      await ageLastCall(suite.pool, order.orderId, ageSeconds);
      if (erpHasIt) await erpHasInvoice(world, order);
      await markInvoiced(order.orderId);
      const before = await readOutbox(suite.pool, order.orderId);

      await cancelUnchangedViaCli(world, order.orderId);

      const after = await readOutbox(suite.pool, order.orderId);
      expect(after.lastCallAt).toEqual(before.lastCallAt);
      expect(after.callToken).toEqual(before.callToken);
      expect(after.firstSentAt).toEqual(before.firstSentAt);
      expect(after.publishedAt).toEqual(before.publishedAt);
    });
  }

  it('ORD-26 cancel com a última chamada ao ERP dentro da janela sai com 1, diz quantos minutos faltam e não muda o pedido', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);
    // Há 5 minutos: faltam cerca de 10 dos 15 da janela.
    await markSentBefore(suite.pool, order.orderId);

    const finished = await cancelViaCli(world, order.orderId, 1);

    expect(finished.stdout).toMatch(/\b(9|10)\b/);
    expect(finished.stdout).toMatch(/min/i);
    await expectOrderIs(order.orderId, 'pending', null);
  });

  it('ORD-26 cancel de um pedido que o ERP já tem sai com 1, diz que o ERP tem o pedido e não muda o pedido', async () => {
    const world = await createWorld(suite);
    const order = await acceptOrder(suite);
    await erpHasInvoice(world, order);
    await markSentBefore(suite.pool, order.orderId);
    await ageLastCall(suite.pool, order.orderId, PAST_WINDOW_SECONDS);

    const finished = await cancelViaCli(world, order.orderId, 1);

    expect(finished.stdout).toMatch(/ERP/);
    await expectOrderIs(order.orderId, 'pending', null);
    expect(await countInvoices(suite.database.pool, order.orderId)).toBe(1);
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
