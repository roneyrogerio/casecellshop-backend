import { eventLogger, type AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import type { AttributesOf } from '../shared/telemetry-instruments.ts';
import {
  BILLING_LOG_EVENTS,
  BILLING_METRICS,
  billingMetrics,
} from './telemetry.ts';

// O nome do gauge sai da declaração do counter, não de uma lista repetida aqui.
type GaugeName = AttributesOf<
  (typeof BILLING_METRICS)['casecellshop.billing.gauge.read_failures']
>['casecellshop.gauge.name'];

// Falha na leitura de um gauge: o gauge mantém o último valor, então o counter e o evento são o sinal para o
// alerta. Um lugar só garante que os gauges do billing reportem do mesmo jeito; devolve o `onError` do `observe`.
export function reportGaugeReadFailure(
  telemetry: Telemetry,
  logger: AppLogger,
  gauge: GaugeName,
  message: string,
): (error: unknown) => void {
  return (error) => {
    billingMetrics(telemetry).add(
      'casecellshop.billing.gauge.read_failures',
      1,
      { 'casecellshop.gauge.name': gauge },
    );
    eventLogger(logger, BILLING_LOG_EVENTS).error(
      'casecellshop.billing.gauge.read_failed',
      { gauge, err: error },
      message,
    );
  };
}
