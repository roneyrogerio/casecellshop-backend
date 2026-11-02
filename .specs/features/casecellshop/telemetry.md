# Catálogo de telemetria

<!-- Gerado por `npm run telemetry-doc` a partir dos `telemetry.ts` de cada pasta de `src/`. Não edite à mão. -->

As regras de nome, de unidade e de tipo estão no `OBS-07` ([`spec.md`](spec.md)) e na `AD-029` ([`STATE.md`](../../project/STATE.md)).

## Métricas

| Nome | No Prometheus | Instrumento | Unidade | Descrição |
| --- | --- | --- | --- | --- |
| `casecellshop.catalog.cache.lookups` | `casecellshop_catalog_cache_lookups_total` | contador | `{lookup}` | Leituras do cache da vitrine por resultado; o hit ratio sai daqui. |
| `casecellshop.catalog.origin.active_loads` | `casecellshop_catalog_origin_active_loads` | UpDownCounter | `{load}` | Cargas do cache em andamento; o single-flight a mantém em no máximo 1 por instância. |
| `casecellshop.catalog.origin.loads` | `casecellshop_catalog_origin_loads_total` | contador | `{load}` | Cargas do cache a partir do banco, por desfecho: o custo do cache em consultas à origem. |
| `casecellshop.catalog.served_entry.age` | `casecellshop_catalog_served_entry_age` | histograma | `s` | Idade da entrada do cache servida, desde a carga que a gerou. |
| `casecellshop.catalog.sync.age` | `casecellshop_catalog_sync_age` | gauge observável | `s` | Idade da última rodada completa da sincronização com o ERP; base do alerta de ERP fora. |
| `casecellshop.catalog.sync.corrections` | `casecellshop_catalog_sync_corrections_total` | contador | `{correction}` | Campos que a sincronização corrigiu porque o ERP divergia do valor guardado no início da rodada. |
| `casecellshop.catalog.sync.missing_skus` | `casecellshop_catalog_sync_missing_skus_total` | contador | `{sku}` | SKUs da loja ausentes do ERP numa rodada completa, zerados por ela. |
| `casecellshop.checkout.requests` | `casecellshop_checkout_requests_total` | contador | `{request}` | Checkouts por desfecho. |
| `casecellshop.erp.client.active_operations` | `casecellshop_erp_client_active_operations` | UpDownCounter | `{operation}` | Chamadas ao ERP em andamento. |
| `casecellshop.erp.client.operation.duration` | `casecellshop_erp_client_operation_duration` | histograma | `s` | Duração das chamadas ao ERP, por operação e desfecho; o `_count` conta as chamadas. |
| `casecellshop.erp.out_of_stock.rejections` | `casecellshop_erp_out_of_stock_rejections_total` | contador | `{order}` | Pedidos que o ERP recusou por falta de estoque. |
| `casecellshop.order.accept_to_invoice.duration` | `casecellshop_order_accept_to_invoice_duration` | histograma | `s` | Tempo do aceite do pedido até o faturamento no ERP. |
| `casecellshop.outbox.attempts` | `casecellshop_outbox_attempts_total` | contador | `{attempt}` | Tentativas da outbox por desfecho; o `dead` é contado pela reconciliação. |
| `casecellshop.outbox.orphan_conclusions` | `casecellshop_outbox_orphan_conclusions_total` | contador | `{conclusion}` | Conclusões que não afetaram linha porque o token já não valia. |
| `casecellshop.outbox.published.messages` | `casecellshop_outbox_published_messages_total` | contador | `{message}` | Linhas da outbox publicadas no SQS pelo relay. |
| `http.server.request.duration` | `http_server_request_duration` | histograma | `s` | Duração das requisições HTTP, base dos SLOs de latência. |

### `casecellshop.catalog.cache.lookups`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.catalog.cache.result` | obrigatório | `hit`, `miss`, `stale` | `hit` dentro do TTL, `miss` quando esperou uma carga, `stale` quando serviu a entrada expirada por erro ou pausa da origem. |

### `casecellshop.catalog.origin.active_loads`

Sem atributos.

### `casecellshop.catalog.origin.loads`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.catalog.origin.outcome` | obrigatório | `ok`, `error` | Desfecho da carga. |

