import type { Clock } from '../shared/clock.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { erpMetrics, type ErpOperation, type ErpOutcome } from './telemetry.ts';
import type {
  CreateOrderResult,
  ErpCatalogItem,
  ErpCatalogPage,
  ErpClient,
  ErpOrder,
  FindOrderResult,
  ListCatalogResult,
} from './erp-client.ts';
import {
  ErpNetworkError,
  type ErpRequest,
  type ErpResponse,
  type ErpTransport,
} from './transport.ts';

export interface ErpClientOptions {
  transport: ErpTransport;
  // O timeout aborta a chamada pelo clock.sleep, para o teste controlar o tempo.
  clock: Clock;
  timeoutMs: number;
  // Sem ele, a camada não mede nada (os testes de unidade da classificação não precisam).
  telemetry?: Telemetry;
}

// Resultado interno de uma chamada: resposta, falha de rede ou timeout. Cada operação
// classifica por conta própria, porque o mesmo sinal vale coisas diferentes (ambíguo na
// criação, transitório na consulta).
type Outcome =
  | { kind: 'response'; response: ErpResponse }
  | { kind: 'network'; code: ErpNetworkError['code'] }
  | { kind: 'timeout' }
  // Rejeição que não é de rede nem o aborto do timeout: pode ter chegado ao ERP.
  | { kind: 'transport_error' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function bodyCode(body: unknown): unknown {
  return isRecord(body) ? body['code'] : undefined;
}

function parseOrder(body: unknown): ErpOrder | undefined {
  if (!isRecord(body)) return undefined;
  const { erpOrderId, reference } = body;
  if (typeof erpOrderId !== 'string' || typeof reference !== 'string')
    return undefined;
  return { erpOrderId, reference };
}

function parseCatalogItem(value: unknown): ErpCatalogItem | undefined {
  if (!isRecord(value)) return undefined;
  const { sku, name, priceCents, onHand } = value;
  if (
    typeof sku !== 'string' ||
    typeof name !== 'string' ||
    // Dinheiro em centavos inteiros e estoque nunca negativo: um valor fora disso é contrato quebrado.
    typeof priceCents !== 'number' ||
    typeof onHand !== 'number' ||
    !Number.isSafeInteger(priceCents) ||
    !Number.isSafeInteger(onHand) ||
    priceCents < 0 ||
    onHand < 0
  ) {
    return undefined;
  }
  return { sku, name, priceCents, onHand };
}

// 400, 401, 403: erro do adaptador ou credencial vencida, em toda operação.
function isConfigStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

async function call(
  { transport, clock, timeoutMs }: ErpClientOptions,
  request: ErpRequest,
): Promise<Outcome> {
  const controller = new AbortController();
  let timedOut = false;
  // O sleep do relógio injetável não se cancela: se a chamada termina antes, o abort
  // tardio cai num controlador que ninguém mais usa.
  void clock.sleep(timeoutMs).then(() => {
    timedOut = true;
    controller.abort(new Error('Timeout da chamada ao ERP'));
  });
  // Disputa com o aborto: o timeout vale mesmo que o transporte ignore o sinal, e a
  // resposta tardia dele é descartada. O race já trata a rejeição da promessa perdedora.
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error('Timeout da chamada ao ERP')),
      {
        once: true,
      },
    );
  });
  try {
    return {
      kind: 'response',
      response: await Promise.race([
        transport.send(request, controller.signal),
        aborted,
      ]),
    };
  } catch (error) {
    if (timedOut) return { kind: 'timeout' };
    if (error instanceof ErpNetworkError)
      return { kind: 'network', code: error.code };
    return { kind: 'transport_error' };
  }
}

// Mede cada operação sem mudar o resultado: duração e contagem por desfecho, a gauge de
// chamadas em voo. O desfecho (inclusive `config_error`) é atributo do histograma, cujo `_count` conta as
// chamadas. Sem `telemetry`, só repassa.
async function observe<T extends { kind: ErpOutcome }>(
  { clock, telemetry }: ErpClientOptions,
  operation: ErpOperation,
  run: () => Promise<T>,
): Promise<T> {
  if (!telemetry) return run();
  const metrics = erpMetrics(telemetry);
  const startedAt = clock.now();
  metrics.add('casecellshop.erp.client.active_operations', 1);
  let result: T | undefined;
  try {
    result = await run();
    return result;
  } finally {
    metrics.add('casecellshop.erp.client.active_operations', -1);
    // Uma exceção inesperada não tem desfecho da lista fechada: só a duração fica sem registro.
    if (result) {
      metrics.record(
        'casecellshop.erp.client.operation.duration',
        (clock.now() - startedAt) / 1000,
        {
          'casecellshop.erp.operation': operation,
          'casecellshop.erp.outcome': result.kind,
        },
      );
    }
  }
}

