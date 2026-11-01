// OBS-07 (AD-029): a telemetria do faturamento: o relay, o worker e a reconciliação.
import type { LogEventSpec, MetricSpec } from '../shared/telemetry-catalog.ts';
import { metricsOf } from '../shared/telemetry-instruments.ts';
import type { Telemetry } from '../shared/telemetry.ts';

const ATTEMPT_OUTCOMES = [
  'invoiced',
  'failed',
  'retry',
  'deferred',
  'closed',
  'lease_short',
  'dead',
] as const;

export const BILLING_METRICS = {
  'casecellshop.outbox.attempts': {
    instrument: 'counter',
    unit: '{attempt}',
    description:
      'Tentativas da outbox por desfecho; o `dead` é contado pela reconciliação.',
    attributes: {
      'casecellshop.outbox.attempt.outcome': {
        description: 'Desfecho da tentativa.',
        requirement: 'required',
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
} as const satisfies Record<string, MetricSpec>;

// Os instrumentos do faturamento, criados uma vez por `Telemetry` a partir da declaração acima.
export function billingMetrics(telemetry: Telemetry) {
  return metricsOf(telemetry, 'casecellshop.billing', BILLING_METRICS);
}

export const BILLING_LOG_EVENTS = {
  'casecellshop.worker.started': {
    level: 'info',
    description: 'O worker começou a receber da fila.',
    fields: [],
  },
  'casecellshop.worker.stopped': {
    level: 'info',
    description: 'O worker parou de receber da fila.',
    fields: [],
  },
  'casecellshop.worker.poll.failed': {
    level: 'error',
    description: 'O recebimento da fila falhou; o worker tenta de novo.',
    fields: ['err'],
  },
  'casecellshop.outbox.relay.started': {
    level: 'info',
    description: 'O relay começou a publicar a outbox.',
    fields: [],
  },
  'casecellshop.outbox.relay.stopped': {
    level: 'info',
    description: 'O relay parou.',
    fields: [],
  },
  'casecellshop.outbox.relay.failed': {
    level: 'error',
    description: 'Uma rodada do relay falhou; a próxima tenta de novo.',
    fields: ['err'],
  },
  'casecellshop.outbox.row.rejected': {
    level: 'error',
    description:
      'Uma linha da outbox não forma uma mensagem válida e não é publicada.',
    fields: ['orderId'],
  },
  'casecellshop.outbox.message.rejected': {
    level: 'error',
    description:
      'Uma mensagem da fila não segue o schema e vai para a DLQ sem chamar o ERP.',
    fields: ['attempt', 'orderId'],
  },
  'casecellshop.outbox.retry.scheduled': {
    level: 'warn',
    description:
      'A tentativa volta para a fila depois do atraso; `cause` diz por quê.',
    fields: ['cause'],
  },
  'casecellshop.outbox.call.deferred': {
    level: 'info',
    description:
      'Outro worker tem a permissão da chamada ao ERP; a mensagem volta para a fila.',
    fields: [],
  },
  'casecellshop.outbox.lease.too_short': {
    level: 'warn',
    description:
      'O prazo da mensagem não cabe numa chamada ao ERP; a mensagem volta para a fila.',
    fields: [],
  },
  'casecellshop.outbox.closed': {
    level: 'info',
    description: 'A mensagem foi apagada porque o pedido já tinha desfecho.',
    fields: [],
  },
  'casecellshop.outbox.conclusion.orphaned': {
    level: 'warn',
    description: 'A conclusão não afetou linha porque o token já não valia.',
    fields: [],
  },
  'casecellshop.outbox.conclusion.failed': {
    level: 'warn',
    description: 'A conclusão do pedido falhou; a mensagem volta para a fila.',
    fields: ['err'],
  },
  'casecellshop.outbox.queue.failed': {
    level: 'warn',
    description: 'Uma operação na fila falhou depois da conclusão.',
    fields: ['err'],
  },
  'casecellshop.outbox.attempt.failed': {
    level: 'error',
    description: 'A tentativa falhou com um erro inesperado.',
    fields: ['err'],
  },
  'casecellshop.outbox.dead': {
    level: 'error',
    description:
      'A mensagem chegou à DLQ; o pedido segue pendente com a reserva, à espera do runbook.',
    fields: [],
  },
  'casecellshop.outbox.reconciliation.completed': {
    level: 'info',
    description: 'Uma rodada da reconciliação terminou.',
    fields: ['seen', 'invoiced', 'closed'],
  },
  'casecellshop.outbox.reconciliation.failed': {
    level: 'warn',
    description:
      'A reconciliação de uma mensagem, ou a rodada inteira, falhou.',
    fields: ['err'],
  },
  'casecellshop.order.invoiced': {
    level: 'info',
    description: 'O ERP faturou o pedido.',
    fields: [],
  },
  'casecellshop.order.failed': {
    level: 'warn',
    description: 'O pedido terminou sem faturamento; `reason` diz por quê.',
    fields: ['reason'],
  },
  'casecellshop.erp.config.rejected': {
    level: 'warn',
    description:
      'O ERP respondeu com erro de configuração (credencial ou rota); a mensagem volta para a fila.',
    fields: ['status'],
  },
} as const satisfies Record<string, LogEventSpec>;
