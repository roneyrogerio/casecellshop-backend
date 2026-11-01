// OBS-07 (AD-029): o catálogo dos eventos de log, fonte única dos nomes, dos níveis e dos campos. O nome segue
// `casecellshop.<domínio>.<evento>`, em snake_case e sem valor variável; uma falha termina em `failed`.
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEventSpec {
  readonly level: LogLevel;
  readonly description: string;
  // Os campos próprios do evento, além dos que todo log leva (service, env, version, correlationId,
  // trace_id, span_id, trace_flags). `err` é o erro serializado pelo pino.
  readonly fields: readonly string[];
}

export const LOG_EVENTS = {
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
  'casecellshop.checkout.accepted': {
    level: 'info',
    description: 'Checkout aceito, com o pedido criado.',
    fields: ['orderId'],
  },
  'casecellshop.checkout.rejected': {
    level: 'warn',
    description: 'Checkout recusado; `reason` é o tipo do problem.',
    fields: ['reason'],
  },
  'casecellshop.checkout.price_changed': {
    level: 'warn',
    description: 'Checkout recusado porque o preço informado mudou.',
    fields: ['reason', 'items'],
  },
  'casecellshop.checkout.db.unavailable': {
    level: 'warn',
    description: 'O banco não respondeu no checkout; a resposta é 503.',
    fields: ['err', 'step'],
  },
  'casecellshop.orders.db.unavailable': {
    level: 'warn',
    description: 'O banco não respondeu na leitura do status do pedido.',
    fields: ['err'],
  },
  'casecellshop.health.db.unavailable': {
    level: 'warn',
    description: 'O banco não respondeu ao /health.',
    fields: ['err'],
  },
  'casecellshop.db.transaction.aborted': {
    level: 'error',
    description: 'A transação foi abortada antes do COMMIT.',
    fields: ['err'],
  },
  'casecellshop.db.pool.failed': {
    level: 'error',
    description: 'Erro numa conexão ociosa do pool.',
    fields: ['err'],
  },
  'casecellshop.process.shutdown.started': {
    level: 'info',
    description: 'O processo recebeu o sinal e começou a encerrar.',
    fields: ['signal'],
  },
  'casecellshop.process.shutdown.completed': {
    level: 'info',
    description: 'O processo encerrou no prazo.',
    fields: [],
  },
  'casecellshop.process.shutdown.timed_out': {
    level: 'error',
    description:
      'O encerramento passou do prazo e o processo saiu com código 1.',
    fields: [],
  },
  'casecellshop.process.shutdown.failed': {
    level: 'error',
    description: 'O encerramento falhou.',
    fields: ['err'],
  },
  'casecellshop.api.started': {
    level: 'info',
    description: 'A API começou a escutar.',
    fields: ['port'],
  },
  'casecellshop.migration.completed': {
    level: 'info',
    description: 'As migrações dos dois schemas terminaram.',
    fields: [],
  },
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
  'casecellshop.worker.metrics_server.started': {
    level: 'info',
    description: 'O servidor do /metrics do worker começou a escutar.',
    fields: ['port'],
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
  'casecellshop.outbox.dead_lettered': {
    level: 'error',
    description: 'A mensagem chegou à DLQ e o pedido foi encerrado como falha.',
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

export type LogEventName = keyof typeof LOG_EVENTS;