### `casecellshop.catalog.served_entry.age`

Fronteiras: 1, 2.5, 4.5, 5.5, 10, 20, 30, 45, 60

Sem atributos.

### `casecellshop.catalog.sync.age`

Sem atributos.

### `casecellshop.catalog.sync.corrections`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.catalog.sync.field` | obrigatório | `price`, `on_hand`, `name` | Campo corrigido. |

### `casecellshop.catalog.sync.missing_skus`

Sem atributos.

### `casecellshop.checkout.requests`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.checkout.outcome` | obrigatório | `accepted`, `replay`, `out_of_stock`, `price_changed`, `invalid`, `unavailable` | Desfecho do checkout. |

### `casecellshop.erp.client.active_operations`

Sem atributos.

### `casecellshop.erp.client.operation.duration`

Fronteiras: 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.erp.operation` | obrigatório | `create_order`, `find_order`, `list_catalog` | Operação da porta ErpClient. |
| `casecellshop.erp.outcome` | obrigatório | `ok`, `found`, `not_found`, `permanent`, `transient`, `ambiguous`, `config_error` | Desfecho da chamada, pela lista fechada da porta. |

### `casecellshop.erp.out_of_stock.rejections`

Sem atributos.

### `casecellshop.order.accept_to_invoice.duration`

Fronteiras: 1, 5, 15, 30, 60, 120, 300, 600, 1800

Sem atributos.

### `casecellshop.outbox.attempts`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.outbox.attempt.outcome` | obrigatório | `invoiced`, `failed`, `retry`, `deferred`, `closed`, `lease_short`, `dead` | Desfecho da tentativa. |

### `casecellshop.outbox.orphan_conclusions`

Sem atributos.

### `casecellshop.outbox.published.messages`

Sem atributos.

### `http.server.request.duration`

