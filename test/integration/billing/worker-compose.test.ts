import { randomBytes, randomUUID } from 'node:crypto';
import type { StartedDockerComposeEnvironment } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CheckoutAccepted, OrderStatus } from '../../../src/contract/index.ts';
import {
  expectMatchesContract,
  findRoute,
  observeFetchResponse,
  type ObservedResponse,
} from '../../helpers/contract.ts';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import {
  publishedPort,
  runCompose,
  upComposeProject,
} from '../../helpers/compose.ts';
import {
  familyOf,
  histogramCount,
  metricValue,
  parseExposition,
} from '../../helpers/metrics.ts';
import { parseQueueCountsXml, type QueueCounts } from '../../helpers/sqs.ts';

// ORD-19 no sistema subido pelo `docker compose`: um checkout chega a invoiced pelo worker.

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
// Lida do Docker depois do `up`: a porta do host é escolhida por ele (API_PORT=0), sem janela de corrida.
let apiPort: number;

function composeCli(args: string[]): Promise<string> {
  return runCompose(projectName, args);
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
  projectName = `ccs-ord19-${randomBytes(4).toString('hex')}`;
  environment = await upComposeProject(
    projectName,
    'logs dos serviços (migrate, postgres, api, worker; últimas 200 linhas)',
    collectServiceLogs,
  );
  apiPort = publishedPort(environment, 'api-1', 3000);
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
    { timeout: 2 * WAIT_GUARD_MS, interval: 500 },
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
      { timeout: WAIT_GUARD_MS, interval: 500 },
    );
  }, 120_000);

  it('OBS-02 o /metrics do processo do worker no compose expõe o desfecho invoiced e a duração da chamada ao ERP depois do faturamento', async () => {
    await awaitInvoiced(await placeOrder(METRICS_SKU, 1, METRICS_PRICE_CENTS));
    // O worker não publica porta: a leitura sai de dentro do contêiner dele, na porta de métricas.
    const script =
      "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then((t) => process.stdout.write(t))";
    const result = await environment
      .getContainer('worker-1')
      .exec(['node', '-e', script]);
    expect(result.exitCode, result.output).toBe(0);

    const families = parseExposition(result.stdout);
    expect(familyOf(families, 'casecellshop.outbox.attempts')?.type).toBe(
      'counter',
    );
    expect(
      metricValue(families, 'casecellshop.outbox.attempts', {
        'casecellshop.outbox.attempt.outcome': 'invoiced',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      histogramCount(families, 'casecellshop.erp.client.operation.duration', {
        'casecellshop.erp.operation': 'create_order',
        'casecellshop.erp.outcome': 'ok',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      familyOf(families, 'casecellshop.order.accept_to_invoice.duration')?.type,
    ).toBe('histogram');
  }, 60_000);
});
