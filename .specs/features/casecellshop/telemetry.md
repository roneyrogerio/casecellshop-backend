# Catálogo de telemetria

<!-- Gerado por `npm run telemetry-doc` a partir dos `telemetry.ts` de cada pasta de `src/`. Não edite à mão. -->

As regras de nome, de unidade e de tipo estão no `OBS-07` ([`spec.md`](spec.md)) e na `AD-029` ([`STATE.md`](../../project/STATE.md)).

## Métricas

| Nome | No Prometheus | Instrumento | Unidade | Descrição |
| --- | --- | --- | --- | --- |
| `casecellshop.billing.gauge.read_failures` | `casecellshop_billing_gauge_read_failures_total` | contador | `{read}` | Leituras de gauge do faturamento que falharam no scrape; o gauge segue com o último valor lido. |
| `casecellshop.catalog.cache.lookups` | `casecellshop_catalog_cache_lookups_total` | contador | `{lookup}` | Leituras do cache da vitrine por resultado; o hit ratio sai daqui. |
| `casecellshop.catalog.gauge.read_failures` | `casecellshop_catalog_gauge_read_failures_total` | contador | `{read}` | Leituras do gauge da idade da sincronização que falharam no /metrics da API; nesse caso o gauge mantém o último valor. |
| `casecellshop.catalog.origin.active_loads` | `casecellshop_catalog_origin_active_loads` | UpDownCounter | `{load}` | Cargas do cache em andamento; o single-flight a mantém em no máximo 1 por instância. |
| `casecellshop.catalog.origin.loads` | `casecellshop_catalog_origin_loads_total` | contador | `{load}` | Cargas do cache a partir do banco, por desfecho: o custo do cache em consultas à origem. |
| `casecellshop.catalog.served_entry.age` | `casecellshop_catalog_served_entry_age` | histograma | `s` | Idade da entrada do cache servida, desde a carga que a gerou. |
| `casecellshop.catalog.sync.age` | `casecellshop_catalog_sync_age` | gauge | `s` | Idade da última rodada completa da sincronização com o ERP; base do alerta de sincronização parada. |
| `casecellshop.catalog.sync.corrections` | `casecellshop_catalog_sync_corrections_total` | contador | `{correction}` | Campos que a sincronização corrigiu porque o ERP divergia do valor guardado no início da rodada. |
| `casecellshop.catalog.sync.missing_skus` | `casecellshop_catalog_sync_missing_skus_total` | contador | `{sku}` | SKUs da loja ausentes do ERP numa rodada completa, zerados por ela. |
| `casecellshop.checkout.gauge.read_failures` | `casecellshop_checkout_gauge_read_failures_total` | contador | `{read}` | Leituras dos gauges do estoque que falharam no scrape; os gauges seguem com o último valor lido. |
| `casecellshop.checkout.requests` | `casecellshop_checkout_requests_total` | contador | `{request}` | Checkouts por desfecho. |
| `casecellshop.erp.client.active_operations` | `casecellshop_erp_client_active_operations` | UpDownCounter | `{operation}` | Chamadas ao ERP em andamento. |
| `casecellshop.erp.client.operation.duration` | `casecellshop_erp_client_operation_duration` | histograma | `s` | Duração das chamadas ao ERP, por operação e desfecho; o `_count` conta as chamadas. |
| `casecellshop.erp.out_of_stock.rejections` | `casecellshop_erp_out_of_stock_rejections_total` | contador | `{order}` | Pedidos que o ERP recusou por falta de estoque. |
| `casecellshop.inventory.oversold_skus` | `casecellshop_inventory_oversold_skus` | gauge | `{sku}` | SKUs com `reserved > on_hand`: reservas que o estoque já não cobre (furo de estoque). |
| `casecellshop.inventory.reserved` | `casecellshop_inventory_reserved` | gauge | `{unit}` | Unidades reservadas por pedidos pendentes, somadas em todos os SKUs. |
| `casecellshop.order.accept_to_invoice.duration` | `casecellshop_order_accept_to_invoice_duration` | histograma | `s` | Tempo do aceite do pedido até o faturamento no ERP. |
| `casecellshop.order.late_invoices` | `casecellshop_order_late_invoices_total` | contador | `{order}` | Achados da verificação tardia (AD-031): fatura de pedido falho ou fatura duplicada no ERP, um por pedido. |
| `casecellshop.order.stuck` | `casecellshop_order_stuck_total` | contador | `{order}` | Pedidos sem desfecho em 60 s do aceite, contados uma vez pela marca no banco, mesmo com várias réplicas da API. |
| `casecellshop.outbox.attempts` | `casecellshop_outbox_attempts_total` | contador | `{attempt}` | Tentativas da outbox por desfecho; o `dead` é contado pela reconciliação. |
| `casecellshop.outbox.oldest_pending.age` | `casecellshop_outbox_oldest_pending_age` | gauge | `s` | Idade da linha mais antiga da outbox com o pedido pendente e fora da DLQ; 0 sem nenhuma. |
| `casecellshop.outbox.orphan_conclusions` | `casecellshop_outbox_orphan_conclusions_total` | contador | `{conclusion}` | Conclusões que não afetaram linha porque o token já não valia. |
| `casecellshop.outbox.published.messages` | `casecellshop_outbox_published_messages_total` | contador | `{message}` | Linhas da outbox publicadas no SQS pelo relay. |
| `casecellshop.queue.messages` | `casecellshop_queue_messages` | gauge | `{message}` | Mensagens visíveis na fila, pelo `ApproximateNumberOfMessages` do SQS. |
| `http.server.request.duration` | `http_server_request_duration` | histograma | `s` | Duração das requisições HTTP, base dos SLOs de latência. |

