import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DockerComposeEnvironment,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CheckoutAccepted, OrderStatus } from '../../../src/contract/index.ts';
import {
  expectMatchesContract,
  findRoute,
  observeFetchResponse,
  type ObservedResponse,
} from '../../helpers/contract.ts';
import { parseExposition, valueOf } from '../../helpers/metrics.ts';
import { parseQueueCountsXml, type QueueCounts } from '../../helpers/sqs.ts';

// ORD-19 no sistema subido pelo `docker compose`: um checkout chega a invoiced pelo worker.

const root = fileURLToPath(new URL('../../..', import.meta.url));
const execFileAsync = promisify(execFile);

// Credenciais locais do compose.yaml.
const DB_USER = 'casecellshop';
const DB_NAME = 'casecellshop';
// SKU do catálogo de exemplo do erp_sim (o seed do serviço migrate), com o preço e o estoque do ERP.
const SKU = 'CAPA-MOTO-G84';
const PRICE_CENTS = 4990;
const STORE_ON_HAND = 10;
const QUANTITY = 2;
// Outro SKU do seed para o teste de métricas, para o estoque do primeiro teste ser só dele.
const METRICS_SKU = 'CABO-USBC-1M';
const METRICS_PRICE_CENTS = 2990;

let environment: StartedDockerComposeEnvironment;
let projectName: string;
let apiPort: number;
let jaegerUiPort: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function composeCli(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'docker',
    ['compose', '-p', projectName, '-f', 'compose.yaml', ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        JAEGER_UI_PORT: String(jaegerUiPort),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return `${stdout}${stderr}`;
}

async function collectServiceLogs(): Promise<string> {
  try {
    return await composeCli([
      'logs',
      '--no-color',
      '--timestamps',
      '--tail',
      '200',
      'migrate',
      'postgres',
      'api',
      'worker',
    ]);
  } catch (error) {
    return `não foi possível ler os logs dos serviços: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// O catálogo da loja vem da sincronização (M4): o teste grava o SKU direto no PostgreSQL do contêiner.
// Essa semeadura por psql existe só até a sincronização do M4; então o teste passa a esperar a primeira rodada dela.
async function psql(sql: string): Promise<string> {
  const result = await environment
    .getContainer('postgres-1')
    .exec([
      'psql',
      '-U',
      DB_USER,
      '-d',
      DB_NAME,
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);
  expect(result.exitCode, `psql falhou: ${result.output}`).toBe(0);
  return result.stdout.trim();
}

beforeAll(async () => {
  apiPort = await freePort();
  jaegerUiPort = await freePort();
  projectName = `ccs-ord19-${randomBytes(4).toString('hex')}`;
  try {
    environment = await new DockerComposeEnvironment(root, 'compose.yaml')
      .withProjectName(projectName)
      .withEnvironment({
        API_PORT: String(apiPort),
        JAEGER_UI_PORT: String(jaegerUiPort),
      })
      .withBuild()
      .withStartupTimeout(240_000)
      .up();
  } catch (error) {
    const logs = await collectServiceLogs();
    await composeCli(['down', '--volumes', '--timeout', '5']).catch(
      () => undefined,
    );
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}\n\n--- logs dos serviços (migrate, postgres, api, worker; últimas 200 linhas) ---\n${logs}`,
      { cause: error },
    );
  }
  for (const [sku, name, price] of [
    [SKU, 'Capa Moto G84 antichoque', PRICE_CENTS],
    [METRICS_SKU, 'Cabo USB-C de 1 m', METRICS_PRICE_CENTS],
  ] as const) {
    await psql(
      `insert into products (sku, name, price_cents) values ('${sku}', '${name}', ${price}) on conflict (sku) do nothing`,
    );
    await psql(
      `insert into inventory (sku, on_hand, reserved) values ('${sku}', ${STORE_ON_HAND}, 0) on conflict (sku) do nothing`,
    );
  }
}, 480_000);

afterAll(async () => {
  await environment?.down({ removeVolumes: true, timeout: 5 });
}, 120_000);

async function getJson(path: string): Promise<ObservedResponse> {
  return observeFetchResponse(
    await fetch(`http://127.0.0.1:${apiPort}${path}`),
  );
}

