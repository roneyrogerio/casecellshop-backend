import type { Queue } from '../queue/sqs.ts';
import type { AppLogger } from '../shared/logging.ts';
import type { Telemetry } from '../shared/telemetry.ts';
import { reportGaugeReadFailure } from './gauge-failure.ts';
import { billingMetrics } from './telemetry.ts';

// Gauge `casecellshop.queue.messages` de uma fila (OBS-02): o dono do laço o registra no start() e o remove no
// stop(), para a fila só ser consultada enquanto há quem a consuma. A leitura é o `ApproximateNumberOfMessages` do
// SQS, feita a cada scrape; se falhar, o gauge mantém o último valor, e por isso a falha vira o counter
// `read_failures` e o evento `read_failed`.
export function queueGaugeLifecycle(
  telemetry: Telemetry,
  queue: Queue,
  name: 'billing' | 'dlq',
  logger: AppLogger,
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
        {
          onError: reportGaugeReadFailure(
            telemetry,
            logger,
            'queue_messages',
            'falha ao ler o tamanho da fila',
          ),
        },
      );
    },
    onStopped() {
      remove?.();
      remove = undefined;
    },
  };
}
