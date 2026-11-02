import type { Queue } from '../queue/sqs.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { billingMetrics } from './telemetry.ts';

// Gauge `casecellshop.queue.messages` de uma fila (OBS-02): o dono do laço o registra no start() e o remove no
// stop(), para a série existir só enquanto há quem consuma a fila. A leitura é o `ApproximateNumberOfMessages` do
// SQS, feita a cada scrape; se falhar, a série fica sem valor naquele scrape.
export function queueGaugeLifecycle(
  telemetry: Telemetry,
  queue: Queue,
  name: 'billing' | 'dlq',
): { onStarted: () => void; onStopped: () => void } {
  let remove: (() => void) | undefined;
  return {
    onStarted() {
      remove = billingMetrics(telemetry).observe(
        'casecellshop.queue.messages',
        async (observe) => {
          observe(await queue.approximateCount(), {
            'casecellshop.queue.name': name,
          });
        },
      );
    },
    onStopped() {
      remove?.();
      remove = undefined;
    },
  };
}
