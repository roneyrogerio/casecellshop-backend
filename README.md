# CaseCellShop backend

[![CI](https://github.com/roneyrogerio/casecellshop-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/roneyrogerio/casecellshop-backend/actions/workflows/ci.yml)

Serviço entre a loja virtual da CaseCellShop e um ERP legado que não pode ser alterado: serve o catálogo do banco da loja, reserva o estoque de forma atômica no checkout e envia os pedidos ao ERP de forma assíncrona, por uma outbox e uma fila SQS. Node.js 26, TypeScript, PostgreSQL e OpenTelemetry. O ERP é simulado no processo do worker, atrás da porta `ErpClient`.

## Em resumo

| Problema do desafio | Causa raiz | Solução | O que os testes provam |
| --- | --- | --- | --- |
| Vitrine lenta | o ERP está no caminho de cada leitura | banco próprio da loja, sincronizado com o ERP, e cache em processo com TTL, *single-flight* (uma consulta para N leituras simultâneas) e *stale-if-error* (serve a última página se o banco falhar) | N leituras com o cache expirado fazem 1 consulta ao banco; com o banco em erro, a vitrine segue servindo: [`products-cache.test.ts`](test/integration/catalog/products-cache.test.ts) (`CAT-01` a `CAT-15`) |
| Venda além do estoque | o estoque é conferido num momento e baixado em outro | reserva atômica com `UPDATE` condicional e idempotência pela `Idempotency-Key` | 50 checkouts simultâneos com estoque 5 aceitam exatamente 5, e a mesma chave em paralelo cria um pedido só: [`checkout-concurrency.test.ts`](test/integration/checkout/checkout-concurrency.test.ts) (`CHK-01` a `CHK-05`) |
| Checkout que depende do ERP | o faturamento é síncrono | `202` na hora; outbox, fila SQS e worker com retry, DLQ e reconciliação | mensagem duplicada, worker morto no meio da chamada ou ERP lento: uma fatura por pedido: [`worker-duplicates.test.ts`](test/integration/billing/worker-duplicates.test.ts) (`ORD-01` a `ORD-22`) |

Os IDs (`CAT-01`, `CHK-01`, `ORD-01`…) são os critérios de aceite do [`spec.md`](.specs/features/casecellshop/spec.md), e cada teste começa pelo ID do critério que prova: `grep -rn "CHK-01" test src` acha a prova. O prefixo diz a área: `CAT` vitrine, `CHK` checkout, `ORD` faturamento, `OBS` observabilidade, `FND` fundação do projeto, `DOC` documentação e `AI` o fluxo de trabalho com IA.

- **Rodar:** `docker compose up --build`, e o [exemplo de ponta a ponta](#rodar).
- **Respostas às cinco perguntas:** [`RESPOSTAS.md`](RESPOSTAS.md); os detalhes de cada uma estão no [`ARCHITECTURE.md`](ARCHITECTURE.md).
- **Testes que importam:** os arquivos de domínio estão em [Testar](#testar).
- **Limitações:** [Hipóteses, premissas e limitações](#hipóteses-premissas-e-limitações).
- **Uso de IA:** [Como a IA foi usada](#como-a-ia-foi-usada) e [`PROMPTS.md`](PROMPTS.md).
- **Operação:** SLOs, dashboard, alertas e runbooks na seção [Operação](#operação).

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
- [Riscos residuais](#riscos-residuais)
- [Hipóteses, premissas e limitações](#hipóteses-premissas-e-limitações)
- [Como a IA foi usada](#como-a-ia-foi-usada)
- [Operação](#operação)
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
# HTTP/1.1 202 Accepted
# Location: /orders/<orderId>/status
# Retry-After: 4
# {"orderId":"<orderId>","status":"pending","total":4990}

curl http://localhost:3000/orders/<orderId>/status
# {"orderId":"<orderId>","status":"invoiced"}
```

O checkout responde na hora, com o pedido `pending` e o total em centavos. O worker fatura no ERP simulado em segundo plano, e o status vira `invoiced` em poucos segundos: o `Retry-After: 4` diz quando consultar. Repetir o `POST` com a mesma `idempotency-key` devolve o mesmo pedido.

Para parar e apagar os dados:

```sh
docker compose down -v
```

O contrato completo está no [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), e o [`requests.http`](requests.http) tem as requisições do `/health` e do `/metrics`; as da vitrine, do checkout e do status do pedido estão no exemplo acima. O contrato declara o servidor `http://localhost:3000`, então o `openapi.yaml` importado no Insomnia ou no Postman já aponta para a API do compose.

## Testar

```sh
npm ci
npm test            # tudo: unitários e integração com PostgreSQL, SQS e compose reais
npm run test:unit   # só os unitários, sem Docker
```

Os testes de integração rodam contra PostgreSQL e ElasticMQ reais, pelo Testcontainers, porque as garantias dependem do comportamento do banco e da fila (lock, transação, índice único, visibilidade de mensagem), que um mock não reproduz. Cada teste começa pelo ID do critério que prova (`CHK-01 …`), e o CI publica a tabela critério × teste a cada execução.

A maior parte da suíte confere o próprio repositório (CI, hooks, contrato, telemetria). As regras de negócio estão nestes arquivos:

| Arquivo | O que prova |
| --- | --- |
| [`checkout-concurrency.test.ts`](test/integration/checkout/checkout-concurrency.test.ts) | 50 checkouts simultâneos com estoque 5 aceitam exatamente 5, e uma versão ingênua do repositório, com uma janela entre ler e gravar, vende além (controle negativo); a mesma chave em paralelo cria um pedido só; SKUs em ordem trocada não dão deadlock |
| [`checkout.test.ts`](test/integration/checkout/checkout.test.ts) | o corpo do `202`; a chave repetida devolve o pedido original; o preço mudado recebe `409` sem reservar nada |
| [`products-cache.test.ts`](test/integration/catalog/products-cache.test.ts) e [`cache.test.ts`](src/cache/cache.test.ts) | N leituras com a entrada expirada fazem 1 consulta ao banco; a entrada expira no TTL; com o banco em erro, a vitrine serve a última página até 60 s |
| [`worker-duplicates.test.ts`](test/integration/billing/worker-duplicates.test.ts) | uma fatura por pedido com mensagem duplicada, worker morto no meio da chamada ou ERP que fatura sem responder |
| [`call-permit.test.ts`](test/integration/billing/call-permit.test.ts) | no máximo uma chamada ao ERP por pedido a cada 45 s: tomadas simultâneas do mesmo pedido concedem uma só, e uma versão ingênua concede duas (controle negativo) |
| [`reconciliation.test.ts`](test/integration/billing/reconciliation.test.ts) | com o ERP fora além da janela de retry, os pedidos esperam na DLQ com a reserva; quando ele volta, a reconciliação fatura os que ele já tem |

## Conferir

As checagens que o CI roda:

```sh
npm run verify       # lint, formato, tipos, testes unitários, openapi.yaml gerado e o lint dele, instruções, migrações, scripts do package.json, código sem uso e repetido
npm run verify:full  # o mesmo, com a suíte inteira no Docker e os tipos do banco
```

O `openapi.yaml` sai do contrato em zod e o [catálogo de telemetria](.specs/features/casecellshop/telemetry.md) sai das declarações de cada pasta; os dois são conferidos contra o gerado: o `openapi.yaml` pelo `npm run openapi -- --check`, e o catálogo pelo teste `OBS-07`, que o `npm run telemetry-doc -- --check` também roda à mão. O que cada job do CI confere está no [`CONTRIBUTING.md`](CONTRIBUTING.md).

## O que o desafio pede e onde está

Tudo o que o desafio pede está pronto. A última coluna diz o que o teste prova e aponta um arquivo representativo.

| O desafio pede | Onde | O que o teste prova |
| --- | --- | --- |
| `GET /products` com cache e TTL | [`src/catalog/`](src/catalog/), cache em memória (AD-005) | N leituras com o cache expirado fazem 1 consulta ao banco, e a entrada expira no TTL: [`products-cache.test.ts`](test/integration/catalog/products-cache.test.ts) (`CAT-01` a `CAT-15`) |
| `POST /checkout` responde `202` com `orderId` e status | [`src/checkout/`](src/checkout/) | o corpo do `202` traz `orderId`, `status` e total, validados pelo schema do contrato: [`checkout.test.ts`](test/integration/checkout/checkout.test.ts) (`CHK-09`) |
| `GET /orders/{orderId}/status` | [`src/orders/`](src/orders/) | `pending`, `invoiced` ou `failed` com o motivo, e `404` para pedido inexistente: [`order-status.test.ts`](test/integration/checkout/order-status.test.ts) (`CHK-11`, `ORD-19`) |
| Contrato com schemas de sucesso e erro | [`openapi.yaml`](openapi.yaml), gerado de [`src/contract/`](src/contract/); erros em `application/problem+json` (RFC 9457) | requisição fora do contrato recebe `400` em `application/problem+json`: [`contract-validation.test.ts`](test/integration/foundation/contract-validation.test.ts) (`FND-03`); o CI falha se o `openapi.yaml` divergir do contrato: [`generate-openapi.test.ts`](scripts/generate-openapi.test.ts) (`FND-07`) |
| Logs estruturados com `correlationId` (o `X-Request-Id`) e `orderId` | [`src/shared/logging.ts`](src/shared/logging.ts), eventos no [catálogo de telemetria](.specs/features/casecellshop/telemetry.md) | dentro de uma requisição, o log leva o `correlationId`; dentro de um span, o `trace_id` e o `span_id`: [`logging.test.ts`](src/shared/logging.test.ts) (`OBS-01`, `OBS-07`) |
| Métricas de cache, checkout e fila | `/metrics` da API e do worker, nomes no catálogo de telemetria | o `/metrics` da API e o do worker expõem toda métrica do catálogo, e nenhuma fora dele: [`metrics-names.test.ts`](test/integration/observability/metrics-names.test.ts) (`OBS-02`, `OBS-04`, `OBS-06`, `OBS-07`) |
| Trace ligando requisição, cache, repositório e worker | [`src/shared/telemetry.ts`](src/shared/telemetry.ts), Jaeger | a chamada ao ERP fica no trace do checkout, e o log da tentativa traz o mesmo `trace_id`: [`worker-erp-spans.test.ts`](test/integration/billing/worker-erp-spans.test.ts) (`FND-05`, `CHK-12`, `ORD-18`, `CAT-12`, `OBS-05`) |
| Exemplo de dashboard, alerta ou runbook | [Operação](#operação): SLOs, dashboard, alertas em regras do Prometheus e um runbook por alerta | cada consulta e cada regra da seção é PromQL válido e só usa métricas, rótulos e valores do catálogo: [`readme-promql.test.ts`](test/repo/readme-promql.test.ts) (`OBS-03`); o cancelamento do runbook da DLQ: [`runbook.test.ts`](test/integration/billing/runbook.test.ts) (`ORD-15`) |
| Checkout sem venda além do estoque | reserva atômica no PostgreSQL (AD-002) | 50 checkouts simultâneos com estoque 5 aceitam 5, e uma versão ingênua vende além, no mesmo arquivo: [`checkout-concurrency.test.ts`](test/integration/checkout/checkout-concurrency.test.ts) (`CHK-01`, `CHK-02`) |
| Idempotência para retry e duplo clique | `Idempotency-Key` gravada na transação do pedido (AD-006) | a mesma chave repetida depois de o estoque acabar, ou com os campos em outra ordem, devolve o mesmo pedido: [`checkout.test.ts`](test/integration/checkout/checkout.test.ts) (`CHK-04`, `CHK-05`); em paralelo, cria um pedido só: [`checkout-concurrency.test.ts`](test/integration/checkout/checkout-concurrency.test.ts) (`CHK-03`) |
| Worker simulando o envio ao ERP | [`src/billing/`](src/billing/), ERP simulado em [`src/erp/sim/`](src/erp/sim/) | uma fatura por pedido com mensagem duplicada, worker morto ou ERP lento: [`worker-duplicates.test.ts`](test/integration/billing/worker-duplicates.test.ts) (`ORD-01` a `ORD-22`) |
| Testes de regra de negócio, cache e concorrência | [`test/`](test/) e unitários ao lado do código | os arquivos de domínio estão em [Testar](#testar) (regra de negócio: `CHK-03` a `CHK-12`, `ORD-01` a `ORD-22`; cache: `CAT-01` a `CAT-05`; concorrência: `CHK-01`, `CHK-02`, `CHK-07`); a tabela critério × teste sai em cada execução do CI |
| Decisões, trade-offs, limitações, instruções para rodar e prompts de IA | este README, [`PROMPTS.md`](PROMPTS.md) | conferidos na revisão: as garantias e os modos de falha, cada um com o teste que o prova (`DOC-OPS-01`), e o índice das cinco perguntas (`DOC-IDX-01`) |

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
| Fluxo de IA com papéis separados, e os testes fora do alcance de quem implementa | o código é conferido por testes escritos antes e por uma revisão independente | revisar cada parte de um marco (uma etapa do [`ROADMAP.md`](.specs/project/ROADMAP.md)), e não só o marco inteiro, soma mais rodadas de revisão | [AD-012](.specs/project/STATE.md) |

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
| No máximo uma chamada ao ERP por pedido a cada atraso mínimo | o banco da loja (a hora da última chamada fica na outbox e só avança por *compare-and-set*) | `ORD-02`, `ORD-11` |
| Estoque baixado uma vez só, mesmo com conclusões simultâneas | o banco da loja | `ORD-17` |
| Reserva liberada quando o ERP recusa o pedido | H2 | `ORD-08` |
| Todo pedido aceito termina faturado, falho ou na DLQ, de onde sai pela reconciliação ou pelo runbook | H1a | `ORD-13`, `ORD-14`, `ORD-15` |
| Fatura duplicada, ou fatura de pedido falho, detectada em até ~20 min depois da última chamada ao ERP, com alerta uma vez por pedido | H1a e a leitura do MySQL do ERP (AD-031) | `ORD-06`, `ORD-23`, `ORD-24`, `ORD-25` |
| O cancelamento manual e a recusa depois de um envio sem resposta só concluem depois da janela de assentamento e da consulta ao ERP | H1a | `ORD-26`, `ORD-27` |
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
| ERP acima do limite da H4 e sem a H1b | verificação tardia, depois da janela de assentamento de 15 min: consulta pela referência e contagem de faturas no MySQL do ERP; alerta [Fatura tardia ou duplicada](#fatura-tardia-ou-duplicada) | a loja não evita a segunda fatura nem a fatura de pedido falho, porque o ERP não deduplica (R6); detecta cada caso uma vez, sem mudar o pedido, e o runbook corrige; a recusa depois de um envio sem resposta e o cancelamento manual esperam a janela e consultam o ERP antes de concluir | `ORD-06`, `ORD-23` a `ORD-27` |
| Worker morre no meio da chamada | a mensagem volta a ficar visível no SQS | nova tentativa só depois do atraso mínimo, contado do início da chamada abandonada | `ORD-02` |
| Mensagem que derruba o processo ou fora do schema | contagem de recebimentos do SQS; log `casecellshop.outbox.message.rejected` | vai sozinha para a DLQ, e as outras do lote seguem | `ORD-12` |
| Banco indisponível no checkout | `lock_timeout` ou falha de conexão; burn rate do checkout | `503` com `Retry-After`, sem reserva parcial | `CHK-08` |
| Banco falha ao gravar o desfecho | erro na transação de conclusão | até 5 repetições; depois a mensagem volta à fila, sem ir para a DLQ | `ORD-16` |
| SKU disputado por muitos checkouts | `409` por falta de estoque no desfecho do checkout | `UPDATE` condicional na linha do estoque, sem venda além dele | `CHK-01`, `CHK-07` |
| Origem do cache em erro | consultas à origem com `error`; alerta [Vitrine servida velha](#vitrine-servida-velha) | serve a última entrada até o teto de 60 s, sem esperar a origem durante a pausa; sem entrada, `503` | `CAT-04` |
| Sincronização parada | idade da sincronização; alerta [Sincronização parada](#sincronização-parada) | a loja segue com o último estoque e preço conhecidos; o checkout decide pelo banco | `CAT-09`, `CAT-11`, `CAT-15` |
| Venda em outro canal | SKUs com `reserved > on_hand` e rejeições por falta de estoque; alerta [Furo de estoque](#furo-de-estoque) | a sincronização desconta as vendas da loja depois da leitura; o ERP recusa sem estoque (H2) e a reserva é liberada | `CAT-07`, `OBS-06`, `ORD-08` |
| Preço alterado entre a vitrine e o checkout | `409` com o preço atual; log `casecellshop.checkout.price_changed` | nada é reservado; o cliente confirma o preço novo | `CHK-06` |

## Riscos residuais

O que as garantias não cobrem e como aparece na operação. A lista completa, com a mitigação de cada risco, está em "Riscos em aberto", no [`STATE.md`](.specs/project/STATE.md).

| Risco | Como é detectado | O que resta |
| --- | --- | --- |
| Sem a H1b e acima do limite da H4, o ERP fatura duas vezes, ou o pedido falha com uma fatura que aparece depois (R6) | verificação tardia em até ~20 min depois da última chamada ao ERP, alerta [Fatura tardia ou duplicada](#fatura-tardia-ou-duplicada); a duplicata e a detecção são demonstradas em [`worker-duplicates.test.ts`](test/integration/billing/worker-duplicates.test.ts) (`ORD-06`) e [`late-check.test.ts`](test/integration/billing/late-check.test.ts) (`ORD-23`, `ORD-24`) | a loja não evita a fatura a mais, porque o ERP não deduplica; o estorno é manual, pelo runbook; uma fatura que aparece depois da verificação (mais de 15 min além da H4) não é vista; a contagem lê uma tabela interna do MySQL do ERP, que pode mudar numa atualização dele, e a falha dessa leitura tem alerta próprio (AD-031) |
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
- **Sem front-end:** a loja virtual não faz parte da entrega; o contrato ([`openapi.yaml`](openapi.yaml)) e o exemplo com `curl` em [Rodar](#rodar) fazem o papel dela.
- **Sem deploy:** não há ambiente publicado nem pipeline de entrega; tudo sobe com `docker compose up`, e o CI só verifica.
- **Uma instância de cada serviço no compose:** o desenho admite várias (fila, outbox e locks no banco), mas o compose sobe uma de cada.
- **Alertas e dashboard são exemplos:** as regras estão neste README, sem um Prometheus nem um Alertmanager no compose; o `/metrics` é o mesmo que um Prometheus ou o Agent do Datadog coletaria.
- **Nuvem como hipótese:** tudo roda localmente; o equivalente gerenciado de cada peça está no `ARCHITECTURE.md`, seção "A nuvem como hipótese de evolução".

## Como a IA foi usada

O código foi escrito por agentes do Claude Code num fluxo em que a verificação é automática e independente de quem escreve, e o mantenedor decide no plano e no merge (AD-012):

1. **Plano:** a sessão principal propõe critérios de aceite com ID e o mantenedor aprova.
2. **Testes antes do código:** o agente `test-writer` escreve os testes a partir dos critérios, sem ler a implementação.
3. **Código:** o agente `implementer` escreve até os testes passarem, sem poder alterar testes, CI nem configuração de verificação.
4. **Revisão:** o agente `reviewer`, só leitura, revisa cada parte do marco (uma etapa do [`ROADMAP.md`](.specs/project/ROADMAP.md)); o relatório vai ao PR sem edição, e a revisão só termina sem achado alto ou médio aberto (AD-015).
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

<details>
<summary>As consultas dos SLIs (PromQL)</summary>

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
# O counter existe em 0 desde a subida da API (OBS-08).
1 - (
  sum(increase(casecellshop_order_stuck_total[30d]))
  /
  sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[30d]))
)
```

</details>

### Dashboard de exemplo

Painéis da vitrine, do checkout, da fila, do ERP, do estoque e da sincronização. Uma linha por área; cada consulta é um painel, com o título no comentário. A janela de 5 min é a dos painéis.

<details>
<summary>As consultas dos painéis (PromQL)</summary>

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

# Fila: achados da verificação tardia por causa (fatura de pedido falho, fatura duplicada), nas últimas 24 h
sum by (casecellshop_late_invoice_cause) (increase(casecellshop_order_late_invoices_total[24h]))
```

```promql
# ERP: chamadas por operação e desfecho
sum by (casecellshop_erp_operation, casecellshop_erp_outcome) (rate(casecellshop_erp_client_operation_duration_count[5m]))

# ERP: latência p99 por operação (s)
histogram_quantile(0.99, sum by (le, casecellshop_erp_operation) (rate(casecellshop_erp_client_operation_duration_bucket[5m])))

# ERP: chamadas em andamento (limite de 30)
sum(casecellshop_erp_client_active_operations)

# ERP: erros de configuração por operação, na última hora
sum by (casecellshop_erp_operation) (increase(casecellshop_erp_config_errors_total[1h]))
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

</details>

### Alertas

Cada regra traz a severidade (`page` acorda alguém; `ticket` vai para a fila do time) e o link do runbook. Os alertas de SLO seguem o *burn rate* em várias janelas: disparam quando o orçamento de erro de 30 dias está sendo gasto rápido demais.

| Alerta | Dispara quando | Severidade | Runbook |
| --- | --- | --- | --- |
| `CasecellshopApiForaDoAr` | nenhuma réplica da API responde à coleta, ou o alvo some, por 2 min | `page` | [API fora do ar](#api-fora-do-ar) |
| `CasecellshopErrosBurnRateRapido` e `…Lento` | a vitrine ou o checkout gastam o orçamento de `5xx` | `page` e `ticket` | [Burn rate da vitrine ou do checkout](#burn-rate-da-vitrine-ou-do-checkout) |
| `CasecellshopVitrineLentaBurnRate…` e `CasecellshopCheckoutLentoBurnRate…` | a vitrine passa de 200 ms, ou o checkout de 500 ms, acima do orçamento | `page` e `ticket` | [Burn rate da vitrine ou do checkout](#burn-rate-da-vitrine-ou-do-checkout) |
| `CasecellshopFaturamentoBurnRate…` | pedidos sem desfecho em 60 s acima do orçamento | `page` e `ticket` | [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento) |
| `CasecellshopPendenciaAntiga` | a pendência mais antiga da outbox passa de 2 min, ou a leitura dela falha, por 5 min | `ticket` | [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento) |
| `CasecellshopMetricasDaFilaAusentes` | o gauge da fila some, por 10 min | `ticket` | [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento) |
| `CasecellshopDLQ` | há mensagem na DLQ, ou a leitura da fila falha, por 10 min | `ticket` | [DLQ](#dlq) |
| `CasecellshopFuroDeEstoque` | um SKU com `reserved > on_hand`, uma rejeição do ERP por falta de estoque, ou a leitura do estoque falha | `page` | [Furo de estoque](#furo-de-estoque) |
| `CasecellshopVerificacaoTardiaSemLeitura` | a contagem de faturas pela leitura do banco do ERP falhou na última hora, por 15 min | `ticket` | [Verificação tardia sem leitura do ERP](#verificação-tardia-sem-leitura-do-erp) |
| `CasecellshopFaturaTardia` | a verificação tardia achou uma fatura de pedido falho ou uma fatura duplicada | `page` | [Fatura tardia ou duplicada](#fatura-tardia-ou-duplicada) |
| `CasecellshopErpErroDeConfiguracao` | uma chamada ao ERP com `config_error` | `page` | [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração) |
| `CasecellshopErpFalhando` | mais da metade das chamadas `transient` ou `ambiguous`, por 10 min | `ticket` | [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração) |
| `CasecellshopSincronizacaoParada` | a última rodada completa tem mais de 3 min, a série some, ou a leitura dela falha, por 5 min | `page` | [Sincronização parada](#sincronização-parada) |
| `CasecellshopVitrineServidaVelha` | a idade p99 da entrada servida passa de 30 s, por 5 min | `ticket` | [Vitrine servida velha](#vitrine-servida-velha) |
| `CasecellshopVitrineComDadoErrado` | `price_changed` e `out_of_stock` passam de 10% dos checkouts decididos em 30 min, com ao menos 20 na janela, por 15 min | `ticket` | [Vitrine com dado errado](#vitrine-com-dado-errado) |

<details>
<summary>As regras do Prometheus (YAML), a configuração de coleta e como as regras foram montadas</summary>

As regras estão no formato de arquivo de regras do Prometheus ([regras de alerta](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)). O `promtool check rules` não roda aqui (a troca está no [`STATE.md`](.specs/project/STATE.md), em "Escolhas de ferramenta"): o teste do `OBS-03` lê cada `expr` pelo analisador oficial do PromQL (`@prometheus-io/lezer-promql`) e confere a sintaxe, o nome e os rótulos de cada série contra o catálogo, os valores das listas fechadas, o `for`, a severidade, o resumo e a âncora do runbook. Ele não avalia as regras contra dados.

Os alertas de SLO seguem o burn rate em várias janelas do livro de SRE do Google ([Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/), consultado em 02/11/2026): `page` com 14,4 vezes o ritmo que gasta o orçamento de 30 dias, em 1 h e em 5 min (2% do orçamento), ou 6 vezes, em 6 h e em 30 min (5%); `ticket` com 1 vez, em 3 dias e em 6 h (10%). A janela curta faz o alerta parar logo que o problema acaba, por isso essas regras não precisam de `for`.

O alerta de API fora do ar lê o `up`, a série que o próprio Prometheus grava a cada coleta: 1 quando o alvo respondeu, 0 quando não ([séries geradas pela coleta](https://prometheus.io/docs/concepts/jobs_instances/#automatically-generated-labels-and-time-series), consultado em 02/11/2026). Com a API fora, nenhuma série de requisição chega, e nenhum *burn rate* dispara. O `job` das regras é o desta configuração de coleta, com os nomes dos serviços do compose:

```yaml
scrape_configs:
  - job_name: casecellshop-api
    static_configs:
      - targets: ['api:3000']
  - job_name: casecellshop-worker
    static_configs:
      - targets: ['worker:9464']
```

Cada counter de lista fechada sai no `/metrics` em 0 desde a subida do processo, uma série por combinação dos valores dos atributos (`OBS-08`), como pede a documentação do Prometheus ([Avoid missing metrics](https://prometheus.io/docs/practices/instrumentation/#avoid-missing-metrics), consultado em 02/11/2026): sem isso, a série nasceria com o primeiro evento, e o `increase` não contaria esse evento, porque não haveria amostra anterior. Um histograma não nasce em 0 (a API do OpenTelemetry não o permite), e por isso o alerta de erro de configuração do ERP lê o counter próprio dele, e não o `_count` do histograma de duração. Os gauges da fila e da sincronização, que precisam existir, têm um `absent` próprio. Um gauge cuja leitura falha segue exportando o último valor, e a falha conta no counter de falhas de leitura da pasta; por isso os alertas de fila, de furo de estoque e de sincronização parada também disparam por esse counter, como pede o item "Leitura que falha" do [`design.md`](.specs/features/casecellshop/design.md), seção "Observabilidade" (na sincronização, `CAT-15`).

```yaml
groups:
  - name: casecellshop
    rules:
      - alert: CasecellshopApiForaDoAr
        expr: |
          max(up{job="casecellshop-api"}) == 0
          or
          absent(up{job="casecellshop-api"})
        for: 2m
        labels:
          severity: page
        annotations:
          summary: Nenhuma réplica da API responde à coleta do /metrics
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#api-fora-do-ar
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
      - alert: CasecellshopVerificacaoTardiaSemLeitura
        expr: |
          sum(increase(casecellshop_erp_client_operation_duration_count{casecellshop_erp_operation="count_invoices",casecellshop_erp_outcome="transient"}[1h])) > 0
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: A verificação tardia não consegue contar as faturas no banco do ERP
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#verificação-tardia-sem-leitura-do-erp
      - alert: CasecellshopFaturaTardia
        expr: |
          sum(increase(casecellshop_order_late_invoices_total[1h])) > 0
        for: 0m
        labels:
          severity: page
        annotations:
          summary: O ERP tem uma fatura de pedido falho ou mais de uma fatura para o mesmo pedido
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#fatura-tardia-ou-duplicada
      - alert: CasecellshopErpErroDeConfiguracao
        expr: |
          sum(increase(casecellshop_erp_config_errors_total[5m])) > 0
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
      - alert: CasecellshopVitrineComDadoErrado
        expr: |
          (
            sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome=~"price_changed|out_of_stock"}[30m]))
            / sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome=~"accepted|price_changed|out_of_stock"}[30m]))
          ) > 0.1
          and
          sum(increase(casecellshop_checkout_requests_total{casecellshop_checkout_outcome=~"accepted|price_changed|out_of_stock"}[30m])) >= 20
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: Mais de 10% dos checkouts recusados por preço mudado ou falta de estoque que a vitrine não mostrou
          runbook_url: https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#vitrine-com-dado-errado
```

</details>

### Runbooks

Um runbook por grupo de alertas:

- [API fora do ar](#api-fora-do-ar)
- [Burn rate da vitrine ou do checkout](#burn-rate-da-vitrine-ou-do-checkout)
- [Pendência antiga e burn rate do faturamento](#pendência-antiga-e-burn-rate-do-faturamento)
- [DLQ](#dlq)
- [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração)
- [Furo de estoque](#furo-de-estoque)
- [Sincronização parada](#sincronização-parada)
- [Vitrine com dado errado](#vitrine-com-dado-errado)
- [Vitrine servida velha](#vitrine-servida-velha)

Os comandos rodam com o compose no ar. Para ler o banco: `docker compose exec postgres psql -U casecellshop -d casecellshop`.

#### API fora do ar

Sem a API, a vitrine e o checkout ficam fora; os pedidos já aceitos seguem com o worker, que não depende dela. O `up` em 0 com o contêiner de pé aponta a coleta, e não a API.

1. Confira o contêiner: `docker compose ps api` e `docker compose logs --tail 100 api`. Uma saída na subida (configuração, banco) aparece antes de `casecellshop.api.started`; um encerramento, em `casecellshop.process.shutdown.started`.
2. Com o contêiner de pé, confira a API de dentro dele: `docker compose exec api node -e "fetch('http://127.0.0.1:3000/health').then((r) => console.log(r.status))"`. `503` aponta o banco; siga [Burn rate da vitrine ou do checkout](#burn-rate-da-vitrine-ou-do-checkout), passo 2.
3. Se a API responde e o `up` segue em 0, o problema é a coleta: veja o alvo em Status, Targets, no Prometheus, e a rede entre ele e a API.
4. Contêiner parado: `docker compose up -d api`.

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

O gauge da DLQ conta as mensagens visíveis e as em voo (`OBS-09`): durante uma rodada, a reconciliação deixa invisível cada mensagem que recebe, e a devolve no fim dela (`ORD-14`). A mensagem segue contada nos dois estados, e o alerta continua disparando enquanto ela estiver na DLQ.

Se o alerta veio do counter de falhas de leitura, o gauge da fila está congelado no último valor, e o log `casecellshop.billing.gauge.read_failed` traz o erro do `GetQueueAttributes`. Com o SQS fora do alcance do worker (`docker compose ps elasticmq`), a reconciliação também falha (`casecellshop.outbox.reconciliation.failed`), e as chegadas à DLQ só aparecem em `casecellshop.outbox.dead` na primeira rodada depois da volta. Se só o `GetQueueAttributes` falha (uma permissão faltando, por exemplo), a reconciliação segue registrando cada chegada.

1. Ache os pedidos: o log `casecellshop.outbox.dead` traz o `orderId` de cada chegada à DLQ. Uma mensagem com o corpo fora do schema não gera esse log: ela aparece em `casecellshop.outbox.message.rejected`, com o `orderId` quando o corpo o tem (`ORD-12`).
2. Espere uma rodada da reconciliação (5 min): ela fatura e tira da DLQ os pedidos que o ERP já tem (`ORD-14`). O resumo sai em `casecellshop.outbox.reconciliation.completed`.
3. Para cada pedido que sobrar, consulte o ERP pela referência, que é o `orderId` (H1a). No ERP simulado: `select reference, created_at from erp_sim.invoices where reference = '<orderId>';`.
4. Se a causa já saiu (ERP de volta, configuração corrigida), reprocesse em lote:

   ```sh
   docker compose exec worker node src/main/runbook.ts redrive
   ```

   É seguro mesmo para pedidos que o ERP já tem: cada mensagem respeita o atraso mínimo entre duas chamadas ao ERP do mesmo pedido e consulta o ERP antes de criar (`ORD-07`). Rode-o fora de uma rodada da reconciliação, depois do log `casecellshop.outbox.reconciliation.completed`: no fim da rodada, as mensagens voltam a ficar visíveis (`ORD-14`). A saída diz quantas mensagens saíram da DLQ e quantas restam.

   A documentação da AWS não diz o que o `StartMessageMoveTask` faz com a mensagem em voo durante uma rodada; no compose, o ElasticMQ a tira da DLQ sem entregá-la à fila (risco R12 do [`STATE.md`](.specs/project/STATE.md)). Se o `redrive` cruzou uma rodada, confira os pedidos que chegaram à DLQ e seguem pendentes; um deles que não apareça nos logs do worker (`docker compose logs worker`, pelo `orderId`) ficou fora da fila, e nenhum comando do runbook o publica de novo: confirme no ERP (passo 3); se o ERP não o tem, cancele-o (passo 5) e avise o atendimento.

   ```sql
   select o.id from orders o join outbox x on x.order_id = o.id where o.status = 'pending' and x.dead_at is not null;
   ```

5. Cancele só o pedido que o ERP não tem e que não deve mais ser faturado. O comando confere as duas coisas antes (AD-031):

   ```sh
   docker compose exec worker node src/main/runbook.ts cancel <orderId>
   ```

   - o pedido já tem desfecho: nada muda, sem consultar o ERP, e o comando sai com 0;
   - última criação enviada ao ERP há menos de 15 min (a janela de assentamento), ou outra tentativa chamando o ERP agora: recusa e diz quanto falta, porque uma criação em dúvida ainda pode virar fatura; rode de novo depois. As consultas da reconciliação não reabrem a janela;
   - o ERP tem o pedido: recusa, porque ele já foi faturado; use o `redrive` ou espere a reconciliação;
   - a consulta ao ERP falhou: recusa sem mudar o pedido; rode de novo com o ERP respondendo, depois do atraso mínimo de 45 s entre chamadas;
   - o ERP responde que não tem o pedido: o pedido vira `failed` com o motivo `cancelled` e a reserva é liberada, só se ele ainda estava `pending` (`ORD-15`, `ORD-26`).

   Nas recusas o comando sai com código 1. O `cancel` não toca o SQS: a próxima rodada da reconciliação (até 5 min) encontra o pedido com desfecho e apaga a mensagem da DLQ sem chamar o ERP (`casecellshop.outbox.closed`); depois de um `redrive`, quem a apaga é o worker. Um pedido cancelado depois de um envio sem resposta entra na verificação tardia: se a fatura aparecer no ERP mesmo assim, o alerta [Fatura tardia ou duplicada](#fatura-tardia-ou-duplicada) dispara.
6. Uma mensagem com o corpo fora do schema fica na DLQ: a reconciliação a deixa para o runbook sem consultar o ERP (`ORD-14`), e um `redrive` só a devolve à DLQ, porque o worker a rejeita de novo (`ORD-12`). Se o corpo traz o `orderId`, trate o pedido pelos passos 3 e 5. O runbook ainda não tem um comando que apague uma mensagem da DLQ; até ter, silencie o alerta `CasecellshopDLQ` no Alertmanager com uma expiração curta e, antes de renovar o silêncio, confira no dashboard que `casecellshop_queue_messages{casecellshop_queue_name="dlq"}` ainda é 1, para não esconder uma mensagem que chegue depois.

#### Fatura tardia ou duplicada

A verificação tardia do worker (AD-031) revisita, 15 min depois da última chamada ao ERP, os pedidos com mais de um envio ou com um envio sem resposta seguido de cancelamento. Ela não muda o pedido nem o estoque: cada achado precisa de decisão. Cada achado também quer dizer que o ERP real não cumpre a H4 (conclui ou abandona uma criação em até 40 s) nem a H1b (`ORD-06`, `ORD-23`, `ORD-24`).

1. Ache os pedidos: o log `casecellshop.order.late_invoice.detected` traz o `orderId` e a causa. A marca fica no banco, também depois de o alerta resolver:

   ```sql
   select order_id, late_finding, late_checked_at from outbox where late_finding is not null order by late_checked_at desc;
   ```

2. Confira no ERP as faturas da referência, que é o `orderId` (H1a), e o pedido na loja. No ERP simulado:

   ```sql
   select id, reference, total_cents, created_at from erp_sim.invoices where reference = '<orderId>' order by id;
   select status, failure_reason, outcome_at from orders where id = '<orderId>';
   ```

3. `duplicate` (pedido `invoiced` com mais de uma fatura): mantenha a fatura mais antiga, que é a que a consulta pela referência devolve, e estorne ou cancele as outras no ERP, pelo procedimento financeiro dele, citando o `orderId`. Na loja, o pedido e o estoque já estão certos: a venda foi baixada uma vez. O estorno devolve o estoque no ERP, e a próxima rodada da sincronização o traz para a loja.
4. `failed_order` (pedido `failed` que o ERP faturou): o cliente viu o pedido falhar. Combine com o atendimento:
   - **padrão, desfazer a fatura:** estorne ou cancele a fatura no ERP. O pedido segue `failed`, e a reserva já foi liberada; o estorno devolve o estoque no ERP, e a sincronização o traz;
   - **honrar o pedido** (o cliente confirma a compra): mantenha a fatura e acerte a loja numa transação, na ordem de lock (outbox, pedido, estoque por SKU, um `UPDATE` por linha). O estoque só muda se o pedido mudou:

     ```sql
     begin;
     select order_id from outbox where order_id = '<orderId>' for update;
     update orders set status = 'invoiced', failure_reason = null, outcome_at = now()
       where id = '<orderId>' and status = 'failed' returning id;
     -- só se o UPDATE acima devolveu a linha; um UPDATE por item, em ordem de SKU:
     select sku, quantity from order_items where order_id = '<orderId>' order by sku;
     update inventory set on_hand = greatest(on_hand - <quantity>, 0), sold_total = sold_total + <quantity>
       where sku = '<sku>';
     commit;
     ```

5. Reveja a H4: compare o `created_at` das faturas com o `last_call_at` do pedido na outbox. Se o ERP demora mais que 40 s para concluir uma criação, aumente o atraso mínimo e a visibilidade da mensagem numa decisão nova (`design.md`, "Parâmetros"), antes que o caso se repita.

#### Verificação tardia sem leitura do ERP

A contagem de faturas da verificação tardia lê o banco do ERP (MySQL, acesso de leitura), fora da API (AD-031). Enquanto essa leitura falha, a fatura duplicada não é detectada; os pedidos ficam sem a marca e voltam a cada rodada, então nada se perde quando a leitura volta.

1. Veja o desfecho `transient` no histograma do ERP com a operação `count_invoices` e, no Jaeger, os spans `erp.count_invoices` com erro (`error.type` = `transient`): a camada anticorrupção classifica a falha da leitura e não a repassa ao log.
2. Credencial vencida ou permissão retirada: renove o usuário de leitura do banco do ERP na configuração do worker e reinicie o worker (`docker compose restart worker`).
3. Tabela de faturas mudada numa atualização do ERP: a contagem depende dela (AD-031); ajuste o adaptador da leitura antes de confiar de novo na detecção da fatura duplicada.
4. Quando a leitura volta, a rodada seguinte da verificação tardia confere os pedidos que ficaram para trás.

#### ERP falhando ou com erro de configuração

1. No painel do ERP, veja a operação e o desfecho.
2. `config_error`: o ERP recusou a credencial ou a rota (`400`, `401`, `403`, ou um `404` sem o corpo esperado na consulta; na criação e no catálogo, todo `404`). O log `casecellshop.erp.config.rejected` traz o status. Corrija a configuração do cliente do ERP no worker e reinicie o worker (`docker compose restart worker`). Nenhum pedido falha por isso: a mensagem volta à fila (`ORD-09`, `ORD-10`). No ERP simulado, esse desfecho só sai por falha injetada.
3. `transient` ou `ambiguous`: o ERP está lento ou fora. O worker repete com espera crescente, uma chamada por pedido a cada 45 s. Fale com o time do ERP; não reinicie o worker em laço, porque isso não acelera nada.
4. Se a falha durar mais que a janela de retry (cerca de 23 min em média), os pedidos chegam à DLQ: siga [DLQ](#dlq) quando o ERP voltar.

#### Furo de estoque

O ERP tem menos unidades que a loja prometeu, quase sempre por venda em outro canal.

Se o alerta veio do counter de falhas de leitura, o gauge do estoque está congelado no último valor: o log `casecellshop.checkout.gauge.read_failed` traz o erro, e a leitura é do banco, na API (`curl -i http://localhost:3000/health`). Enquanto ela falha, a consulta do passo 1 é a fonte.

1. Ache os SKUs: `select sku, on_hand, reserved from inventory where reserved > on_hand order by sku;`. Nos logs do worker, o `casecellshop.catalog.sync.sku.corrected` com `on_hand` em `fields` diz em que rodada a sincronização baixou o estoque de cada SKU, e o `casecellshop.catalog.sync.sku.zeroed`, qual SKU sumiu do ERP.
2. Os pedidos pendentes desses SKUs que o ERP recusar por falta de estoque terminam `failed` com o motivo `erp_out_of_stock` e liberam a reserva (`ORD-08`). O log `casecellshop.order.failed` de cada um traz o `orderId`, os `skus` do pedido e o `sku` que o ERP apontou. Avise o atendimento: o cliente recebeu `202` e o pedido não será faturado.
3. Não altere `inventory` à mão: o `on_hand` vem do ERP pela sincronização, e o `reserved` é a soma das reservas dos pedidos pendentes.
4. Confirme com o time do ERP a venda no outro canal ou o ajuste de estoque; se a origem for recorrente, reduza o intervalo da sincronização.

#### Sincronização parada

A idade da sincronização sai da API, lida do banco a cada coleta, e segue crescendo com o worker parado (`CAT-15`). Se o alerta veio do counter de falhas de leitura, o gauge está congelado no último valor: o log `casecellshop.catalog.gauge.read_failed` traz o erro, e a leitura é do banco (`curl -i http://localhost:3000/health`).

1. Confira o worker (`docker compose ps worker`) e as chamadas `list_catalog` no painel do ERP: um desfecho diferente de `ok` aponta o ERP; nenhuma chamada aponta a sincronização.
2. ERP fora: a loja segue com o último preço e estoque conhecidos; o checkout continua, e o preço cobrado é o do banco da loja (`CHK-06`). Siga [ERP falhando ou com erro de configuração](#erp-falhando-ou-com-erro-de-configuração).
3. Worker de pé e sem chamadas: reinicie o worker (`docker compose restart worker`), que faz a carga na subida.
4. Enquanto a sincronização não volta, uma venda em outro canal não aparece na loja: acompanhe o alerta [Furo de estoque](#furo-de-estoque).

#### Vitrine com dado errado

O cliente viu na vitrine um preço ou uma disponibilidade que o checkout recusou. O cliente não é cobrado errado, porque o checkout decide pelo banco da loja (`CHK-06`), mas a recusa é a reclamação que este alerta antecipa.

1. No dashboard, em checkouts por desfecho, veja qual dos dois sobe.
2. `price_changed`: o preço da vitrine estava velho. Confira a idade da entrada servida ([Vitrine servida velha](#vitrine-servida-velha)) e a idade da sincronização ([Sincronização parada](#sincronização-parada)). Com as duas normais, o ERP está mudando preços com frequência: as correções de `price` sobem no painel da sincronização, e o log `casecellshop.checkout.price_changed` traz, em `skus`, os SKUs cujo preço mudou.
3. `out_of_stock`: o log `casecellshop.checkout.rejected` traz o `sku` em que a reserva parou. Confira as correções de `on_hand` na sincronização e o alerta [Furo de estoque](#furo-de-estoque). Uma promoção que esgota um SKU disputado também sobe esse desfecho, sem defeito na loja; nesse caso, feche o ticket.
4. Não altere `products` nem `inventory` à mão: os dois vêm do ERP pela sincronização.

#### Vitrine servida velha

1. A origem do cache é o banco da loja. Veja as cargas da origem por desfecho: `error` crescendo aponta o banco (`curl -i http://localhost:3000/health`, log `casecellshop.health.db.unavailable`).
2. Até 60 s, a vitrine serve a última entrada; depois, responde `503` e o alerta de disponibilidade dispara.
3. O checkout não depende do cache, só do banco: se o banco responde ao checkout e a origem falha, procure o erro da origem no trace de `GET /products`.

### Datadog

O mesmo `/metrics`, sem mudar o código. O Agent do Datadog coleta o endpoint pela integração OpenMetrics, configurada pelo `openmetrics_endpoint`, pelo `namespace` e pela lista `metrics`, de expressões regulares ([integração OpenMetrics](https://docs.datadoghq.com/integrations/openmetrics/), consultado em 02/11/2026).

<details>
<summary>A configuração do Agent e o que muda nos nomes, nos traces e nos logs</summary>

Um exemplo de `conf.d/openmetrics.d/conf.yaml`, com os nomes dos serviços do compose:

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

</details>

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
