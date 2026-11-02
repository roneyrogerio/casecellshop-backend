# CaseCellShop backend

[![CI](https://github.com/roneyrogerio/casecellshop-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/roneyrogerio/casecellshop-backend/actions/workflows/ci.yml)

Serviço entre a loja virtual da CaseCellShop e um ERP legado que não pode ser alterado: serve o catálogo do banco da loja, reserva o estoque de forma atômica no checkout e envia os pedidos ao ERP de forma assíncrona, por uma outbox e uma fila SQS. Node.js 26, TypeScript, PostgreSQL e OpenTelemetry. O ERP é simulado no processo do worker, atrás da porta `ErpClient`.

## Em resumo

| Problema do desafio | Causa raiz | Solução | Prova |
| --- | --- | --- | --- |
| Vitrine lenta | o ERP está no caminho de cada leitura | banco próprio da loja, sincronizado com o ERP, e cache em processo com TTL, *single-flight* e *stale-if-error* | `CAT-01` a `CAT-15` |
| Venda além do estoque | o estoque é conferido num momento e baixado em outro | reserva atômica com `UPDATE` condicional e idempotência pela `Idempotency-Key` | `CHK-01` a `CHK-05` |
| Checkout que depende do ERP | o faturamento é síncrono | `202` na hora; outbox, fila SQS e worker com retry, DLQ e reconciliação | `ORD-01` a `ORD-22` |

- **Rodar:** `docker compose up --build`, e o [exemplo de ponta a ponta](#rodar).
- **Respostas às cinco perguntas:** [`RESPOSTAS.md`](RESPOSTAS.md); os detalhes de cada uma estão no [`ARCHITECTURE.md`](ARCHITECTURE.md).
- **Operação:** SLOs, dashboard, alertas e runbooks na seção [Operação](#operação).
- **Uso de IA:** [Como a IA foi usada](#como-a-ia-foi-usada) e [`PROMPTS.md`](PROMPTS.md).

## Índice

- [Em resumo](#em-resumo)
- [Pré-requisitos](#pré-requisitos)
- [Rodar](#rodar)
- [Testar](#testar)
- [Conferir](#conferir)
- [O que o desafio pede e onde está](#o-que-o-desafio-pede-e-onde-está)
- [As cinco perguntas](#as-cinco-perguntas)
- [Decisões e trade-offs](#decisões-e-trade-offs)
- [Garantias e modos de falha](#garantias-e-modos-de-falha)
- [Operação](#operação)
- [Riscos residuais](#riscos-residuais)
- [Hipóteses, premissas e limitações](#hipóteses-premissas-e-limitações)
- [Como a IA foi usada](#como-a-ia-foi-usada)
- [Documentação](#documentação)
- [Contribuir](#contribuir)
- [Licença](#licença)

## Pré-requisitos

| Para | Precisa de |
| --- | --- |
| Rodar o sistema | Docker com o Compose v2.20.2 ou mais novo; o `docker compose up` não depende do Node da máquina |
| Testar e conferir | Node.js a partir da 24.12 (a versão de referência está no [`.nvmrc`](.nvmrc)) e Docker, que os testes de integração usam |

Nenhum passo pede conta paga, credencial ou a configuração dos agentes de IA.

## Rodar

```sh
docker compose up --build
```

Sobem o PostgreSQL, as migrações (que terminam antes da API e do worker), o ElasticMQ (o SQS local, com a fila e a DLQ), a API, o worker e o Jaeger.

| Serviço | Endereço |
| --- | --- |
| API | `http://localhost:3000` (`GET /health`) |
| Métricas da API | `http://localhost:3000/metrics` |
| Traces (Jaeger) | `http://localhost:16686` |

As portas mudam com `API_PORT` e `JAEGER_UI_PORT`.

O worker sincroniza o catálogo do ERP simulado na subida e a cada minuto; antes da primeira rodada completa, `GET /products` responde `503` (`CAT-05`).

Um pedido de ponta a ponta:

```sh
curl http://localhost:3000/products
# {"items":[{"sku":"CABO-USBC-1M",…},…],"hasNext":false}: os 10 SKUs do ERP simulado, em ordem de SKU

curl -i -X POST http://localhost:3000/checkout \
  -H 'content-type: application/json' -H 'idempotency-key: pedido-1' \
  -d '{"items":[{"sku":"CAPA-MOTO-G84","quantity":1,"expectedUnitPrice":4990}]}'
# 202 Accepted, com Location: /orders/<orderId>/status

curl http://localhost:3000/orders/<orderId>/status
# {"orderId":"…","status":"invoiced"} depois de o worker faturar
```

O contrato completo está no [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), e o [`requests.http`](requests.http) tem as requisições do `/health` e do `/metrics`; as da vitrine, do checkout e do status do pedido estão no exemplo acima. O contrato declara o servidor `http://localhost:3000`, então o `openapi.yaml` importado no Insomnia ou no Postman já aponta para a API do compose.

## Testar

```sh
npm ci
npm test            # tudo: unitários e integração com PostgreSQL, SQS e compose reais
npm run test:unit   # só os unitários, sem Docker
```

Os testes de integração rodam contra PostgreSQL e ElasticMQ reais, pelo Testcontainers, porque as garantias dependem do comportamento do banco e da fila (lock, transação, índice único, visibilidade de mensagem), que um mock não reproduz. Cada teste começa pelo ID do critério que prova (`CHK-01 …`), e o CI publica a tabela critério × teste a cada execução.

## Conferir

As checagens que o CI roda:

```sh
npm run verify       # lint, formato, tipos, testes unitários, openapi.yaml gerado e o lint dele, instruções, migrações, scripts do package.json, código sem uso e repetido
npm run verify:full  # o mesmo, com a suíte inteira no Docker e os tipos do banco
```

O `openapi.yaml` sai do contrato em zod e o [catálogo de telemetria](.specs/features/casecellshop/telemetry.md) sai das declarações de cada pasta; os dois são conferidos contra o gerado: o `openapi.yaml` pelo `npm run openapi -- --check`, e o catálogo pelo teste `OBS-07`, que o `npm run telemetry-doc -- --check` também roda à mão. O que cada job do CI confere está no [`CONTRIBUTING.md`](CONTRIBUTING.md).

## O que o desafio pede e onde está

| O desafio pede | Onde | Teste | Estado |
| --- | --- | --- | --- |
| `GET /products` com cache e TTL | [`src/catalog/`](src/catalog/), cache em memória (AD-005) | `CAT-01` a `CAT-15` | pronto |
| `POST /checkout` responde `202` com `orderId` e status | [`src/checkout/`](src/checkout/) | `CHK-09` | pronto |
| `GET /orders/{orderId}/status` | [`src/orders/`](src/orders/) | `CHK-11`, `ORD-19` | pronto |
| Contrato com schemas de sucesso e erro | [`openapi.yaml`](openapi.yaml), gerado de [`src/contract/`](src/contract/); erros em `application/problem+json` (RFC 9457) | `FND-03`, `FND-07` | pronto |
| Logs estruturados com `correlationId` (o `X-Request-Id`) e `orderId` | [`src/shared/logging.ts`](src/shared/logging.ts), eventos no [catálogo de telemetria](.specs/features/casecellshop/telemetry.md) | `OBS-01`, `OBS-07` | pronto |
| Métricas de cache, checkout e fila | `/metrics` da API e do worker, nomes no catálogo de telemetria | `OBS-02`, `OBS-04`, `OBS-06`, `OBS-07` | pronto |
| Trace ligando requisição, cache, repositório e worker | [`src/shared/telemetry.ts`](src/shared/telemetry.ts), Jaeger | `FND-05`, `CHK-12`, `ORD-18`, `CAT-12`, `OBS-05` | pronto |
| Exemplo de dashboard, alerta ou runbook | [Operação](#operação): SLOs, dashboard, alertas em regras do Prometheus e um runbook por alerta | `OBS-03`; runbook da DLQ: `ORD-15` | pronto |
| Checkout sem venda além do estoque | reserva atômica no PostgreSQL (AD-002) | `CHK-01`, `CHK-02` (controle negativo) | pronto |
| Idempotência para retry e duplo clique | `Idempotency-Key` gravada na transação do pedido (AD-006) | `CHK-03` a `CHK-05` | pronto |
| Worker simulando o envio ao ERP | [`src/billing/`](src/billing/), ERP simulado em [`src/erp/sim/`](src/erp/sim/) | `ORD-01` a `ORD-22` | pronto |
| Testes de regra de negócio, cache e concorrência | [`test/`](test/) e unitários ao lado do código; a tabela critério × teste sai em cada execução do CI | regra de negócio: `CHK-03` a `CHK-12`, `ORD-01` a `ORD-22`; cache: `CAT-01` a `CAT-05`; concorrência: `CHK-01`, `CHK-02`, `CHK-07` | pronto |
| Decisões, trade-offs, limitações, instruções para rodar e prompts de IA | este README, [`PROMPTS.md`](PROMPTS.md) | conferidos na revisão (`DOC-OPS-01`, `DOC-IDX-01`) | pronto |

## As cinco perguntas

As respostas da Parte 1.A estão no [`ARCHITECTURE.md`](ARCHITECTURE.md), cada uma com os critérios `DOC-*` que a conferem; o texto entregue, na ordem do enunciado, está no [`RESPOSTAS.md`](RESPOSTAS.md) (`DOC-ENT-01`).

| Pergunta | Seção do `ARCHITECTURE.md` | Critérios |
| --- | --- | --- |
| 1. Diagnóstico, trade-offs e arquitetura alvo | [Diagnóstico e arquitetura alvo](ARCHITECTURE.md#diagnóstico-e-arquitetura-alvo) | `DOC-DIA-01` a `06` |
| 2. Cache, invalidação e vitrine | [Cache e performance da vitrine](ARCHITECTURE.md#cache-e-performance-da-vitrine) | `DOC-CAC-01` a `04` |
| 3. Observabilidade | [Observabilidade](ARCHITECTURE.md#observabilidade); SLOs, alertas, dashboard e runbooks na [Operação](#operação) deste README | `DOC-OBS-01` a `04` |
| 4. Concorrência, estoque e idempotência | [Concorrência e idempotência](ARCHITECTURE.md#concorrência-e-idempotência) | `DOC-CON-01` a `04` |
| 5. Mensageria, resiliência, contrato e IA | [Mensageria e resiliência](ARCHITECTURE.md#mensageria-e-resiliência) | `DOC-MSG-01` a `04` |

## Decisões e trade-offs

Uma linha por decisão; o contexto, as alternativas e as consequências estão na AD, no [`STATE.md`](.specs/project/STATE.md).

| Decisão | O que se ganha | O que se aceita | AD |
| --- | --- | --- | --- |
| Banco próprio da loja em PostgreSQL | a vitrine e o checkout não dependem do ERP a cada acesso | sincronizar preço e estoque com o ERP | [AD-001](.specs/project/STATE.md) |
| Estoque como promessa: `reserved` da loja separado de `on_hand` do ERP | nenhuma venda além do estoque, com um `UPDATE` condicional | a reserva precisa ser liberada em toda falha | [AD-002](.specs/project/STATE.md) |
| Outbox na transação do pedido e SQS como fila | nem pedido sem mensagem, nem mensagem sem pedido | entrega pelo menos uma vez, então o consumidor é idempotente | [AD-003](.specs/project/STATE.md), [AD-021](.specs/project/STATE.md) |
| ERP simulado atrás de uma camada anticorrupção | as falhas do ERP são injetadas e testadas; o real entra no lugar sem mudar a regra | o simulado segue hipóteses que o real precisa confirmar | [AD-004](.specs/project/STATE.md) |
| Cache em memória na vitrine, com TTL curto e *stale-if-error* | latência baixa sem servidor a mais | cada instância tem o seu cache, e a vitrine pode ficar alguns segundos atrás do banco | [AD-005](.specs/project/STATE.md) |
| Idempotência pela `Idempotency-Key`, na mesma transação do pedido | retry e duplo clique devolvem o mesmo pedido | guardar as chaves e o hash do corpo | [AD-006](.specs/project/STATE.md), [AD-020](.specs/project/STATE.md) |
| OpenTelemetry com spans manuais e pino | um `orderId` leva do log ao trace da requisição ao ERP | um caminho sem span manual não aparece no trace | [AD-008](.specs/project/STATE.md) |
| Sincronização periódica de preço e estoque, sem devolver unidade vendida | o ERP recebe uma leitura do catálogo por minuto, e a loja segue com o ERP fora | defasagem de até 65,5 s mais uma rodada com o ERP respondendo, sem limite com ele fora; cada rodada lê o catálogo inteiro | [AD-009](.specs/project/STATE.md) |
| Contrato em zod, com o OpenAPI gerado | código, validação e documentação da API nunca divergem | o OpenAPI não se edita à mão | [AD-010](.specs/project/STATE.md) |
| Consultas e migrações pelo Kysely, com os tipos gerados do banco | o compilador recusa coluna errada, e nenhum valor entra no SQL | o Kysely é 0.x, fixado e atualizado de propósito; os tipos pedem um banco migrado no CI | [AD-017](.specs/project/STATE.md) |
| O preço que o cliente viu é obrigatório no checkout | o cliente nunca paga um preço que não viu | um checkout com o preço mudado recebe `409` e precisa confirmar | [AD-018](.specs/project/STATE.md) |
| Uma chamada ao ERP por pedido a cada atraso mínimo | sem fatura duplicada nas hipóteses do ERP | um pedido não chama o ERP mais de uma vez a cada 45 s | [AD-024](.specs/project/STATE.md) |
| Métricas e eventos de log num catálogo tipado, com os nomes do OpenTelemetry | o `tsc` recusa nome, atributo ou valor fora do catálogo, e o `telemetry.md` sai dele | declarar cada métrica e cada evento antes de usar | [AD-029](.specs/project/STATE.md) |
| Fluxo de IA com papéis separados e o oráculo fora do alcance de quem implementa | o código é conferido por testes escritos antes e por uma revisão independente | a revisão por fatia pode somar mais rodadas que uma revisão por marco | [AD-012](.specs/project/STATE.md) |

## Garantias e modos de falha

As garantias dependem de hipóteses sobre o ERP, que é legado e não pode mudar:

- **H1a:** a API aceita o `orderId` da loja como referência e permite consultar um pedido por ela.
- **H1b:** o ERP recusa uma segunda criação com a mesma referência.
- **H2:** o ERP recusa faturar sem estoque e diz o motivo.
- **H3:** o ERP fatura pelo preço enviado.
- **H4:** o ERP conclui ou abandona uma criação em até 40 s.

| Garantia | Depende de | Teste |
| --- | --- | --- |
| Nenhuma venda além do estoque, com 50 checkouts simultâneos | o banco da loja | `CHK-01`, `CHK-02` (controle negativo) |
| Um pedido por chave, mesmo com envios em paralelo ou depois de o estoque acabar | o banco da loja | `CHK-03`, `CHK-04`, `CHK-05` |
| Sem deadlock entre pedidos com os mesmos SKUs em outra ordem | o banco da loja | `CHK-07` |
| O preço cobrado é o que o cliente viu | H3 | `CHK-06` |
| Todo pedido aceito tem a mensagem do faturamento, e nenhuma mensagem existe sem pedido | o banco da loja (outbox na transação) | `CHK-12`, `ORD-22` |
| Uma fatura por pedido com mensagem duplicada, worker morto no meio, ERP lento ou que fatura sem responder | H1a e H4; a H1b é uma segunda proteção | `ORD-01` a `ORD-05`, `ORD-07` |
| No máximo uma chamada ao ERP por pedido a cada atraso mínimo | o banco da loja (permissão de chamada) | `ORD-02`, `ORD-11` |
| Estoque baixado uma vez só, mesmo com conclusões simultâneas | o banco da loja | `ORD-17` |
| Reserva liberada quando o ERP recusa o pedido | H2 | `ORD-08` |
| Todo pedido aceito termina faturado, falho ou na DLQ, de onde sai pela reconciliação ou pelo runbook | H1a | `ORD-13`, `ORD-14`, `ORD-15` |
| Vitrine sem preço ou disponibilidade defasados além do limite da meta 2 | a sincronização com o ERP | `CAT-06`, `CAT-07` |
| Um pedido sem desfecho em 60 s é contado uma vez, com várias réplicas da API | o banco da loja | `OBS-04` |

| Falha | Detecção | Mitigação | Teste |
| --- | --- | --- | --- |
| ERP lento | timeout de 10 s na camada anticorrupção; alerta [ERP falhando](#erp-falhando-ou-com-erro-de-configuração) | a mensagem volta à fila; nova tentativa depois do atraso mínimo, consultando antes de criar | `ORD-21`, `ORD-04` |
| ERP fora | desfecho `transient` no histograma do ERP; alertas [ERP falhando](#erp-falhando-ou-com-erro-de-configuração) e [Pendência antiga](#pendência-antiga-e-burn-rate-do-faturamento) | retry com espera crescente; o checkout continua e os pedidos esperam com a reserva | `ORD-13`, `ORD-21` |
| ERP fora além da janela de retry | alerta [DLQ](#dlq) | a mensagem vai para a DLQ com a reserva; a reconciliação fatura os pedidos que o ERP já tem, e o runbook trata o resto | `ORD-13`, `ORD-14`, `ORD-07` |
| ERP com credencial ou rota errada | desfecho `config_error`; alerta [ERP com erro de configuração](#erp-falhando-ou-com-erro-de-configuração) | o pedido não falha: a mensagem volta à fila e, depois de 12 recebimentos (cerca de 23 min), vai para a DLQ com a reserva; corrigida a configuração, o `redrive` a reprocessa | `ORD-09`, `ORD-10` |
| ERP que fatura e não responde | timeout ou `502` na chamada | a próxima tentativa consulta pela referência antes de criar | `ORD-03`, `ORD-05` |
| ERP que fatura depois do timeout | timeout na chamada | a próxima tentativa só sai depois do atraso mínimo (H4) e consulta antes de criar | `ORD-04` |
| ERP acima do limite da H4 e sem a H1b | não detectável pela loja | duas faturas, ou o pedido falho com uma fatura que aparece depois; demonstrado no teste e declarado como risco (R6) | `ORD-06` |
| Worker morre no meio da chamada | a mensagem volta a ficar visível no SQS | nova tentativa só depois do atraso mínimo, contado do início da chamada abandonada | `ORD-02` |
| Mensagem que derruba o processo ou fora do schema | contagem de recebimentos do SQS; log `casecellshop.outbox.message.rejected` | vai sozinha para a DLQ, e as outras do lote seguem | `ORD-12` |
| Banco indisponível no checkout | `lock_timeout` ou falha de conexão; burn rate do checkout | `503` com `Retry-After`, sem reserva parcial | `CHK-08` |
| Banco falha ao gravar o desfecho | erro na transação de conclusão | até 5 repetições; depois a mensagem volta à fila, sem ir para a DLQ | `ORD-16` |
| SKU disputado por muitos checkouts | `409` por falta de estoque no desfecho do checkout | `UPDATE` condicional na linha do estoque, sem venda além dele | `CHK-01`, `CHK-07` |
| Origem do cache em erro | consultas à origem com `error`; alerta [Vitrine servida velha](#vitrine-servida-velha) | serve a última entrada até o teto de 60 s, sem esperar a origem durante a pausa; sem entrada, `503` | `CAT-04` |
| Sincronização parada | idade da sincronização; alerta [Sincronização parada](#sincronização-parada) | a loja segue com o último estoque e preço conhecidos; o checkout decide pelo banco | `CAT-09`, `CAT-11`, `CAT-15` |
| Venda em outro canal | SKUs com `reserved > on_hand` e rejeições por falta de estoque; alerta [Furo de estoque](#furo-de-estoque) | a sincronização desconta as vendas da loja depois da leitura; o ERP recusa sem estoque (H2) e a reserva é liberada | `CAT-07`, `OBS-06`, `ORD-08` |
| Preço alterado entre a vitrine e o checkout | `409` com o preço atual; log `casecellshop.checkout.price_changed` | nada é reservado; o cliente confirma o preço novo | `CHK-06` |

## Operação

Tudo abaixo usa os nomes do `/metrics`, que estão na coluna "No Prometheus" do [catálogo de telemetria](.specs/features/casecellshop/telemetry.md); um teste confere cada nome, rótulo e valor das consultas desta seção contra ele (`OBS-03`).

- **Logs:** JSON em uma linha, com `correlationId`, `orderId`, `trace_id` e o nome do evento (`docker compose logs api worker`). Os eventos estão no mesmo catálogo.
- **Métricas:** no formato Prometheus, em `http://localhost:3000/metrics` para a API; as do worker ficam na porta 9464 dentro da rede do compose (`docker compose exec worker node -e "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then(console.log)"`).
- **Traces:** no Jaeger, o trace sai da requisição de checkout e continua na tentativa do worker, pelo `traceparent` da mensagem.

### SLIs e SLOs

Os objetivos são os do [`design.md`](.specs/features/casecellshop/design.md), seção "Parâmetros", em janela de 30 dias.

| SLO | Objetivo | Orçamento de erro |
| --- | --- | --- |
| Disponibilidade da vitrine (`GET /products`) | 99,9% sem `5xx` | 0,1% |
| Latência da vitrine | 99% em até 200 ms | 1% |
| Disponibilidade do checkout (`POST /checkout`) | 99,9% sem `5xx`; `4xx` não consome o orçamento | 0,1% |
| Latência do checkout | 99% em até 500 ms | 1% |
| Aceite ao faturamento | 99% dos pedidos aceitos com desfecho em até 60 s | 1% |

```promql
# SLI de disponibilidade da vitrine e do checkout: fração sem 5xx, por rota.
# Sem nenhum 5xx, o numerador não tem série; o "or ... * 0" o completa com zero, e o SLI sai 1.
1 - (
  (
    sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[30d]))
    or
    sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[30d])) * 0
  )
  /
  sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[30d]))
)

# SLI de latência da vitrine: fração em até 200 ms.
sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[30d]))
/
sum(rate(http_server_request_duration_count{http_route="/products"}[30d]))

# SLI de latência do checkout: fração em até 500 ms.
sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[30d]))
/
sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[30d]))

# SLI do aceite ao faturamento: os pedidos sem desfecho em 60 s, marcados uma vez pela API (OBS-04), sobre os aceitos.
# Sem nenhum pedido sem desfecho, o counter ainda não existe; o "or vector(0)" o completa com zero.
1 - (
  (sum(increase(casecellshop_order_stuck_total[30d])) or vector(0))
  /
  sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[30d]))
)
```

### Dashboard de exemplo

Uma linha por área; cada consulta é um painel, com o título no comentário. A janela de 5 min é a dos painéis.

```promql
# Vitrine: requisições por segundo, por código de status
sum by (http_response_status_code) (rate(http_server_request_duration_count{http_route="/products"}[5m]))

# Vitrine: latência p99 (s)
histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_bucket{http_route="/products"}[5m])))

# Vitrine: resultado do cache (hit, miss, stale) por segundo
sum by (casecellshop_catalog_cache_result) (rate(casecellshop_catalog_cache_lookups_total[5m]))

# Vitrine: taxa de acerto do cache
sum(rate(casecellshop_catalog_cache_lookups_total{casecellshop_catalog_cache_result="hit"}[5m]))
/ sum(rate(casecellshop_catalog_cache_lookups_total[5m]))

# Vitrine: cargas da origem por desfecho
sum by (casecellshop_catalog_origin_outcome) (rate(casecellshop_catalog_origin_loads_total[5m]))

# Vitrine: cargas da origem em andamento
max(casecellshop_catalog_origin_active_loads)

# Vitrine: idade p99 da entrada servida (s)
histogram_quantile(0.99, sum by (le) (rate(casecellshop_catalog_served_entry_age_bucket[5m])))
```

```promql
# Checkout: checkouts por desfecho
sum by (casecellshop_checkout_outcome) (rate(casecellshop_checkout_requests_total[5m]))

# Checkout: latência p99 do checkout e do status do pedido (s)
histogram_quantile(0.99, sum by (le, http_route) (rate(http_server_request_duration_bucket{http_route=~"/checkout|/orders/{orderId}/status"}[5m])))
```

```promql
# Fila: mensagens na fila do faturamento e na DLQ, visíveis e em voo
max by (casecellshop_queue_name) (casecellshop_queue_messages)

# Fila: idade da pendência mais antiga da outbox (s)
max(casecellshop_outbox_oldest_pending_age)

# Fila: mensagens publicadas pelo relay por segundo
sum(rate(casecellshop_outbox_published_messages_total[5m]))

# Fila: tentativas por desfecho
sum by (casecellshop_outbox_attempt_outcome) (rate(casecellshop_outbox_attempts_total[5m]))

# Fila: conclusões sem efeito (receipt handle vencido), na última hora
sum(increase(casecellshop_outbox_orphan_conclusions_total[1h]))

# Fila: aceite ao faturamento, p50 (s)
histogram_quantile(0.5, sum by (le) (rate(casecellshop_order_accept_to_invoice_duration_bucket[15m])))

# Fila: aceite ao faturamento, p99 (s)
histogram_quantile(0.99, sum by (le) (rate(casecellshop_order_accept_to_invoice_duration_bucket[15m])))

# Fila: pedidos sem desfecho em 60 s, na última hora
sum(increase(casecellshop_order_stuck_total[1h]))
```

```promql
# ERP: chamadas por operação e desfecho
sum by (casecellshop_erp_operation, casecellshop_erp_outcome) (rate(casecellshop_erp_client_operation_duration_count[5m]))

# ERP: latência p99 por operação (s)
histogram_quantile(0.99, sum by (le, casecellshop_erp_operation) (rate(casecellshop_erp_client_operation_duration_bucket[5m])))

# ERP: chamadas em andamento (limite de 30)
sum(casecellshop_erp_client_active_operations)
```

```promql
# Estoque: unidades reservadas
sum(casecellshop_inventory_reserved)

# Estoque: SKUs com reserved > on_hand
max(casecellshop_inventory_oversold_skus)

# Estoque: rejeições do ERP por falta de estoque, na última hora
sum(increase(casecellshop_erp_out_of_stock_rejections_total[1h]))
```

```promql
# Sincronização: idade da última rodada completa (s)
max(casecellshop_catalog_sync_age)

# Leituras de gauge que falharam, por pasta e gauge, na última hora
sum by (casecellshop_gauge_name) (increase(casecellshop_billing_gauge_read_failures_total[1h]))

sum by (casecellshop_gauge_name) (increase(casecellshop_checkout_gauge_read_failures_total[1h]))

sum by (casecellshop_gauge_name) (increase(casecellshop_catalog_gauge_read_failures_total[1h]))

# Sincronização: correções, na última hora
sum(increase(casecellshop_catalog_sync_corrections_total[1h]))

# Sincronização: SKUs ausentes zerados, na última hora
sum(increase(casecellshop_catalog_sync_missing_skus_total[1h]))
```

### Alertas

As regras estão no formato de arquivo de regras do Prometheus ([regras de alerta](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)) e passam no `promtool check rules`. Cada uma traz a severidade (`page` acorda alguém; `ticket` vai para a fila do time) e o link do runbook.

Os alertas de SLO seguem o burn rate em várias janelas do livro de SRE do Google ([Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/), consultado em 02/11/2026): `page` com 14,4 vezes o ritmo que gasta o orçamento de 30 dias, em 1 h e em 5 min (2% do orçamento), ou 6 vezes, em 6 h e em 30 min (5%); `ticket` com 1 vez, em 3 dias e em 6 h (10%). A janela curta faz o alerta parar logo que o problema acaba, por isso essas regras não precisam de `for`.

Um counter só aparece no `/metrics` depois do primeiro registro, já com o valor 1, e o `increase` não conta esse primeiro registro, porque não há amostra anterior. A documentação do Prometheus pede exportar `0` de antemão para toda série que se sabe que vai existir ([Avoid missing metrics](https://prometheus.io/docs/practices/instrumentation/#avoid-missing-metrics), consultado em 02/11/2026); enquanto o serviço não faz isso, os eventos registrados antes da primeira coleta de cada série depois da subida do processo (por exemplo, a primeira rejeição por falta de estoque ou os primeiros `config_error`) podem não disparar o alerta; o próximo evento depois dessa coleta, dentro da janela, dispara. Nos alertas sobre counters, a série ausente quer dizer "nada aconteceu", e o alerta não dispara; os gauges da fila e da sincronização, que precisam existir, têm um `absent` próprio. Um gauge cuja leitura falha segue exportando o último valor, e a falha conta no counter de falhas de leitura da pasta; por isso os alertas de fila, de furo de estoque e de sincronização parada também disparam por esse counter, como pede o item "Leitura que falha" do [`design.md`](.specs/features/casecellshop/design.md), seção "Observabilidade" (na sincronização, `CAT-15`).

| Alerta | Dispara quando | Severidade | Runbook |
| --- | --- | --- | --- |
| `CasecellshopErrosBurnRateRapido` e `…Lento` | a vitrine ou o checkout gastam o orçamento de `5xx` | `page` e `ticket` | [Burn rate da vitrine ou do checkout](#burn-rate-da-vitrine-ou-do-checkout) |
| `CasecellshopVitrineLentaBurnRate…` e `CasecellshopCheckoutLentoBurnRate…` | a vitrine passa de 200 ms, ou o checkout de 500 ms, acima do orçamento | `page` e `ticket` | [Burn rate da vitrine ou do checkout](#burn-rate-da-vitrine-ou-do-checkout) |
| `CasecellshopFaturamentoBurnRate…` | pedidos sem desfecho em 60 s acima do orçamento | `page` e `ticket` | [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento) |
| `CasecellshopPendenciaAntiga` | a pendência mais antiga da outbox passa de 2 min, ou a leitura dela falha, por 5 min | `ticket` | [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento) |
| `CasecellshopMetricasDaFilaAusentes` | o gauge da fila some, por 10 min | `ticket` | [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento) |
| `CasecellshopDLQ` | há mensagem na DLQ, ou a leitura da fila falha, por 10 min | `ticket` | [DLQ](#dlq) |
| `CasecellshopFuroDeEstoque` | um SKU com `reserved > on_hand`, uma rejeição do ERP por falta de estoque, ou a leitura do estoque falha | `page` | [Furo de estoque](#furo-de-estoque) |
| `CasecellshopErpErroDeConfiguracao` | uma chamada ao ERP com `config_error` | `page` | [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração) |
| `CasecellshopErpFalhando` | mais da metade das chamadas `transient` ou `ambiguous`, por 10 min | `ticket` | [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração) |
| `CasecellshopSincronizacaoParada` | a última rodada completa tem mais de 3 min, a série some, ou a leitura dela falha, por 5 min | `page` | [Sincronização parada](#sincronização-parada) |
| `CasecellshopVitrineServidaVelha` | a idade p99 da entrada servida passa de 30 s, por 5 min | `ticket` | [Vitrine servida velha](#vitrine-servida-velha) |

```yaml
groups:
  - name: casecellshop
    rules:
      - alert: CasecellshopErrosBurnRateRapido
        expr: |
          (
            (sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[1h]))
            / sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[1h]))) > 14.4 * 0.001
            and
            (sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[5m]))
            / sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[5m]))) > 14.4 * 0.001
          )
          or
          (
            (sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[6h]))
            / sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[6h]))) > 6 * 0.001
            and
            (sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[30m]))
            / sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[30m]))) > 6 * 0.001
          )
        for: 0m
        labels:
          severity: page
        annotations:
          summary: "{{ $labels.http_route }} gasta o orçamento de 5xx rápido demais"
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#burn-rate-da-vitrine-ou-do-checkout
      - alert: CasecellshopErrosBurnRateLento
        expr: |
          (sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[3d]))
            / sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[3d]))) > 0.001
          and
          (sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout", http_response_status_code=~"5.."}[6h]))
            / sum by (http_route) (rate(http_server_request_duration_count{http_route=~"/products|/checkout"}[6h]))) > 0.001
        for: 0m
        labels:
          severity: ticket
        annotations:
          summary: "{{ $labels.http_route }} gasta o orçamento de 5xx acima do ritmo de 30 dias"
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#burn-rate-da-vitrine-ou-do-checkout
      - alert: CasecellshopVitrineLentaBurnRateRapido
        expr: |
          (
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[1h]))
            / sum(rate(http_server_request_duration_count{http_route="/products"}[1h]))) > 14.4 * 0.01
            and
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[5m]))
            / sum(rate(http_server_request_duration_count{http_route="/products"}[5m]))) > 14.4 * 0.01
          )
          or
          (
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[6h]))
            / sum(rate(http_server_request_duration_count{http_route="/products"}[6h]))) > 6 * 0.01
            and
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[30m]))
            / sum(rate(http_server_request_duration_count{http_route="/products"}[30m]))) > 6 * 0.01
          )
        for: 0m
        labels:
          severity: page
        annotations:
          summary: A vitrine gasta o orçamento de latência rápido demais
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#burn-rate-da-vitrine-ou-do-checkout
      - alert: CasecellshopVitrineLentaBurnRateLento
        expr: |
          (1 - sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[3d]))
            / sum(rate(http_server_request_duration_count{http_route="/products"}[3d]))) > 0.01
          and
          (1 - sum(rate(http_server_request_duration_bucket{http_route="/products", le="0.2"}[6h]))
            / sum(rate(http_server_request_duration_count{http_route="/products"}[6h]))) > 0.01
        for: 0m
        labels:
          severity: ticket
        annotations:
          summary: A vitrine gasta o orçamento de latência acima do ritmo de 30 dias
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#burn-rate-da-vitrine-ou-do-checkout
      - alert: CasecellshopCheckoutLentoBurnRateRapido
        expr: |
          (
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[1h]))
            / sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[1h]))) > 14.4 * 0.01
            and
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[5m]))
            / sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[5m]))) > 14.4 * 0.01
          )
          or
          (
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[6h]))
            / sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[6h]))) > 6 * 0.01
            and
            (1 - sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[30m]))
            / sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[30m]))) > 6 * 0.01
          )
        for: 0m
        labels:
          severity: page
        annotations:
          summary: O checkout gasta o orçamento de latência rápido demais
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#burn-rate-da-vitrine-ou-do-checkout
      - alert: CasecellshopCheckoutLentoBurnRateLento
        expr: |
          (1 - sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[3d]))
            / sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[3d]))) > 0.01
          and
          (1 - sum(rate(http_server_request_duration_bucket{http_route="/checkout", http_request_method="POST", le="0.5"}[6h]))
            / sum(rate(http_server_request_duration_count{http_route="/checkout", http_request_method="POST"}[6h]))) > 0.01
        for: 0m
        labels:
          severity: ticket
        annotations:
          summary: O checkout gasta o orçamento de latência acima do ritmo de 30 dias
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#burn-rate-da-vitrine-ou-do-checkout
      - alert: CasecellshopFaturamentoBurnRateRapido
        expr: |
          (
            (sum(increase(casecellshop_order_stuck_total[1h]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[1h]))) > 14.4 * 0.01
            and
            (sum(increase(casecellshop_order_stuck_total[5m]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[5m]))) > 14.4 * 0.01
          )
          or
          (
            (sum(increase(casecellshop_order_stuck_total[6h]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[6h]))) > 6 * 0.01
            and
            (sum(increase(casecellshop_order_stuck_total[30m]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[30m]))) > 6 * 0.01
          )
        for: 0m
        labels:
          severity: page
        annotations:
          summary: Pedidos sem desfecho em 60 s acima do orçamento
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#pendência-antiga-e-burn-rate-do-faturamento
      - alert: CasecellshopFaturamentoBurnRateLento
        expr: |
          (sum(increase(casecellshop_order_stuck_total[3d]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[3d]))) > 0.01
          and
          (sum(increase(casecellshop_order_stuck_total[6h]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[6h]))) > 0.01
        for: 0m
        labels:
          severity: ticket
        annotations:
          summary: Pedidos sem desfecho em 60 s acima do ritmo de 30 dias
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#pendência-antiga-e-burn-rate-do-faturamento
      - alert: CasecellshopPendenciaAntiga
        expr: |
          max(casecellshop_outbox_oldest_pending_age) > 120
          or
          sum(increase(casecellshop_billing_gauge_read_failures_total{casecellshop_gauge_name="outbox_oldest_pending_age"}[5m])) > 0
        for: 5m
        labels:
          severity: ticket
        annotations:
          summary: A pendência mais antiga da outbox passa do dobro do SLO de 60 s, ou a leitura dela falhou
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#pendência-antiga-e-burn-rate-do-faturamento
      - alert: CasecellshopMetricasDaFilaAusentes
        expr: |
          absent(casecellshop_queue_messages{casecellshop_queue_name="billing"})
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: O gauge da fila sumiu do /metrics
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#pendência-antiga-e-burn-rate-do-faturamento
      - alert: CasecellshopDLQ
        expr: |
          max(casecellshop_queue_messages{casecellshop_queue_name="dlq"}) > 0
          or
          sum(increase(casecellshop_billing_gauge_read_failures_total{casecellshop_gauge_name="queue_messages"}[10m])) > 0
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: Há mensagem na DLQ, ou a leitura da fila falhou
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#dlq
      - alert: CasecellshopFuroDeEstoque
        expr: |
          max(casecellshop_inventory_oversold_skus) > 0
          or
          sum(increase(casecellshop_erp_out_of_stock_rejections_total[15m])) > 0
          or
          sum(increase(casecellshop_checkout_gauge_read_failures_total{casecellshop_gauge_name="inventory"}[15m])) > 0
        for: 0m
        labels:
          severity: page
        annotations:
          summary: SKU com reserved > on_hand, o ERP recusou um pedido por falta de estoque, ou a leitura do estoque falhou
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#furo-de-estoque
      - alert: CasecellshopErpErroDeConfiguracao
        expr: |
          sum(increase(casecellshop_erp_client_operation_duration_count{casecellshop_erp_outcome="config_error"}[5m])) > 0
        for: 0m
        labels:
          severity: page
        annotations:
          summary: O ERP recusou a credencial ou a rota
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#erp-falhando-ou-com-erro-de-configuração
      - alert: CasecellshopErpFalhando
        expr: |
          (
            sum(rate(casecellshop_erp_client_operation_duration_count{casecellshop_erp_outcome=~"transient|ambiguous"}[5m]))
            / sum(rate(casecellshop_erp_client_operation_duration_count[5m]))
          ) > 0.5
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: Mais da metade das chamadas ao ERP falha
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#erp-falhando-ou-com-erro-de-configuração
      - alert: CasecellshopSincronizacaoParada
        expr: |
          max(casecellshop_catalog_sync_age) > 180
          or
          absent(casecellshop_catalog_sync_age)
          or
          sum(increase(casecellshop_catalog_gauge_read_failures_total{casecellshop_gauge_name="catalog_sync_age"}[5m])) > 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: A última rodada completa da sincronização tem mais de 3 min, ou a leitura dela falhou
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#sincronização-parada
      - alert: CasecellshopVitrineServidaVelha
        expr: |
          histogram_quantile(0.99, sum by (le) (rate(casecellshop_catalog_served_entry_age_bucket[5m]))) > 30
        for: 5m
        labels:
          severity: ticket
        annotations:
          summary: A vitrine serve entradas com mais de 30 s no p99
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#vitrine-servida-velha
```

### Runbooks

Os comandos rodam com o compose no ar. Para ler o banco: `docker compose exec postgres psql -U casecellshop -d casecellshop`.

#### Burn rate da vitrine ou do checkout

1. No dashboard, veja qual rota e quais códigos de status sobem.
2. `503` no checkout: o banco não respondeu ou um lock passou do `lock_timeout`. Confira `curl -i http://localhost:3000/health` e os logs `casecellshop.checkout.db.unavailable` e `casecellshop.db.pool.failed`.
3. `503` na vitrine: o catálogo ainda não foi sincronizado ou a origem do cache passou do teto do *stale-if-error*. Siga [Vitrine servida velha](#vitrine-servida-velha).
4. `500`: procure `casecellshop.http.request.failed` pelo `correlationId` e abra o trace no Jaeger pelo `trace_id`.
5. Latência sem erro: compare a latência p99 com as cargas da origem em andamento e com o pool do banco; um SKU disputado aparece como `409` por falta de estoque no desfecho do checkout, e não como lentidão.

#### Pendência antiga e burn rate do faturamento

Se o alerta veio do counter de falhas de leitura, o gauge da pendência está congelado no último valor: o log `casecellshop.billing.gauge.read_failed` traz o erro, e a leitura é do banco, na API (`curl -i http://localhost:3000/health`). Corrigido o banco, siga os passos abaixo.

1. Veja no dashboard se o worker publica e tenta: `casecellshop_outbox_published_messages_total` parado com a pendência subindo é o relay; tentativas paradas é o worker. Confira `docker compose ps worker` e os logs `casecellshop.outbox.relay.failed` e `casecellshop.worker.poll.failed`.
2. Tentativas com `retry` ou `deferred` crescendo: o ERP está lento ou fora. Siga [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração).
3. Tentativas com `lease_short`: a visibilidade da mensagem não cabe numa chamada ao ERP; confira a configuração da fila.
4. Os pedidos esperam com a reserva feita e não falham por isso; quando a causa sai, a fila esvazia sozinha.

#### DLQ

Um pedido na DLQ segue `pending`, com a reserva, até alguém decidir (`ORD-13`).

O gauge da DLQ conta as mensagens visíveis e as em voo (`OBS-09`): a reconciliação recebe cada mensagem e a deixa invisível por 5 min a cada rodada, e mesmo assim ela segue contada, e o alerta continua disparando enquanto a mensagem estiver na DLQ.

Se o alerta veio do counter de falhas de leitura, o gauge da fila está congelado no último valor, e o log `casecellshop.billing.gauge.read_failed` traz o erro do `GetQueueAttributes`. Com o SQS fora do alcance do worker (`docker compose ps elasticmq`), a reconciliação também falha (`casecellshop.outbox.reconciliation.failed`), e as chegadas à DLQ só aparecem em `casecellshop.outbox.dead` na primeira rodada depois da volta. Se só o `GetQueueAttributes` falha (uma permissão faltando, por exemplo), a reconciliação segue registrando cada chegada.

1. Ache os pedidos: o log `casecellshop.outbox.dead` traz o `orderId` de cada chegada à DLQ. Uma mensagem com o corpo fora do schema não gera esse log: ela aparece em `casecellshop.outbox.message.rejected`, com o `orderId` quando o corpo o tem (`ORD-12`).
2. Espere uma rodada da reconciliação (5 min): ela fatura e tira da DLQ os pedidos que o ERP já tem (`ORD-14`). O resumo sai em `casecellshop.outbox.reconciliation.completed`.
3. Para cada pedido que sobrar, consulte o ERP pela referência, que é o `orderId` (H1a). No ERP simulado: `select reference, created_at from erp_sim.invoices where reference = '<orderId>';`.
4. Se a causa já saiu (ERP de volta, configuração corrigida), reprocesse em lote:

   ```sh
   docker compose exec worker node src/main/runbook.ts redrive
   ```

   É seguro mesmo para pedidos que o ERP já tem: cada mensagem passa pela permissão de chamada e consulta o ERP antes de criar (`ORD-07`). No compose, o ElasticMQ tira da DLQ, sem entregá-la à fila, a mensagem que a reconciliação segura na hora do `redrive` (risco R12 do [`STATE.md`](.specs/project/STATE.md)). Por isso, guarde antes do `redrive` a lista dos pedidos que chegaram à DLQ e seguem pendentes; depois, um pedido dela que não apareça nos logs do worker (`docker compose logs worker`, pelo `orderId`) ficou fora da fila: trate-o pelos passos 3 e 5.

   ```sql
   select o.id from orders o join outbox x on x.order_id = o.id where o.status = 'pending' and x.dead_at is not null;
   ```

5. Cancele só o pedido que o ERP não tem e que não deve mais ser faturado:

   ```sh
   docker compose exec worker node src/main/runbook.ts cancel <orderId>
   ```

   O pedido vira `failed` com o motivo `cancelled` e a reserva é liberada, só se ele ainda estava `pending` (`ORD-15`). O `cancel` não toca o SQS: a próxima rodada da reconciliação (até 5 min) encontra o pedido com desfecho e apaga a mensagem da DLQ sem chamar o ERP (`casecellshop.outbox.closed`); depois de um `redrive`, quem a apaga é o worker. Se o ERP tem o pedido, não cancele: use o `redrive` ou espere a reconciliação.
6. Uma mensagem com o corpo fora do schema fica na DLQ: a reconciliação a deixa para o runbook sem consultar o ERP (`ORD-14`), e um `redrive` só a devolve à DLQ, porque o worker a rejeita de novo (`ORD-12`). Se o corpo traz o `orderId`, trate o pedido pelos passos 3 e 5. O runbook ainda não tem um comando que apague uma mensagem da DLQ; até ter, silencie o alerta `CasecellshopDLQ` no Alertmanager com uma expiração curta e, antes de renovar o silêncio, confira no dashboard que `casecellshop_queue_messages{casecellshop_queue_name="dlq"}` ainda é 1, para não esconder uma mensagem que chegue depois.

#### ERP falhando ou com erro de configuração

1. No painel do ERP, veja a operação e o desfecho.
2. `config_error`: o ERP recusou a credencial ou a rota (`400`, `401`, `403`, ou um `404` sem o corpo esperado na consulta; na criação e no catálogo, todo `404`). O log `casecellshop.erp.config.rejected` traz o status. Corrija a configuração do cliente do ERP no worker e reinicie o worker (`docker compose restart worker`). Nenhum pedido falha por isso: a mensagem volta à fila (`ORD-09`, `ORD-10`). No ERP simulado, esse desfecho só sai por falha injetada.
3. `transient` ou `ambiguous`: o ERP está lento ou fora. O worker repete com espera crescente, uma chamada por pedido a cada 45 s. Fale com o time do ERP; não reinicie o worker em laço, porque isso não acelera nada.
4. Se a falha durar mais que a janela de retry (cerca de 23 min em média), os pedidos chegam à DLQ: siga [DLQ](#dlq) quando o ERP voltar.

#### Furo de estoque

O ERP tem menos unidades que a loja prometeu, quase sempre por venda em outro canal.

Se o alerta veio do counter de falhas de leitura, o gauge do estoque está congelado no último valor: o log `casecellshop.checkout.gauge.read_failed` traz o erro, e a leitura é do banco, na API (`curl -i http://localhost:3000/health`). Enquanto ela falha, a consulta do passo 1 é a fonte.

1. Ache os SKUs: `select sku, on_hand, reserved from inventory where reserved > on_hand order by sku;`.
2. Os pedidos pendentes desses SKUs que o ERP recusar por falta de estoque terminam `failed` com o motivo `erp_out_of_stock` e liberam a reserva (`ORD-08`). Avise o atendimento: o cliente recebeu `202` e o pedido não será faturado.
3. Não altere `inventory` à mão: o `on_hand` vem do ERP pela sincronização, e o `reserved` é a soma das reservas dos pedidos pendentes.
4. Confirme com o time do ERP a venda no outro canal ou o ajuste de estoque; se a origem for recorrente, reduza o intervalo da sincronização.

#### Sincronização parada

A idade da sincronização sai da API, lida do banco a cada coleta, e segue crescendo com o worker parado (`CAT-15`). Se o alerta veio do counter de falhas de leitura, o gauge está congelado no último valor: o log `casecellshop.catalog.gauge.read_failed` traz o erro, e a leitura é do banco (`curl -i http://localhost:3000/health`).

1. Confira o worker (`docker compose ps worker`) e as chamadas `list_catalog` no painel do ERP: um desfecho diferente de `ok` aponta o ERP; nenhuma chamada aponta a sincronização.
2. ERP fora: a loja segue com o último preço e estoque conhecidos; o checkout continua, e o preço cobrado é o do banco da loja (`CHK-06`). Siga [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração).
3. Worker de pé e sem chamadas: reinicie o worker (`docker compose restart worker`), que faz a carga na subida.
4. Enquanto a sincronização não volta, uma venda em outro canal não aparece na loja: acompanhe o alerta [Furo de estoque](#furo-de-estoque).

#### Vitrine servida velha

1. A origem do cache é o banco da loja. Veja as cargas da origem por desfecho: `error` crescendo aponta o banco (`curl -i http://localhost:3000/health`, log `casecellshop.health.db.unavailable`).
2. Até 60 s, a vitrine serve a última entrada; depois, responde `503` e o alerta de disponibilidade dispara.
3. O checkout não depende do cache, só do banco: se o banco responde ao checkout e a origem falha, procure o erro da origem no trace de `GET /products`.

### Datadog

O mesmo `/metrics`, sem mudar o código. O Agent do Datadog coleta o endpoint pela integração OpenMetrics, configurada pelo `openmetrics_endpoint`, pelo `namespace` e pela lista `metrics`, de expressões regulares ([integração OpenMetrics](https://docs.datadoghq.com/integrations/openmetrics/), consultado em 02/11/2026). Um exemplo de `conf.d/openmetrics.d/conf.yaml`, com os nomes dos serviços do compose:

```yaml
instances:
  - openmetrics_endpoint: http://api:3000/metrics
    namespace: casecellshop
    metrics:
      - casecellshop_.*
      - http_server_.*
  - openmetrics_endpoint: http://worker:9464/metrics
    namespace: casecellshop
    metrics:
      - casecellshop_.*
```

- **Nomes:** o `namespace` vai na frente de cada métrica, e um counter chega com o nome sem `_total` e o sufixo `.count`. Os monitores do Datadog usam a linguagem de consulta do próprio Datadog, e não PromQL: cada consulta acima é reescrita nela, com o nome novo, e os limites, as janelas e os runbooks valem iguais.
- **Traces:** o Agent recebe OTLP por HTTP na porta 4318, com `DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT` ligado no Agent; no serviço, `OTEL_TRACES_EXPORTER=otlp` e `OTEL_EXPORTER_OTLP_ENDPOINT` apontando para ele ([OTLP no Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/), consultado em 02/11/2026).
- **Log e trace ligados:** o log já traz `trace_id` (32 caracteres hexadecimais) e `span_id` (16) no topo do JSON, e os traces e os logs levam `service`, `env` e `version`, os três da marcação unificada de serviço, que o Datadog exige para ligar os dois ([logs e traces do OpenTelemetry](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/) e [mapeamento da semântica](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/), consultados em 02/11/2026).

## Riscos residuais

O que as garantias não cobrem e como aparece na operação. A lista completa, com a mitigação de cada risco, está em "Riscos em aberto", no [`STATE.md`](.specs/project/STATE.md).

| Risco | Como é detectado | O que resta |
| --- | --- | --- |
| Sem a H1b e acima do limite da H4, o ERP fatura duas vezes, ou o pedido falha com uma fatura que aparece depois (R6) | não é detectável pela loja; demonstrado no `ORD-06` | conferir as faturas no ERP real antes de confiar na H4 |
| O ERP fatura sem estoque e fica negativo, contra a H2 (R9) | a sincronização grava zero e registra o caso em log | a loja para de vender o SKU até o estoque voltar |
| Venda em outro canal entre duas rodadas da sincronização | alerta [Furo de estoque](#furo-de-estoque) (`OBS-06`) | o cliente recebe `202` e o pedido termina `failed` com `erp_out_of_stock` |
| Cache por instância: com N réplicas da API, uma expiração gera até N consultas à origem | cargas da origem no dashboard | aceito enquanto a origem é o banco da loja (AD-005) |
| O ElasticMQ não é o SQS (R12) | o worker trata o *receipt handle* recusado e o sucesso aparente do mesmo jeito | na AWS, muda só o endereço; o `ListMessageMoveTasks` não é chamado |
| O exportador Prometheus passa a acrescentar o sufixo de unidade (R13) | o teste dos nomes do `/metrics` (`OBS-07`) reprova no PR da atualização; o das consultas desta página (`OBS-03`) segue o `prometheusName` do gerador do catálogo, que precisa mudar junto | ajustar os alertas e o dashboard junto, numa decisão |

## Hipóteses, premissas e limitações

- **Hipóteses sobre o ERP:** H1a a H4, em [Garantias e modos de falha](#garantias-e-modos-de-falha). O ERP simulado as segue; um ERP real precisa confirmá-las.
- **Premissas de carga:** o pico de pedidos, a latência e o limite de chamadas do ERP e o tamanho do catálogo, de onde saem os parâmetros do design, estão no [`PROJECT.md`](.specs/project/PROJECT.md), seção "Hipóteses", e serão revistos com medição.
- **ERP simulado:** roda no processo do worker, atrás da porta `ErpClient`; trocar pelo real muda o adaptador, e não a regra.
- **Sem autenticação nem pagamento:** fora do escopo do desafio.
- **Uma instância de cada serviço no compose:** o desenho admite várias (fila, outbox e locks no banco), mas o compose sobe uma de cada.
- **Alertas e dashboard são exemplos:** as regras estão neste README, sem um Prometheus nem um Alertmanager no compose; o `/metrics` é o mesmo que um Prometheus ou o Agent do Datadog coletaria.
- **Nuvem como hipótese:** tudo roda localmente; o equivalente gerenciado de cada peça está no `ARCHITECTURE.md`, seção "A nuvem como hipótese de evolução".

## Como a IA foi usada

O código foi escrito por agentes do Claude Code num fluxo em que a verificação é automática e independente de quem escreve, e o mantenedor decide no plano e no merge (AD-012):

1. **Plano:** a sessão principal propõe critérios de aceite com ID e o mantenedor aprova.
2. **Testes antes do código:** o agente `test-writer` escreve os testes a partir dos critérios, sem ler a implementação.
3. **Código:** o agente `implementer` escreve até os testes passarem, sem poder alterar testes, CI nem configuração de verificação.
4. **Revisão:** o agente `reviewer`, só leitura, revisa cada fatia; o relatório vai ao PR sem edição, e a revisão só termina sem achado alto ou médio aberto (AD-015).
5. **Merge:** só com CI verde e a aprovação do mantenedor, que responde pelo resultado.

Os commits feitos com IA levam o trailer `Assisted-by: <papel>:<modelo>`, na convenção do kernel Linux ([`CONVENTIONS.md`](.specs/codebase/CONVENTIONS.md)); o mantenedor é o autor e responde por eles. As regras abaixo são impostas pelo código, não só por instruções:

| Regra | Onde é imposta | Teste |
| --- | --- | --- |
| Cada agente edita só os arquivos do seu papel | [`.claude/hooks/path-guard.mjs`](.claude/hooks/path-guard.mjs) | `FND-08` |
| O `implementer` não termina com lint, tipos ou testes falhando, nem o `test-writer` com lint ou tipos; depois da terceira devolução, a parada passa como exceção registrada | [`.claude/hooks/subagent-stop.mjs`](.claude/hooks/subagent-stop.mjs) | `AI-03` |
| Tamanho, complexidade e sentido das dependências do código | [`.oxlintrc.json`](.oxlintrc.json) (AD-026) | lint no CI |
| A `main` só muda por PR aprovado e com CI verde | ruleset do GitHub (AD-013) | — |

**Qualidade do código gerado.** Uma instrução sozinha não impede a IA de errar em silêncio. Cada tipo de erro que as revisões dos primeiros PRs acharam passou a ter uma checagem de máquina ou uma regra do processo; a checagem roda no primeiro momento em que já pega o erro: na edição, na parada do agente, no `pre-push` (`npm run verify`), no CI ou na execução agendada.

| Risco no código gerado | Ferramenta ou prática | Critério |
| --- | --- | --- |
| Teste que não prova o que diz | testes escritos antes do código, a partir do critério; o ID do critério no nome de cada teste, conferido pelo lint; controle negativo nos testes de concorrência; a tabela critério × teste publicada pelo CI | `AI-38`, `AI-18`, `CHK-02` |
| Teste apagado, pulado ou afrouxado para passar | o lint reprova `.only` e `.skip`, e o `implementer` não edita testes | `AI-02`, `FND-08` |
| Garantia que só vale com mock | integração contra PostgreSQL e ElasticMQ reais, pelo Testcontainers; a regra dos testes proíbe mock de banco e de fila ([`.claude/rules/tests.md`](.claude/rules/tests.md)) | `FND-14` |
| Casos que ninguém pensou | testes de propriedade (fast-check) nas funções que decidem prazos, classificam respostas e validam entradas; fuzzing da API pelo contrato (Schemathesis) | `FND-15`, `FND-16` |
| SQL montado com entrada ou transação fora do lugar | Kysely com os tipos gerados do banco e regras de lint próprias | `AI-19`, `FND-09` |
| Formato, tipos e estilo divergentes | Prettier, TypeScript com opções estritas e as regras a mais do oxlint; os limites de tamanho e de complexidade estão na tabela acima (AD-026) | `AI-34`, `AI-20` |
| Código sem uso ou repetido | knip e jscpd, contra uma linha de base que só melhora | `AI-35`, `AI-36`, `AI-49` |
| Cobertura caindo | cobertura medida no CI, com piso que só sobe | `AI-37`, `AI-49` |
| Comentário que desliga uma checagem | teste que reprova os comentários de supressão do lint, do jscpd e da cobertura | `AI-47` |
| Dependência vulnerável, adulterada ou recém-publicada | `npm audit`, `npm audit signatures`, a origem do lockfile conferida, espera mínima para versões novas e Dependabot | `AI-05`, `AI-39`, `AI-42`, `AI-45`, `AI-50` |
| Falha de segurança no código ou no CI | CodeQL em todo PR, actionlint e zizmor nos workflows, e o `/security-review` antes de o PR sair do rascunho | `AI-44`, `AI-43`, `AI-16` |
| Teste instável | a suíte embaralhada em várias sementes na execução agendada, que abre uma issue quando falha | `AI-46` |
| O sistema montado, que nenhum teste vê inteiro | o `app-check`: sobe o compose e percorre o fluxo antes de o PR sair do rascunho | `AI-22` |

O teste de mutação (Stryker), que mediria quantos erros plantados os testes pegam, não entrou: está nos "Adicionais" do [`ROADMAP.md`](.specs/project/ROADMAP.md).

Os prompts que governam os agentes, as orientações do mantenedor que mudaram o rumo de cada marco e os erros da IA pegos antes do merge, com o relatório de revisão de cada um, estão no [`PROMPTS.md`](PROMPTS.md); os trechos que governam a fila e as respostas da IA recusadas ou corrigidas, no `ARCHITECTURE.md`, seção "Prompts de IA relevantes".

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md) (explicação): as respostas às cinco perguntas, o diagnóstico e a arquitetura alvo.
- [`openapi.yaml`](openapi.yaml) (referência): o contrato HTTP.
- [`.specs/`](.specs/README.md) (referência): critérios de aceite, design, decisões e marcos.
- [`PROMPTS.md`](PROMPTS.md) e [`AGENTS.md`](AGENTS.md): as instruções dos agentes.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) (como fazer): preparar a máquina, as checagens e o fluxo de PR.

## Contribuir

O passo a passo para preparar a máquina, rodar as checagens e abrir um PR está no [`CONTRIBUTING.md`](CONTRIBUTING.md). A sessão do Claude Code na nuvem (claude.ai/code) se prepara sozinha; o que ela faz e o script opcional do painel estão em [Sessão do Claude Code na nuvem](CONTRIBUTING.md#sessão-do-claude-code-na-nuvem).

## Licença

[MIT](LICENSE).
