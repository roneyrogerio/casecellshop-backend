// OBS-07 (AD-029): a telemetria da borda HTTP: a duração das requisições, pela convenção do OpenTelemetry, e os eventos da
// requisição. A declaração da duração mora em shared/http-metrics.ts (o `Telemetry` a cria na montagem).
import { HTTP_SERVER_METRICS } from '../shared/http-metrics.ts';
import type { LogEventSpec } from '../shared/telemetry-catalog.ts';

export const HTTP_METRICS = HTTP_SERVER_METRICS;

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
