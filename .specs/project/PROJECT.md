# CaseCellShop — backend da loja virtual

**Visão:** um serviço entre a loja virtual e o ERP que responde à vitrine e ao checkout **sem colocar o ERP no caminho de cada requisição**, e em que nenhuma reserva passa do estoque conhecido no momento dela.

**Para:** os clientes da loja (vitrine rápida, compra confiável) e o time que opera a integração com o ERP (rastreabilidade por pedido).

**Resolve:** os três problemas atuais da loja. Todos vêm da mesma origem: a loja lê e escreve de forma síncrona num ERP legado que não pode ser alterado.

| Problema | Causa raiz | Resposta deste serviço |
| --- | --- | --- |
| Vitrine lenta | O sistema de registro do ERP está no caminho de leitura de alto volume; a carga nele cresce com o tráfego, e a capacidade dele não | Catálogo, preço e estoque no banco da loja, atualizados por sincronização periódica e servidos por um cache com single-flight |
| Overselling | A disponibilidade é checada e baixada em momentos diferentes (*check-then-act*) | Reserva atômica no banco da loja, que controla a **promessa** de estoque |
| Checkout frágil | O faturamento síncrono prende a resposta ao tempo do ERP; timeouts e retries sem idempotência duplicam pedidos | `202 Accepted`, outbox na mesma transação do pedido, worker com retry, DLQ e reconciliação |

## Metas

Cada meta é provada pelos critérios de [`spec.md`](../features/casecellshop/spec.md).

1. **Nenhum overselling sob concorrência,** com um teste que tem controle negativo (`CHK-01`, `CHK-02`).
2. **A vitrine não depende do ERP e não fica parada no tempo.** Cache com single-flight e *stale-if-error*. Com o ERP respondendo, uma mudança de preço ou de estoque chega à vitrine em até 65,5 s mais a duração de uma rodada de sincronização. Quando o cliente informa o preço que viu, ele é o cobrado (`CAT-*`, `CHK-06`).
3. **O checkout não espera o ERP:** `202` com `Location` e `Retry-After`, e o pedido acompanhado em `GET /orders/{orderId}/status` (`CHK-*`).
4. **Nenhum pedido fantasma, nenhuma mensagem fantasma e nenhuma fatura duplicada, nas condições das hipóteses.** Outbox na mesma transação, consulta pela referência antes de criar, DLQ, reconciliação e reprocessamento em lote. O limite sem a H1b está no R6 (`ORD-*`).
5. **Todo pedido é rastreável:** um `orderId` leva aos logs e a um trace da requisição ao ERP (`OBS-05`).
6. **Executa do zero:** num clone limpo, com Docker e Node a partir da 24.12, `docker compose up` sobe o sistema e `npm test` passa; o CI roda lint, tipos e testes (`FND-*`).

## Stack

Versões conferidas em 28 e 29/10/2026. As escolhas e as alternativas estão em [`STATE.md`](STATE.md).

- **Runtime:** Node.js 26.13.0 LTS (a partir da 24.12), ESM, TypeScript por *type stripping*; TypeScript 7.0.2 só para checar tipos, e o oxlint para o lint
- **HTTP:** Express 5.3.0, com o contrato em zod 4.6.7 e o OpenAPI 3.1 gerado pelo `@asteasolutions/zod-to-openapi` 9.1.0
- **Banco e fila:** PostgreSQL 18.6 com `pg` 8.23.1; a outbox é a fila
- **Observabilidade:** `pino` 10.4.0 e OpenTelemetry JS na linha 3 (API 1.10.0, SDK 3.0.0)
- **Testes:** Vitest 5.0.5, supertest 7.3.1 e Testcontainers 12.2.1

## Escopo

**Entra:**

