// OBS-07 (AD-029): junta a telemetria que cada pasta de src/ declara no próprio telemetry.ts, para a documentação
// gerada e para os testes. A aplicação não carrega este módulo: cada pasta cria os próprios instrumentos a partir
// da própria declaração. Os imports são estáticos para os nomes continuarem tipados; o teste de repositório confere
// que nenhuma pasta com telemetry.ts fica de fora e que nenhum nome se repete.
import {
  BILLING_LOG_EVENTS,
  BILLING_METRICS,
} from '../src/billing/telemetry.ts';
import {
  CHECKOUT_LOG_EVENTS,
  CHECKOUT_METRICS,
} from '../src/checkout/telemetry.ts';
import { DB_LOG_EVENTS } from '../src/db/telemetry.ts';
import { ERP_METRICS } from '../src/erp/telemetry.ts';
import { HEALTH_LOG_EVENTS } from '../src/health/telemetry.ts';
import { HTTP_LOG_EVENTS, HTTP_METRICS } from '../src/http/telemetry.ts';
import { MAIN_LOG_EVENTS } from '../src/main/telemetry.ts';
import { ORDERS_LOG_EVENTS } from '../src/orders/telemetry.ts';
import { PROCESS_LOG_EVENTS } from '../src/shared/telemetry.ts';

// Os nomes que aparecem em mais de uma declaração. Com o spread, o segundo apagaria o primeiro em silêncio.
export function repeatedNames(parts: readonly object[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of parts.flatMap((part) => Object.keys(part))) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated].sort();
}

const METRIC_PARTS = [
  HTTP_METRICS,
  CHECKOUT_METRICS,
  BILLING_METRICS,
  ERP_METRICS,
] as const;

const EVENT_PARTS = [
  HTTP_LOG_EVENTS,
  CHECKOUT_LOG_EVENTS,
  BILLING_LOG_EVENTS,
  DB_LOG_EVENTS,
  ORDERS_LOG_EVENTS,
  HEALTH_LOG_EVENTS,
  MAIN_LOG_EVENTS,
  PROCESS_LOG_EVENTS,
] as const;

const repeated = repeatedNames([...METRIC_PARTS, ...EVENT_PARTS]);
if (repeated.length > 0)
  throw new Error(`nome repetido entre as pastas: ${repeated.join(', ')}`);

export const METRICS = {
  ...HTTP_METRICS,
  ...CHECKOUT_METRICS,
  ...BILLING_METRICS,
  ...ERP_METRICS,
} as const;

export const LOG_EVENTS = {
  ...HTTP_LOG_EVENTS,
  ...CHECKOUT_LOG_EVENTS,
  ...BILLING_LOG_EVENTS,
  ...DB_LOG_EVENTS,
  ...ORDERS_LOG_EVENTS,
  ...HEALTH_LOG_EVENTS,
  ...MAIN_LOG_EVENTS,
  ...PROCESS_LOG_EVENTS,
} as const;

export type MetricName = keyof typeof METRICS;
export type LogEventName = keyof typeof LOG_EVENTS;
