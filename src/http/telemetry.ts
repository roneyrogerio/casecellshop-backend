// OBS-07 (AD-029): a telemetria da borda HTTP: a duração das requisições, pela convenção do OpenTelemetry, e os eventos da
// requisição.
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';
import type { LogEventSpec, MetricSpec } from '../shared/telemetry-catalog.ts';
import { metricsOf } from '../shared/telemetry-instruments.ts';
import type { Telemetry } from '../shared/telemetry.ts';

export const HTTP_METHODS = [
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

export const HTTP_METRICS = {
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
        requirement: 'required',
        values: { kind: 'enum', values: HTTP_METHODS },
      },
      [ATTR_HTTP_ROUTE]: {
        description:
          'Template da rota do contrato; ausente quando a requisição não casou com nenhuma rota.',
        requirement: 'conditionally_required',
        values: { kind: 'http_route' },
      },
      [ATTR_HTTP_RESPONSE_STATUS_CODE]: {
        description: 'Código de status da resposta.',
        requirement: 'conditionally_required',
        values: { kind: 'http_status_code' },
      },
      [ATTR_URL_SCHEME]: {
        description: 'Esquema da URL recebida.',
        requirement: 'required',
        values: { kind: 'enum', values: ['http', 'https'] },
      },
      [ATTR_ERROR_TYPE]: {
        description: 'Só nas respostas 5xx: o código de status, como texto.',
        requirement: 'conditionally_required',
        values: { kind: 'http_status_code' },
      },
    },
  },
} as const satisfies Record<string, MetricSpec>;

// Os instrumentos da borda HTTP, criados uma vez por `Telemetry` a partir da declaração acima.
export function httpMetrics(telemetry: Telemetry) {
  return metricsOf(telemetry, 'casecellshop.http', HTTP_METRICS);
}

export const HTTP_LOG_EVENTS = {
  'casecellshop.http.request.completed': {
    level: 'info',
    description:
      'Fim de uma requisição HTTP; sai como `error` quando o status é 5xx.',
    fields: ['route', 'method', 'status', 'duration_ms', 'orderId'],
  },
  'casecellshop.http.request.failed': {
    level: 'error',
    description: 'Erro sem tratamento numa rota; a resposta é o 500 genérico.',
    fields: ['err'],
  },
} as const satisfies Record<string, LogEventSpec>;
