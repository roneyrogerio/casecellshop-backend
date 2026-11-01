// OBS-07 (AD-029): o catálogo das métricas, fonte única dos nomes, das unidades e dos valores dos atributos.
// O código cria os instrumentos a partir dele, e a documentação (.specs/features/casecellshop/telemetry.md) é
// gerada dele. Os nomes seguem a regra de nomes do OpenTelemetry: ponto entre namespaces, snake_case dentro de
// cada um, unidade no `unit` e nada de `_total`; o que é próprio do serviço começa por `casecellshop.`.
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';

// Os valores que um atributo aceita. A lista fechada (`values`) é a regra; o código de status HTTP (inteiro
// de 100 a 599) e a rota (o template da rota do contrato, ou `unmatched`) têm cardinalidade limitada pela
// própria forma, e não por uma lista.
export type AttributeValues =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'http_status_code' }
  | { readonly kind: 'http_route' };

export interface AttributeSpec {
  readonly description: string;
  readonly values: AttributeValues;
}

export type InstrumentKind = 'counter' | 'histogram' | 'up_down_counter';

export interface MetricSpec {
  readonly instrument: InstrumentKind;
  // UCUM: `s` para tempo; uma anotação entre chaves (`{request}`) para contagem.
  readonly unit: string;
  readonly description: string;
  // Só nos histogramas: as fronteiras, ligadas aos SLOs (AD-029).
  readonly buckets?: readonly number[];
  readonly attributes: Readonly<Record<string, AttributeSpec>>;
}

const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
  '_OTHER',
] as const;

const CHECKOUT_OUTCOMES = [
  'accepted',
  'replay',
  'out_of_stock',
  'price_changed',
  'invalid',
  'unavailable',
] as const;

const ATTEMPT_OUTCOMES = [
  'invoiced',
  'failed',
  'retry',
  'deferred',
  'closed',
  'lease_short',
  'dead',
] as const;

const ERP_OPERATIONS = ['create_order', 'find_order', 'list_catalog'] as const;

const ERP_OUTCOMES = [
  'ok',
  'found',
  'not_found',
  'permanent',
  'transient',
  'ambiguous',
  'config_error',
] as const;

const erpOperation: AttributeSpec = {
  description: 'Operação da porta ErpClient.',
  values: { kind: 'enum', values: ERP_OPERATIONS },
};

export const METRICS = {
  [METRIC_HTTP_SERVER_REQUEST_DURATION]: {
    instrument: 'histogram',
    unit: 's',
    description: 'Duração das requisições HTTP, base dos SLOs de latência.',
    // As fronteiras recomendadas pela convenção, mais 0.2, o limiar do SLO da vitrine.
    buckets: [
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 2.5, 5,
      7.5, 10,
    ],
    attributes: {
      [ATTR_HTTP_REQUEST_METHOD]: {
        description: 'Método HTTP; um método fora da lista vira `_OTHER`.',
        values: { kind: 'enum', values: HTTP_METHODS },
      },
      [ATTR_HTTP_ROUTE]: {
        description: 'Template da rota do contrato, ou `unmatched`.',
        values: { kind: 'http_route' },
      },
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: {
        description: 'Código de status da resposta.',
        values: { kind: 'http_status_code' },
      },
      [ATTR_URL_SCHEME]: {
        description: 'Esquema da URL recebida.',
        values: { kind: 'enum', values: ['http', 'https'] },
      },
      [ATTR_ERROR_TYPE]: {
        description: 'Só nas respostas 5xx: o código de status, como texto.',
        values: { kind: 'http_status_code' },
      },
    },
  },
  'casecellshop.checkout.requests': {
    instrument: 'counter',
    unit: '{request}',
    description: 'Checkouts por desfecho.',
    attributes: {
      'casecellshop.checkout.outcome': {
        description: 'Desfecho do checkout.',
        values: { kind: 'enum', values: CHECKOUT_OUTCOMES },
      },
    },
  },
  'casecellshop.outbox.attempts': {
    instrument: 'counter',
    unit: '{attempt}',
    description:
      'Tentativas da outbox por desfecho; o `dead` é contado pela reconciliação.',
    attributes: {
      'casecellshop.outbox.attempt.outcome': {
        description: 'Desfecho da tentativa.',
        values: { kind: 'enum', values: ATTEMPT_OUTCOMES },
      },
    },
  },
  'casecellshop.outbox.orphan_conclusions': {
    instrument: 'counter',
    unit: '{conclusion}',
    description:
      'Conclusões que não afetaram linha porque o token já não valia.',
    attributes: {},
  },
  'casecellshop.outbox.published.messages': {
    instrument: 'counter',
    unit: '{message}',
    description: 'Linhas da outbox publicadas no SQS pelo relay.',
    attributes: {},
  },
  'casecellshop.order.accept_to_invoice.duration': {
    instrument: 'histogram',
    unit: 's',
    description: 'Tempo do aceite do pedido até o faturamento no ERP.',
    // Do aceite ao faturamento pode levar minutos (H4, backoff): a fronteira em 60 separa o normal do lento.
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
    attributes: {},
  },
  'casecellshop.erp.client.operation.duration': {
    instrument: 'histogram',
    unit: 's',
    description:
      'Duração das chamadas ao ERP, por operação e desfecho; o `_count` conta as chamadas.',
    // A chamada vai até o timeout de 10 s com folga; a última fronteira é 30.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    attributes: {
      'casecellshop.erp.operation': erpOperation,
      'casecellshop.erp.outcome': {
        description: 'Desfecho da chamada, pela lista fechada da porta.',
        values: { kind: 'enum', values: ERP_OUTCOMES },
      },
    },
  },
  'casecellshop.erp.client.active_operations': {
    instrument: 'up_down_counter',
    unit: '{operation}',
    description: 'Chamadas ao ERP em andamento.',
    attributes: {},
  },
  'casecellshop.erp.out_of_stock.rejections': {
    instrument: 'counter',
    unit: '{order}',
    description: 'Pedidos que o ERP recusou por falta de estoque.',
    attributes: {},
  },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof METRICS;