// POST /checkout pela porta publicada, com a resposta validada pelo schema do contrato.
async function placeOrder(
  sku: string,
  quantity: number,
  priceCents: number,
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `compose-${randomUUID()}`,
    },
    body: JSON.stringify({
      items: [{ sku, quantity, expectedUnitPrice: priceCents }],
    }),
  });
  const accepted = await observeFetchResponse(response);
  expect(accepted.status).toBe(202);
  expectMatchesContract(findRoute('post', '/checkout'), accepted);
  const { orderId, status } = CheckoutAccepted.parse(accepted.body);
  expect(status).toBe('pending');
  return orderId;
}

// O worker reivindica a mensagem em até alguns segundos: o status é consultado com prazo, não com espera fixa.
async function awaitInvoiced(orderId: string): Promise<void> {
  const statusRoute = findRoute('get', '/orders/{orderId}/status');
  await vi.waitFor(
    async () => {
      const observed = await getJson(`/orders/${orderId}/status`);
      expect(observed.status).toBe(200);
      expectMatchesContract(statusRoute, observed);
      expect(OrderStatus.parse(observed.body)).toEqual({
        orderId,
        status: 'invoiced',
      });
    },
    { timeout: 90_000, interval: 500 },
  );
}

// O ElasticMQ não publica porta no host (fica na rede do compose): a leitura sai de dentro do contêiner do
// worker, que fala com ele pela API de consulta do SQS. O `ApproximateNumberOfMessages` sozinho não vê a
// mensagem em voo, então o teste lê também o `ApproximateNumberOfMessagesNotVisible`.
async function queueCounts(queueName: string): Promise<QueueCounts> {
  const url = `http://elasticmq:9324/000000000000/${queueName}?Action=GetQueueAttributes&AttributeName.1=All`;
  const script = `fetch('${url}').then((r) => r.text()).then((t) => process.stdout.write(t))`;
  const result = await environment
    .getContainer('worker-1')
    .exec(['node', '-e', script]);
  expect(result.exitCode, result.output).toBe(0);
  return parseQueueCountsXml(result.stdout);
}

describe('ORD-19 o checkout chega a invoiced no sistema subido pelo docker compose', () => {
  it('ORD-19 o POST /checkout vira invoiced pelo relay, pelo SQS e pelo worker: uma fatura no erp_sim, estoque baixado, linha publicada e a fila e a DLQ vazias', async () => {
    const orderId = await placeOrder(SKU, QUANTITY, PRICE_CENTS);

    await awaitInvoiced(orderId);

    expect(
      await psql(
        `select count(*) from erp_sim.invoices where reference = '${orderId}'`,
      ),
    ).toBe('1');
    expect(
      await psql(
        `select on_hand || ',' || reserved || ',' || sold_total from inventory where sku = '${SKU}'`,
      ),
    ).toBe(`${STORE_ON_HAND - QUANTITY},0,${QUANTITY}`);
    expect(
      await psql(
        `select published_at is not null from outbox where order_id = '${orderId}'`,
      ),
    ).toBe('t');
    // O desfecho vai ao banco antes de a mensagem ser apagada: a fila esvazia logo depois, visíveis e em voo.
    await vi.waitFor(
      async () => {
        expect(await queueCounts('billing')).toEqual({
          visible: 0,
          notVisible: 0,
        });
        expect(await queueCounts('billing-dlq')).toEqual({
          visible: 0,
          notVisible: 0,
        });
      },
      { timeout: 30_000, interval: 500 },
    );
  }, 120_000);

  it('OBS-02 o /metrics do processo do worker no compose expõe o desfecho invoiced e a chamada ao ERP depois do faturamento', async () => {
    await awaitInvoiced(await placeOrder(METRICS_SKU, 1, METRICS_PRICE_CENTS));
    // O worker não publica porta: a leitura sai de dentro do contêiner dele, na porta de métricas.
    const script =
      "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then((t) => process.stdout.write(t))";
    const result = await environment
      .getContainer('worker-1')
      .exec(['node', '-e', script]);
    expect(result.exitCode, result.output).toBe(0);

    const families = parseExposition(result.stdout);
    expect(families.get('outbox_attempt_outcome_total')?.type).toBe('counter');
    expect(
      valueOf(families, 'outbox_attempt_outcome_total', {
        outcome: 'invoiced',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      valueOf(families, 'erp_request_total', {
        operation: 'create_order',
        outcome: 'ok',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(families.get('order_accept_to_invoice_seconds')?.type).toBe(
      'histogram',
    );
  }, 60_000);
});