### `casecellshop.billing.gauge.read_failures`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.gauge.name` | obrigatório | `queue_messages`, `outbox_oldest_pending_age` | Gauge cuja leitura falhou. |

### `casecellshop.catalog.cache.lookups`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.catalog.cache.result` | obrigatório | `hit`, `miss`, `stale` | `hit` dentro do TTL, `miss` quando esperou uma carga, `stale` quando serviu a entrada expirada por erro ou pausa da origem. |

### `casecellshop.catalog.gauge.read_failures`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.gauge.name` | obrigatório | `catalog_sync_age` | Gauge cuja leitura falhou. |

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

### `casecellshop.checkout.gauge.read_failures`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.gauge.name` | obrigatório | `inventory` | Leitura que falhou. |

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
| `casecellshop.erp.operation` | obrigatório | `create_order`, `find_order`, `list_catalog`, `count_invoices` | Operação da porta ErpClient. |
| `casecellshop.erp.outcome` | obrigatório | `ok`, `found`, `not_found`, `permanent`, `transient`, `ambiguous`, `config_error` | Desfecho da chamada, pela lista fechada da porta. |

### `casecellshop.erp.out_of_stock.rejections`

Sem atributos.

### `casecellshop.inventory.oversold_skus`

Sem atributos.

### `casecellshop.inventory.reserved`

Sem atributos.

### `casecellshop.order.accept_to_invoice.duration`

Fronteiras: 1, 5, 15, 30, 60, 120, 300, 600, 1800

Sem atributos.

### `casecellshop.order.late_invoices`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.order.late_invoice.cause` | obrigatório | `failed_order`, `duplicate` | O que a verificação tardia achou no ERP. |

### `casecellshop.order.stuck`

Sem atributos.

### `casecellshop.outbox.attempts`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.outbox.attempt.outcome` | obrigatório | `invoiced`, `failed`, `retry`, `deferred`, `closed`, `lease_short`, `dead` | Desfecho da tentativa. |

### `casecellshop.outbox.oldest_pending.age`

Sem atributos.

### `casecellshop.outbox.orphan_conclusions`

Sem atributos.

### `casecellshop.outbox.published.messages`

Sem atributos.

### `casecellshop.queue.messages`

