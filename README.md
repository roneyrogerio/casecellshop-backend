# CaseCellShop backend

[![CI](https://github.com/roneyrogerio/casecellshop-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/roneyrogerio/casecellshop-backend/actions/workflows/ci.yml)

Serviço entre a loja virtual da CaseCellShop e um ERP legado que não pode ser alterado: serve o catálogo do banco da loja, reserva o estoque de forma atômica no checkout e envia os pedidos ao ERP de forma assíncrona, por uma outbox e uma fila SQS. Node.js 26, TypeScript, PostgreSQL e OpenTelemetry. O ERP é simulado no processo do worker, atrás da porta `ErpClient`.

**Estado:** checkout, faturamento assíncrono, retry, DLQ e reconciliação prontos (marcos M1 a M3). Vitrine com cache (M4), observabilidade completa (M5) e entrega final (M6) estão pendentes; cada item abaixo diz se está pronto ou em qual marco entra. O andamento está no [`ROADMAP.md`](.specs/project/ROADMAP.md).

## Índice

- [Rodar](#rodar)
- [Testar](#testar)
- [O que o desafio pede e onde está](#o-que-o-desafio-pede-e-onde-está)
- [As cinco perguntas](#as-cinco-perguntas)
- [Decisões e trade-offs](#decisões-e-trade-offs)
- [Garantias e modos de falha](#garantias-e-modos-de-falha)
- [Operação](#operação)
- [Limitações e simplificações](#limitações-e-simplificações)
- [Como a IA foi usada](#como-a-ia-foi-usada)
- [Documentação](#documentação)
- [Contribuir](#contribuir)
- [Licença](#licença)

## Rodar

Pré-requisito: Docker com o Compose v2.20.2 ou mais novo. O `docker compose up` não depende do Node da máquina.

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

**Catálogo até o M4:** o catálogo da loja é preenchido pela sincronização com o ERP, que entra no M4. Até lá, copie o catálogo do ERP simulado uma vez, com o compose no ar:

```sh
docker compose exec postgres psql -U casecellshop -d casecellshop -c "
  insert into products (sku, name, price_cents) select sku, name, price_cents from erp_sim.products on conflict do nothing;
  insert into inventory (sku, on_hand) select sku, on_hand from erp_sim.products on conflict do nothing;"
```

Um pedido de ponta a ponta:

```sh
curl -i -X POST http://localhost:3000/checkout \
  -H 'content-type: application/json' -H 'idempotency-key: pedido-1' \
  -d '{"items":[{"sku":"CAPA-MOTO-G84","quantity":1,"expectedUnitPrice":4990}]}'
# 202 Accepted, com Location: /orders/<orderId>/status

curl http://localhost:3000/orders/<orderId>/status
# {"orderId":"…","status":"invoiced"} depois de o worker faturar
```

O contrato completo está no [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), e o [`requests.http`](requests.http) tem as requisições de exemplo. Ao importar o `openapi.yaml` no Insomnia ou no Postman, defina a URL base `http://localhost:3000`: o contrato declara o servidor como `/`, o que muda no M4.

## Testar

Pré-requisitos: Node.js a partir da 24.12 (a versão de referência está no [`.nvmrc`](.nvmrc)) e Docker.

```sh
npm ci
npm test            # tudo: unitários e integração com PostgreSQL, SQS e compose reais
npm run test:unit   # só os unitários, sem Docker
```

Os testes de integração rodam contra PostgreSQL e ElasticMQ reais, pelo Testcontainers, porque as garantias dependem do comportamento do banco e da fila (lock, transação, índice único, visibilidade de mensagem), que um mock não reproduz. Cada teste começa pelo ID do critério que prova (`CHK-01 …`), e o CI publica a tabela critério × teste a cada execução.

## O que o desafio pede e onde está

| O desafio pede | Onde | Prova | Estado |
| --- | --- | --- | --- |
| `GET /products` com cache e TTL | `src/catalog/` (a criar no M4), cache em memória (AD-005) | critérios `CAT-*` | M4 |
| `POST /checkout` responde `202` com `orderId` e status | [`src/checkout/`](src/checkout/) | `CHK-09` | pronto |
| `GET /orders/{orderId}/status` | [`src/orders/`](src/orders/) | `CHK-11`, `ORD-19` | pronto |
| Contrato com schemas de sucesso e erro | [`openapi.yaml`](openapi.yaml), gerado de [`src/contract/`](src/contract/); erros em `application/problem+json` (RFC 9457) | `FND-03`, `FND-07` | pronto |
| Logs estruturados com `correlationId` e `orderId` | [`src/shared/logging.ts`](src/shared/logging.ts) | `OBS-01` | pronto; campos completos no M5 |
| Métricas de cache, checkout e fila | `/metrics` da API e do worker | `OBS-02`; cache no M4 | parcial |
| Trace ligando requisição, cache, repositório e worker | [`src/shared/telemetry.ts`](src/shared/telemetry.ts), Jaeger | `FND-05`, `CHK-12`, `ORD-18`; cache: `CAT-12` | pronto, menos o cache (M4); spans do ERP no M5 |
| Exemplo de dashboard, alerta ou runbook | [Operação](#operação) | runbook: `ORD-15`; dashboard e alertas: `OBS-03` | runbook pronto; dashboard e alertas no M5 |
| Checkout sem venda além do estoque | reserva atômica no PostgreSQL (AD-002) | `CHK-01`, `CHK-02` (controle negativo) | pronto |
| Idempotência para retry e duplo clique | `Idempotency-Key` gravada na transação do pedido (AD-006) | `CHK-03` a `CHK-05` | pronto |
| Worker simulando o envio ao ERP | [`src/billing/`](src/billing/), ERP simulado em [`src/erp/sim/`](src/erp/sim/) | `ORD-01` a `ORD-22` | pronto |
| Testes de regra de negócio, cache e concorrência | [`test/`](test/) e unitários ao lado do código | tabela critério × teste do CI | cache no M4 |
| Decisões, trade-offs, limitações e prompts de IA | este README, [`PROMPTS.md`](PROMPTS.md) | revisão | pronto |

## As cinco perguntas

As respostas da Parte 1.A estão no [`ARCHITECTURE.md`](ARCHITECTURE.md), cada uma com os critérios `DOC-*` que a conferem.

| Pergunta | Seção do `ARCHITECTURE.md` | Critérios | Estado |
| --- | --- | --- | --- |
| 1. Diagnóstico, trade-offs e arquitetura alvo | "Diagnóstico e arquitetura alvo" | `DOC-DIA-01` a `06` | pronto |
| 2. Cache, invalidação e vitrine | "Cache e performance da vitrine" | `DOC-CAC-01` a `04` | M4 |
| 3. Observabilidade | "Observabilidade" | `DOC-OBS-01` a `04` | M5 |
| 4. Concorrência, estoque e idempotência | "Concorrência e idempotência" | `DOC-CON-01` a `04` | pronto |
| 5. Mensageria, resiliência, contrato e IA | "Mensageria e resiliência" | `DOC-MSG-01` a `04` | pronto |

## Decisões e trade-offs

Cada decisão tem contexto, alternativas e o que se aceitou em troca no [`STATE.md`](.specs/project/STATE.md).

| Decisão | O que se ganha | O que se aceita |
| --- | --- | --- |
| Banco próprio da loja em PostgreSQL (AD-001) | a vitrine e o checkout não dependem do ERP a cada acesso | sincronizar preço e estoque com o ERP |
| Estoque como promessa: `reserved` da loja separado de `on_hand` do ERP (AD-002) | nenhuma venda além do estoque, com um `UPDATE` condicional | a reserva precisa ser liberada em toda falha |
| Idempotência pela `Idempotency-Key`, na mesma transação do pedido (AD-006, AD-020) | retry e duplo clique devolvem o mesmo pedido | guardar as chaves e o hash do corpo |
| Outbox na transação do pedido e SQS como fila (AD-003, AD-021) | nem pedido sem mensagem, nem mensagem sem pedido | entrega pelo menos uma vez, então o consumidor é idempotente |
| Uma chamada ao ERP por pedido a cada atraso mínimo (AD-024) | sem fatura duplicada nas hipóteses do ERP | um pedido não chama o ERP mais de uma vez a cada 45 s |
| ERP simulado atrás de uma camada anticorrupção (AD-004) | as falhas do ERP são injetadas e testadas; o real entra no lugar sem mudar a regra | o simulado segue hipóteses que o real precisa confirmar |
| Cache em memória na vitrine (AD-005) | latência baixa sem servidor a mais | cada instância tem o seu cache (M4) |
| Contrato em zod, com o OpenAPI gerado (AD-010) | código, validação e documentação da API nunca divergem | o OpenAPI não se edita à mão |

## Garantias e modos de falha

As garantias dependem de hipóteses sobre o ERP, que é legado e não pode mudar:

- **H1a:** a API aceita o `orderId` da loja como referência e permite consultar um pedido por ela.
- **H1b:** o ERP recusa uma segunda criação com a mesma referência.
- **H2:** o ERP recusa faturar sem estoque e diz o motivo.
- **H3:** o ERP fatura pelo preço enviado.
- **H4:** o ERP conclui ou abandona uma criação em até 40 s.

| Garantia | Depende de | Teste |
| --- | --- | --- |
| Nenhuma venda além do estoque, com 50 checkouts simultâneos | o banco da loja | `CHK-01`, `CHK-02` |
| Um pedido por chave, mesmo com envios em paralelo | o banco da loja | `CHK-03` |
| Uma fatura por pedido com mensagem duplicada, worker morto no meio ou ERP lento | H1a e H4; a H1b é uma segunda proteção | `ORD-01` a `ORD-05` |
| Estoque baixado uma vez só, mesmo com conclusões simultâneas | o banco da loja | `ORD-17` |
| Reserva liberada quando o ERP recusa o pedido | H2 | `ORD-08` |

| Falha | Detecção | Mitigação | Teste |
| --- | --- | --- | --- |
| ERP lento ou fora do ar | timeout na camada anticorrupção | retry com espera crescente e DLQ depois de 12 recebimentos | `ORD-13`, `ORD-21` |
| ERP volta depois de um tempo fora | reconciliação a cada 5 min | fatura os pedidos que o ERP já tem e tira a mensagem da DLQ | `ORD-14` |
| Worker morre no meio da chamada | a mensagem volta a ficar visível no SQS | nova tentativa só depois do atraso mínimo, consultando antes de criar | `ORD-02` |
| Mensagem que derruba o processo ou fora do schema | contagem de recebimentos do SQS | vai sozinha para a DLQ; as outras seguem | `ORD-12` |
| Banco falha ao gravar o desfecho | erro na transação de conclusão | até 5 repetições; a mensagem continua na fila | `ORD-16` |
| ERP acima do limite da H4 e sem a H1b | não detectável pela loja | duas faturas para o pedido, ou o pedido falho com uma fatura que aparece depois; demonstrado no teste e registrado como risco (R6) | `ORD-06` |

## Operação

- **Logs:** JSON em uma linha, com `correlationId`, `orderId`, `trace_id` e o nome do evento (`docker compose logs api worker`).
- **Métricas:** no formato Prometheus, em `http://localhost:3000/metrics` para a API; as do worker ficam na porta 9464 dentro da rede do compose (`docker compose exec worker node -e "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then(console.log)"`). Incluem checkout por resultado, tentativas de faturamento por desfecho, mensagens publicadas, chamadas ao ERP por operação e resultado, e o tempo do aceite ao faturamento.
- **Traces:** no Jaeger, o trace sai da requisição de checkout e continua na tentativa do worker, pelo `traceparent` da mensagem.
- **Runbook da DLQ:** `docker compose exec worker node src/main/runbook.ts redrive` devolve as mensagens da DLQ à fila; `docker compose exec worker node src/main/runbook.ts cancel <orderId>`, só depois de confirmar no ERP que o pedido não existe, marca o pedido pendente como `failed` (`cancelled`) e libera a reserva. Se o ERP tem o pedido, use o `redrive` ou espere a reconciliação, que o fatura (`ORD-14`, `ORD-15`).
- **Dashboard e alertas:** M5, com as consultas PromQL, os limites de cada alerta e o runbook de cada um, conferidos contra o `/metrics` real (`OBS-03`).

## Limitações e simplificações

- **ERP simulado:** roda no processo do worker e segue as hipóteses H1a a H4. Um ERP real precisa confirmá-las; sem a H1b e acima do limite da H4, um pedido pode terminar com duas faturas, ou falho com uma fatura que aparece depois, sem que a loja detecte (`ORD-06`, risco R6).
- **Sem autenticação nem pagamento:** fora do escopo do desafio.
- **Catálogo:** a sincronização com o ERP e a vitrine com cache entram no M4; até lá, o catálogo é copiado à mão (ver [Rodar](#rodar)).
- **Uma instância de cada serviço no compose:** o desenho admite várias (fila, outbox e locks no banco), mas o compose sobe uma de cada.
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

Exemplos de erros da IA que o fluxo pegou antes do merge, com o relatório de revisão de cada um, estão no `ARCHITECTURE.md`, seção "Prompts de IA relevantes". Os prompts que governam os agentes e o motivo de não haver um diário de prompts estão no [`PROMPTS.md`](PROMPTS.md).

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md) (explicação): as respostas às cinco perguntas, o diagnóstico e a arquitetura alvo.
- [`openapi.yaml`](openapi.yaml) (referência): o contrato HTTP.
- [`.specs/`](.specs/README.md) (referência): critérios de aceite, design, decisões e marcos.
- [`PROMPTS.md`](PROMPTS.md) e [`AGENTS.md`](AGENTS.md): as instruções dos agentes.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) (como fazer): preparar a máquina, as checagens e o fluxo de PR.

## Contribuir

O passo a passo para preparar a máquina, rodar as checagens e abrir um PR está no [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licença

[MIT](LICENSE).