- **API:** `GET /products`, `POST /checkout` (com `Idempotency-Key` e, opcionalmente, o preço exibido), `GET /orders/{orderId}/status` e `/health`, cada rota no contrato antes do código.
- **Banco da loja:** catálogo, preço e estoque sincronizados do ERP, reserva atômica e outbox.
- **Worker** (uma réplica): envio ao ERP com retry e DLQ, reconciliação e sincronização.
- **ERP simulado:** módulo atrás da porta `ErpClient`, com estado próprio, falhas configuráveis e as hipóteses abaixo.
- **Observabilidade:** logs estruturados, métricas em `/metrics` e traces que atravessam a outbox.
- **Documentação:** README (como rodar, garantias, decisões, limitações e operação), `ARCHITECTURE.md` (diagnóstico, arquitetura alvo e o porquê de cada bloco) e `PROMPTS.md` (onde estão os prompts que governam os agentes).
- **Testes** de regras, concorrência, idempotência, cache, sincronização, contrato e falhas do ERP; os de falha contam faturas, não chamadas.

**Fora, com o motivo:**

| Fora do escopo | Motivo |
| --- | --- |
| Autenticação, autorização e limite de taxa | Sem identificar clientes, qualquer um cria pedidos e a chave de idempotência tem escopo global (AD-006). Em produção: OAuth2/OIDC na borda e limite por cliente |
| Pagamento | O pedido vai direto para o faturamento; um pagamento seria mais um passo assíncrono antes do ERP |
| Front-end e deploy | O contrato HTTP é a interface; a implantação fica na arquitetura alvo |
| CDN e cache HTTP | Uma camada fora do serviço serviria dado defasado sem aparecer nas métricas; a vitrine responde `no-store` (AD-005) |
| Redrive automático e várias réplicas do worker | O reprocessamento em lote basta para uma DLQ restrita a quedas longas; a fila já tolera várias réplicas (`SKIP LOCKED` e token), mas a coordenação entre elas fica na arquitetura alvo (AD-003, AD-009) |
| ERP real | Substituído por um simulador atrás da porta `ErpClient` (AD-004) |
| Leitura direta do MySQL do ERP | As tabelas internas do ERP não são contrato; a loja usa a API. Exceção: o plano B da H1a (R6). CDC fica na arquitetura alvo (AD-009) |
| Redis, SQS, EventBridge reais | Arquitetura alvo; aqui o PostgreSQL resolve banco e fila numa transação (AD-003), e o cache em memória basta para uma instância (AD-005) |

## Restrições

- **Execução:** só Docker e Node, sem conta paga nem credencial externa.
- **O ERP não pode ser alterado.** O fake expõe só o que uma API REST de ERP expõe: consulta de produtos, preços e estoque; criação de pedido para faturamento; consulta de pedido pela referência da loja.

## Hipóteses

**Sobre o ERP:**

- **H1a.** A API aceita o `orderId` da loja como referência externa e permite consultar um pedido por ela.
- **H1b.** O ERP recusa uma segunda criação com a mesma referência e devolve o pedido existente (deduplicação).
- **H2.** O ERP recusa faturar sem estoque e informa o motivo. Se aceitar e ficar negativo, a sincronização grava zero, registra o caso em log e a loja para de vender o SKU.
- **H3.** O ERP fatura pelo preço unitário enviado no pedido, que é o preço aceito pela loja. Se não aceitar, honrar o preço da loja ou cancelar passa a ser regra de negócio.
- **H4.** O ERP conclui ou abandona uma criação em até 40 s depois de recebê-la. Por isso a consulta antes de uma nova criação só acontece 45 s depois do início da chamada anterior.
- **O desenho não depende só da H1b:** depois do primeiro envio, o worker consulta pela referência (H1a) antes de criar. A H1b cobre o caso em que a consulta responde "não existe" com a primeira chamada ainda em processamento, que é quando a H4 falha.

**Premissas de carga**, de onde saem os parâmetros do design e que serão revistas com medição:

- pico de ~7 pedidos/s;
- chamada de faturamento com mediana de ~3 s e p99,9 de 8 s;
- o ERP aguenta até ~30 chamadas simultâneas vindas da loja;
- catálogo de alguns milhares de SKUs.