type Unanswered = Exclude<Outcome, { kind: 'response' }>;

// A consulta e a listagem tratam toda falha de comunicação como transitória.
function transientCause(outcome: Unanswered): string {
  return outcome.kind === 'network' ? outcome.code : outcome.kind;
}

function classifyCreateFailure(outcome: Unanswered): CreateOrderResult {
  if (outcome.kind !== 'network')
    return { kind: 'ambiguous', cause: outcome.kind };
  // ECONNRESET caiu depois do envio; os outros dois, antes.
  return outcome.code === 'ECONNRESET'
    ? { kind: 'ambiguous', cause: outcome.code }
    : { kind: 'transient', cause: outcome.code };
}

// Os status que não são sucesso nem recusa de negócio.
function classifyCreateError(status: number): CreateOrderResult {
  if (status === 429 || status === 503)
    return { kind: 'transient', cause: `http_${status}` };
  // Na criação todo 404 é erro de configuração: order_not_found só vale na consulta.
  if (isConfigStatus(status) || status === 404)
    return { kind: 'config_error', status };
  return { kind: 'ambiguous', cause: `http_${status}` };
}

function classifyCreate(outcome: Outcome): CreateOrderResult {
  if (outcome.kind !== 'response') return classifyCreateFailure(outcome);
  const { status, body } = outcome.response;
  if (status === 200 || status === 201) {
    const order = parseOrder(body);
    return order
      ? { kind: 'ok', order }
      : { kind: 'ambiguous', cause: `http_${status}_invalid_body` };
  }
  if (status === 422) {
    return {
      kind: 'permanent',
      reason: bodyCode(body) === 'out_of_stock' ? 'out_of_stock' : 'rejected',
    };
  }
  return classifyCreateError(status);
}

function classifyFind(outcome: Outcome): FindOrderResult {
  if (outcome.kind !== 'response')
    return { kind: 'transient', cause: transientCause(outcome) };
  const { status, body } = outcome.response;
  if (status === 200) {
    const order = parseOrder(body);
    return order
      ? { kind: 'found', order }
      : { kind: 'transient', cause: 'http_200_invalid_body' };
  }
  if (status === 404) {
    // Só o sinal explícito do ERP prova a inexistência; um 404 qualquer nunca leva a uma criação.
    return bodyCode(body) === 'order_not_found'
      ? { kind: 'not_found' }
      : { kind: 'config_error', status };
  }
  if (isConfigStatus(status)) return { kind: 'config_error', status };
  return { kind: 'transient', cause: `http_${status}` };
}

// Undefined quando o corpo não é uma página válida do catálogo.
function parseCatalogPage(body: unknown): ErpCatalogPage | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body['items']) ||
    typeof body['hasNext'] !== 'boolean'
  )
    return undefined;
  const items = body['items'].map(parseCatalogItem);
  if (!items.every((item): item is ErpCatalogItem => item !== undefined))
    return undefined;
  return { items, hasNext: body['hasNext'] };
}

function classifyList(outcome: Outcome): ListCatalogResult {
  if (outcome.kind !== 'response')
    return { kind: 'transient', cause: transientCause(outcome) };
  const { status, body } = outcome.response;
  const page = status === 200 ? parseCatalogPage(body) : undefined;
  if (page) return { kind: 'ok', page };
  if (status === 404 || isConfigStatus(status))
    return { kind: 'config_error', status };
  return {
    kind: 'transient',
    cause: status === 200 ? 'http_200_invalid_body' : `http_${status}`,
  };
}

// Camada anticorrupção: aplica o timeout e classifica cada resposta numa lista
// fechada, sem retry interno (o retry fica no worker).
export function createErpClient(options: ErpClientOptions): ErpClient {
  const { telemetry } = options;
  return {
    async createOrder(request) {
      const result = await observe(options, 'create_order', async () =>
        classifyCreate(
          await call(options, { op: 'createOrder', body: request }),
        ),
      );
      if (result.kind === 'permanent' && result.reason === 'out_of_stock')
        if (telemetry)
          erpMetrics(telemetry).add(
            'casecellshop.erp.out_of_stock.rejections',
            1,
          );
      return result;
    },
    findOrderByReference: (reference) =>
      observe(options, 'find_order', async () =>
        classifyFind(await call(options, { op: 'findOrder', reference })),
      ),
    listCatalog: (page) =>
      observe(options, 'list_catalog', async () =>
        classifyList(await call(options, { op: 'listCatalog', page })),
      ),
  };
}
