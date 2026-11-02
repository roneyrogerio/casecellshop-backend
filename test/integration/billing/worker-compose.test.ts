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
  closedList,
  expectSeriesAtZero,
  expectSeriesAtZeroForEach,
  readProcessMetrics,
} from '../../helpers/compose-metrics.ts';
import {
  familyOf,
  histogramCount,
  metricValue,
  parseExposition,
  promLabel,
  promName,
  valueOf,
} from '../../helpers/metrics.ts';
import { parseQueueCountsXml, type QueueCounts } from '../../helpers/sqs.ts';

// ORD-19 no sistema subido pelo `docker compose`: um checkout chega a invoiced pelo worker.

// Credenciais locais do compose.yaml.
const DB_USER = 'casecellshop';
const DB_NAME = 'casecellshop';
// SKU do catálogo de exemplo do erp_sim (o seed do serviço migrate), com o preço e o estoque do ERP.
const SKU = 'CAPA-MOTO-G84';
const PRICE_CENTS = 4990;
const QUANTITY = 2;
// Outro SKU do seed para o teste de métricas, para o estoque do primeiro teste ser só dele.
const METRICS_SKU = 'CABO-USBC-1M';
const METRICS_PRICE_CENTS = 2990;

let environment: StartedDockerComposeEnvironment;
let projectName: string;
// Lida do Docker depois do `up`: a porta do host é escolhida por ele (API_PORT=0), sem janela de corrida.
let apiPort: number;
// O estoque do SKU no erp_sim, lido antes do checkout: a sincronização do worker o grava na loja na primeira rodada.
let erpOnHand: number;

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

// Consulta direta ao PostgreSQL do contêiner, para ler o erp_sim e o estado da loja.
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
  erpOnHand = await awaitFirstSyncRound();
}, 480_000);

// O catálogo da loja vem do ERP simulado pela sincronização do worker (AD-009), que roda na subida e a cada 60 s.
// O GET /products só responde 200 depois da primeira rodada completa: o checkout espera por ela, sem corrida com
// o estoque que a rodada grava. Devolve o estoque do SKU no erp_sim, que a rodada deixou na loja.
async function awaitFirstSyncRound(): Promise<number> {
  await vi.waitFor(
    async () => {
      expect((await getJson('/products')).status).toBe(200);
    },
    { timeout: 2 * WAIT_GUARD_MS, interval: 500 },
  );
  const onHand = await psql(
    `select on_hand from erp_sim.products where sku = '${SKU}'`,
  );
  expect(
    await psql(`select on_hand from inventory where sku = '${SKU}'`),
    'o estoque da loja vem do ERP simulado',
  ).toBe(onHand);
  return Number(onHand);
}

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