Fronteiras: 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `http.request.method` | obrigatório | `GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `CONNECT`, `OPTIONS`, `TRACE`, `PATCH`, `_OTHER` | Método HTTP; um método fora da lista vira `_OTHER`. |
| `http.route` | condicional | template da rota | Template da rota do contrato; ausente quando a requisição não casou com nenhuma rota. |
| `http.response.status_code` | condicional | código de status HTTP | Código de status da resposta. |
| `url.scheme` | obrigatório | `http`, `https` | Esquema da URL recebida. |
| `error.type` | condicional | código de status HTTP | Só nas respostas 5xx: o código de status, como texto. |

## Eventos de log

| Nome | Níveis | Campos | Descrição |
| --- | --- | --- | --- |
| `casecellshop.api.started` | `info` | `port` | A API começou a escutar. |
| `casecellshop.catalog.origin.load_failed` | `warn` | `err` | A carga do cache a partir do banco falhou; a vitrine serve a entrada antiga até o teto ou responde 503. |
| `casecellshop.catalog.sync.round.completed` | `info` | `skuCount`, `missingCount`, `duration_ms` | Fim de uma rodada completa da sincronização, com os SKUs lidos, os ausentes zerados e a duração. |
| `casecellshop.catalog.sync.round.failed` | `warn` | `cause`, `page`, `err` | Rodada incompleta: o ERP falhou numa página (`cause`) ou o banco falhou (`err`); nenhum ausente é zerado. |
| `casecellshop.catalog.sync.state.load_failed` | `warn` | `err` | A leitura da última rodada completa falhou na subida: o gauge da idade fica sem valor até a primeira rodada completa e as rodadas seguem. |
| `casecellshop.checkout.accepted` | `info` | `orderId` | Checkout aceito, com o pedido criado. |
| `casecellshop.checkout.db.unavailable` | `warn` | `err`, `step` | O banco não respondeu no checkout; a resposta é 503. |
| `casecellshop.checkout.price_changed` | `warn` | `reason`, `items` | Checkout recusado porque o preço informado mudou. |
| `casecellshop.checkout.rejected` | `warn` | `reason` | Checkout recusado; `reason` é o tipo do problem. |
| `casecellshop.db.pool.failed` | `error` | `err` | Erro numa conexão ociosa do pool. |
| `casecellshop.db.transaction.aborted` | `error` | `err` | A transação foi abortada antes do COMMIT. |
| `casecellshop.erp.config.rejected` | `warn` | `status` | O ERP respondeu com erro de configuração (credencial ou rota); a mensagem volta para a fila. |
| `casecellshop.health.db.unavailable` | `warn` | `err` | O banco não respondeu ao /health. |
| `casecellshop.http.request.completed` | `info`, `error` | `route`, `method`, `status`, `duration_ms`, `orderId` | Fim de uma requisição HTTP; sai em `error` quando a resposta é 5xx, e sem `status` quando o cliente desconecta antes da resposta. |
| `casecellshop.http.request.failed` | `error` | `err` | Erro sem tratamento numa rota; a resposta é o 500 genérico. |
| `casecellshop.migration.completed` | `info` | — | As migrações dos dois schemas terminaram. |
| `casecellshop.order.failed` | `warn` | `reason` | O pedido terminou sem faturamento; `reason` diz por quê. |
| `casecellshop.order.invoiced` | `info` | — | O ERP faturou o pedido. |
| `casecellshop.orders.db.unavailable` | `warn` | `err` | O banco não respondeu na leitura do status do pedido. |
| `casecellshop.outbox.attempt.failed` | `error` | `err` | A tentativa falhou com um erro inesperado. |
| `casecellshop.outbox.call.deferred` | `info` | — | Outro worker tem a permissão da chamada ao ERP; a mensagem volta para a fila. |
| `casecellshop.outbox.closed` | `info` | — | A mensagem foi apagada porque o pedido já tinha desfecho. |
| `casecellshop.outbox.conclusion.failed` | `warn` | `err` | A conclusão do pedido falhou; a mensagem volta para a fila. |
| `casecellshop.outbox.conclusion.orphaned` | `warn` | — | A conclusão não afetou linha porque o token já não valia. |
| `casecellshop.outbox.dead` | `error` | — | A mensagem chegou à DLQ; o pedido segue pendente com a reserva, à espera do runbook. |
| `casecellshop.outbox.lease.too_short` | `warn` | — | O prazo da mensagem não cabe numa chamada ao ERP; a mensagem volta para a fila. |
| `casecellshop.outbox.message.rejected` | `error` | `attempt`, `orderId` | Uma mensagem da fila não segue o schema e vai para a DLQ sem chamar o ERP. |
| `casecellshop.outbox.queue.failed` | `warn` | `err` | Uma operação na fila falhou depois da conclusão. |
| `casecellshop.outbox.reconciliation.completed` | `info` | `seen`, `invoiced`, `closed` | Uma rodada da reconciliação terminou. |
| `casecellshop.outbox.reconciliation.failed` | `warn` | `err` | A reconciliação de uma mensagem, ou a rodada inteira, falhou. |
| `casecellshop.outbox.relay.failed` | `error` | `err` | Uma rodada do relay falhou; a próxima tenta de novo. |
| `casecellshop.outbox.relay.started` | `info` | — | O relay começou a publicar a outbox. |
| `casecellshop.outbox.relay.stopped` | `info` | — | O relay parou. |
| `casecellshop.outbox.retry.scheduled` | `warn` | `cause` | A tentativa volta para a fila depois do atraso; `cause` diz por quê. |
| `casecellshop.outbox.row.rejected` | `error` | `orderId` | Uma linha da outbox não forma uma mensagem válida e não é publicada. |
| `casecellshop.process.shutdown.completed` | `info` | — | O processo encerrou no prazo. |
| `casecellshop.process.shutdown.failed` | `error` | `err` | O encerramento falhou. |
| `casecellshop.process.shutdown.started` | `info` | `signal` | O processo recebeu o sinal e começou a encerrar. |
| `casecellshop.process.shutdown.timed_out` | `error` | — | O encerramento passou do prazo e o processo saiu com código 1. |
| `casecellshop.worker.metrics_server.started` | `info` | `port` | O servidor do /metrics do worker começou a escutar. |
| `casecellshop.worker.poll.failed` | `error` | `err` | O recebimento da fila falhou; o worker tenta de novo. |
| `casecellshop.worker.started` | `info` | — | O worker começou a receber da fila. |
| `casecellshop.worker.stopped` | `info` | — | O worker parou de receber da fila. |
