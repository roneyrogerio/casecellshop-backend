import type { Clock } from '../clock.ts';
import type { Telemetry } from '../telemetry.ts';
import type {
  CreateOrderResult,
  ErpCatalogItem,
  ErpClient,
  ErpOrder,
  FindOrderResult,
  ListCatalogResult,
} from './erp-client.ts';
import { ErpNetworkError, type ErpRequest, type ErpResponse, type ErpTransport } from './transport.ts';

export interface ErpClientOptions {
  transport: ErpTransport;
  // O timeout aborta a chamada pelo clock.sleep, para o teste controlar o tempo.
  clock: Clock;
  timeoutMs: number;
  // Métricas e spans entram na fatia de observabilidade do M3.
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
  if (typeof erpOrderId !== 'string' || typeof reference !== 'string') return undefined;
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

// Camada anticorrupção: aplica o timeout e classifica cada resposta numa lista
// fechada, sem retry interno (o retry fica no worker).
export function createErpClient({ transport, clock, timeoutMs }: ErpClientOptions): ErpClient {
  async function call(request: ErpRequest): Promise<Outcome> {
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
      controller.signal.addEventListener('abort', () => reject(new Error('Timeout da chamada ao ERP')), {
        once: true,
      });
    });
    try {
      return { kind: 'response', response: await Promise.race([transport.send(request, controller.signal), aborted]) };
    } catch (error) {
      if (timedOut) return { kind: 'timeout' };
      if (error instanceof ErpNetworkError) return { kind: 'network', code: error.code };
      return { kind: 'transport_error' };
    }
  }

  return {
    async createOrder(request): Promise<CreateOrderResult> {
      const outcome = await call({ op: 'createOrder', body: request });
      if (outcome.kind === 'timeout' || outcome.kind === 'transport_error') {
        return { kind: 'ambiguous', cause: outcome.kind === 'timeout' ? 'timeout' : 'transport_error' };
      }
      if (outcome.kind === 'network') {
        // ECONNRESET caiu depois do envio; os outros dois, antes.
        return outcome.code === 'ECONNRESET'
          ? { kind: 'ambiguous', cause: outcome.code }
          : { kind: 'transient', cause: outcome.code };
      }
      const { status, body } = outcome.response;
      if (status === 200 || status === 201) {
        const order = parseOrder(body);
        return order ? { kind: 'ok', order } : { kind: 'ambiguous', cause: `http_${status}_invalid_body` };
      }
      if (status === 422) {
        return { kind: 'permanent', reason: bodyCode(body) === 'out_of_stock' ? 'out_of_stock' : 'rejected' };
      }
      if (status === 429 || status === 503) return { kind: 'transient', cause: `http_${status}` };
      // Na criação todo 404 é erro de configuração: order_not_found só vale na consulta.
      if (isConfigStatus(status) || status === 404) return { kind: 'config_error', status };
      return { kind: 'ambiguous', cause: `http_${status}` };
    },

    async findOrderByReference(reference): Promise<FindOrderResult> {
      const outcome = await call({ op: 'findOrder', reference });
      if (outcome.kind === 'timeout' || outcome.kind === 'transport_error') {
        return { kind: 'transient', cause: outcome.kind };
      }
      if (outcome.kind === 'network') return { kind: 'transient', cause: outcome.code };
      const { status, body } = outcome.response;
      if (status === 200) {
        const order = parseOrder(body);
        return order ? { kind: 'found', order } : { kind: 'transient', cause: 'http_200_invalid_body' };
      }
      if (status === 404) {
        // Só o sinal explícito do ERP prova a inexistência; um 404 qualquer nunca leva a uma criação.
        return bodyCode(body) === 'order_not_found' ? { kind: 'not_found' } : { kind: 'config_error', status };
      }
      if (isConfigStatus(status)) return { kind: 'config_error', status };
      return { kind: 'transient', cause: `http_${status}` };
    },

    async listCatalog(page): Promise<ListCatalogResult> {
      const outcome = await call({ op: 'listCatalog', page });
      if (outcome.kind === 'timeout' || outcome.kind === 'transport_error') {
        return { kind: 'transient', cause: outcome.kind };
      }
      if (outcome.kind === 'network') return { kind: 'transient', cause: outcome.code };
      const { status, body } = outcome.response;
      if (
        status === 200 &&
        isRecord(body) &&
        Array.isArray(body['items']) &&
        typeof body['hasNext'] === 'boolean'
      ) {
        const items = body['items'].map(parseCatalogItem);
        if (items.every((item): item is ErpCatalogItem => item !== undefined)) {
          return { kind: 'ok', page: { items, hasNext: body['hasNext'] } };
        }
      }
      if (status === 404 || isConfigStatus(status)) return { kind: 'config_error', status };
      return { kind: 'transient', cause: status === 200 ? 'http_200_invalid_body' : `http_${status}` };
    },
  };
}