| Atributo | Exigência | Valores | Descrição |
| --- | --- | --- | --- |
| `casecellshop.queue.name` | obrigatório | `billing`, `dlq` | Fila do faturamento ou a DLQ dela. |

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
| `casecellshop.billing.gauge.read_failed` | `error` | `gauge`, `err` | A leitura de um gauge do faturamento falhou no scrape; o gauge segue com o último valor lido. |
| `casecellshop.catalog.gauge.read_failed` | `error` | `gauge`, `err` | A leitura de um gauge da sincronização falhou no scrape; o gauge segue com o último valor lido. |
| `casecellshop.catalog.origin.load_failed` | `warn` | `err` | A carga do cache a partir do banco falhou; a vitrine serve a entrada antiga até o teto ou responde 503. |
| `casecellshop.catalog.sync.round.completed` | `info` | `skuCount`, `missingCount`, `duration_ms` | Fim de uma rodada completa da sincronização, com os SKUs lidos, os ausentes zerados e a duração. |
| `casecellshop.catalog.sync.round.failed` | `warn` | `cause`, `page`, `err` | Rodada incompleta: o ERP falhou numa página (`cause`) ou o banco falhou (`err`); nenhum ausente é zerado. |
| `casecellshop.catalog.sync.sku.corrected` | `info` | `sku`, `fields` | A sincronização corrigiu um SKU que divergia do ERP; `fields` lista os campos corrigidos (`price`, `name`, `on_hand`). |
| `casecellshop.catalog.sync.sku.zeroed` | `warn` | `sku` | Um SKU com estoque ficou fora do ERP numa rodada completa e foi zerado. |
| `casecellshop.checkout.accepted` | `info` | `orderId` | Checkout aceito, com o pedido criado. |
| `casecellshop.checkout.db.unavailable` | `warn` | `err`, `step` | O banco não respondeu no checkout; a resposta é 503. |
| `casecellshop.checkout.gauge.read_failed` | `error` | `gauge`, `err` | A leitura dos gauges do estoque falhou no scrape; os gauges seguem com o último valor lido. |
| `casecellshop.checkout.price_changed` | `warn` | `reason`, `items`, `skus` | Checkout recusado porque o preço informado mudou; `skus` lista os SKUs cujo preço mudou. |
| `casecellshop.checkout.rejected` | `warn` | `reason`, `sku` | Checkout recusado; `reason` é o tipo do problem. Na falta de estoque, `sku` é o SKU em que a reserva parou. |
| `casecellshop.db.pool.failed` | `error` | `err` | Erro numa conexão ociosa do pool. |
| `casecellshop.db.transaction.aborted` | `error` | `err` | A transação foi abortada antes do COMMIT. |
| `casecellshop.erp.config.rejected` | `warn` | `status` | O ERP respondeu com erro de configuração (credencial ou rota); a mensagem volta para a fila. |
| `casecellshop.health.db.unavailable` | `warn` | `err` | O banco não respondeu ao /health. |
| `casecellshop.http.request.completed` | `info`, `error` | `route`, `method`, `status`, `duration_ms`, `orderId`, `cache` | Fim de uma requisição HTTP; sai em `error` quando a resposta é 5xx, e sem `status` quando o cliente desconecta antes da resposta. O `cache` (`hit`, `miss` ou `stale`) vem só no 200 do GET /products. |
| `casecellshop.http.request.failed` | `error` | `err` | Erro sem tratamento numa rota; a resposta é o 500 genérico. |
| `casecellshop.migration.completed` | `info` | — | As migrações dos dois schemas terminaram. |
| `casecellshop.order.failed` | `warn` | `reason`, `skus`, `sku` | O pedido terminou sem faturamento; `reason` diz por quê. Na recusa do ERP, `skus` lista os SKUs do pedido e `sku` é o que o ERP apontou, quando é um deles. |
| `casecellshop.order.invoiced` | `info` | — | O ERP faturou o pedido. |
| `casecellshop.order.late_check.completed` | `info` | `checked`, `found` | Uma rodada da verificação tardia terminou. |
| `casecellshop.order.late_check.failed` | `warn` | `err` | A verificação tardia de um pedido, ou a rodada inteira, falhou; o pedido volta na rodada seguinte. |
| `casecellshop.order.late_invoice.detected` | `error` | `cause` | A verificação tardia achou no ERP uma fatura de pedido falho ou uma fatura duplicada; `cause` diz qual. |
| `casecellshop.order.stuck_check.failed` | `error` | `err` | A verificação dos pedidos sem desfecho em 60 s falhou; a próxima tenta de novo. |
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