// OBS-08: este bloco vem antes de qualquer checkout do arquivo (os testes de um arquivo rodam na ordem em que são
// declarados); o `beforeAll` só espera a primeira rodada da sincronização, pelo GET /products, que não grava nenhum
// dos counters abaixo.
describe('OBS-08 logo depois da subida, antes do primeiro checkout, os dois /metrics trazem em 0 as séries dos counters', () => {
  const GAUGE_NAME = 'casecellshop.gauge.name';
  const OPERATION = 'casecellshop.erp.operation';

  it('OBS-08 o /metrics da API traz em 0 o pedido sem desfecho, cada desfecho do checkout, as falhas de leitura dos gauges e as tentativas da outbox', async () => {
    const families = await readProcessMetrics(environment, 'api-1', 3000);

    expectSeriesAtZero(families, 'casecellshop.order.stuck');
    expectSeriesAtZeroForEach(
      families,
      'casecellshop.checkout.requests',
      'casecellshop.checkout.outcome',
    );
    expectSeriesAtZero(families, 'casecellshop.checkout.gauge.read_failures', {
      [GAUGE_NAME]: 'inventory',
    });
    expectSeriesAtZero(families, 'casecellshop.catalog.gauge.read_failures', {
      [GAUGE_NAME]: 'catalog_sync_age',
    });
    for (const gauge of ['queue_messages', 'outbox_oldest_pending_age'])
      expectSeriesAtZero(families, 'casecellshop.billing.gauge.read_failures', {
        [GAUGE_NAME]: gauge,
      });
    // Uma pasta usada pelos dois processos sai em 0 nos dois, inclusive nos counters que só o worker soma.
    expectSeriesAtZeroForEach(
      families,
      'casecellshop.outbox.attempts',
      'casecellshop.outbox.attempt.outcome',
    );
    // O gauge e o histograma ficam de fora: a série deles nasce da leitura e da medição, não da subida.
    expect(
      familyOf(families, 'casecellshop.order.accept_to_invoice.duration')
        ?.samples ?? [],
      'o histograma não nasce em 0',
    ).toEqual([]);
  }, 60_000);

  it('OBS-08 o /metrics do worker traz em 0 a rejeição por falta de estoque, o erro de configuração por operação, a conclusão sem efeito e as falhas de leitura dos gauges', async () => {
    const families = await readProcessMetrics(environment, 'worker-1', 9464);

    expectSeriesAtZero(families, 'casecellshop.erp.out_of_stock.rejections');
    expectSeriesAtZeroForEach(
      families,
      'casecellshop.erp.config_errors',
      OPERATION,
    );
    // A leitura do banco do ERP (count_invoices) não usa a API e não tem erro de configuração: a série não existe.
    for (const operation of ['create_order', 'find_order', 'list_catalog'])
      expectSeriesAtZero(families, 'casecellshop.erp.config_errors', {
        [OPERATION]: operation,
      });
    expect(
      familyOf(families, 'casecellshop.erp.config_errors')?.samples.map(
        (sample) => sample.labels[promLabel(OPERATION)],
      ),
    ).not.toContain('count_invoices');
    expectSeriesAtZero(families, 'casecellshop.outbox.orphan_conclusions');
    for (const gauge of ['queue_messages', 'outbox_oldest_pending_age'])
      expectSeriesAtZero(families, 'casecellshop.billing.gauge.read_failures', {
        [GAUGE_NAME]: gauge,
      });
    expectSeriesAtZeroForEach(
      families,
      'casecellshop.outbox.attempts',
      'casecellshop.outbox.attempt.outcome',
    );
    expectSeriesAtZero(families, 'casecellshop.outbox.published.messages');
    expectSeriesAtZero(families, 'casecellshop.catalog.gauge.read_failures', {
      [GAUGE_NAME]: 'catalog_sync_age',
    });
    expectSeriesAtZero(families, 'casecellshop.catalog.sync.missing_skus');
  }, 60_000);

  // A primeira rodada da sincronização já correu (o `beforeAll` a espera), e a spec não diz que o primeiro
  // carregamento de uma loja vazia conta como correção (a correção é o campo que divergia do valor guardado no t0):
  // por isso o teste afirma que a série de cada campo existe e é um contador, não que vale 0.
  it('OBS-08 o /metrics do worker expõe a série de correções da sincronização para cada campo, mesmo antes de qualquer divergência', async () => {
    const families = await readProcessMetrics(environment, 'worker-1', 9464);

    for (const field of closedList(
      'casecellshop.catalog.sync.corrections',
      'casecellshop.catalog.sync.field',
    ))
      expect(
        valueOf(families, promName('casecellshop.catalog.sync.corrections'), {
          casecellshop_catalog_sync_field: field,
        }),
        `correções do campo ${field}`,
      ).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

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
    ).toBe(`${erpOnHand - QUANTITY},0,${QUANTITY}`);
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

  it('OBS-02 o /metrics do processo da API no compose expõe os gauges lidos do banco: idade da sincronização, idade da outbox e o estoque', async () => {
    // Os gauges lidos do banco saem pela API, não pelo worker (AD-008): nenhum outro teste sobe o main/api.ts, então
    // só este vê se ele registra cada um. A leitura sai de dentro do contêiner da API, como a do worker.
    const script =
      "fetch('http://127.0.0.1:3000/metrics').then((r) => r.text()).then((t) => process.stdout.write(t))";
    const result = await environment
      .getContainer('api-1')
      .exec(['node', '-e', script]);
    expect(result.exitCode, result.output).toBe(0);

    const families = parseExposition(result.stdout);
    const gauges = [
      'casecellshop.catalog.sync.age',
      'casecellshop.outbox.oldest_pending.age',
      'casecellshop.inventory.reserved',
      'casecellshop.inventory.oversold_skus',
    ] as const;
    for (const gauge of gauges) {
      expect(familyOf(families, gauge)?.type, `${gauge} é um gauge`).toBe(
        'gauge',
      );
      // Sem atributos: uma série só; a primeira rodada completa (esperada no beforeAll) já deu valor à idade da
      // sincronização, que não grava ponto sem rodada completa.
      expect(
        metricValue(families, gauge),
        `${gauge} tem valor`,
      ).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});
