# Roadmap

**Marco atual:** M1 — Fundação

Os critérios de aceite estão em [`spec.md`](../features/casecellshop/spec.md); o "como" de cada parte, em [`design.md`](../features/casecellshop/design.md).

## Como cada marco é feito

A sessão principal do Claude Code orquestra o marco: escreve as specs, o contrato e a documentação, faz os commits e abre o PR. Ela roda em Opus com esforço `high`, fixos em `.claude/settings.json`; só muda a pedido explícito do mantenedor. Quatro agentes, em `.claude/agents/`, fazem o resto, um de cada vez, cada um num ponto em que um olhar separado reduz um viés:

1. O `planner` (Opus, esforço alto, só leitura) confere a spec contra o código já feito e propõe o plano do marco, com os desvios encontrados. A pessoa responsável aprova, e a sessão principal atualiza a spec.
2. A seção do `ARCHITECTURE.md` é escrita em rascunho, os critérios entram no `spec.md` e as rotas no contrato (`src/contract/`, que gera o `openapi.yaml`); com esse commit, abre-se o PR em rascunho, com o plano como checklist na descrição.
3. O `test-writer` (Sonnet, esforço alto) escreve os testes que falham a partir dos critérios e do contrato, sem ler a implementação (commit `test:`).
4. O `implementer` (Sonnet, esforço médio) escreve o código até os testes e o CI passarem, sem poder alterar os testes (commit `feat:`).
5. O `reviewer` (Opus, esforço alto, só leitura) revisa o PR contra a spec, as ADRs e as convenções, apontando só o que afeta a corretude, com um checklist de segurança. O parecer vai como comentário no PR.
6. A pessoa responsável faz o merge, sem squash, para o histórico mostrar o teste antes do código.

**Escalonamento**, só no `implementer` e contado por problema (um achado do `reviewer`, ou um check do CI vermelho pela mesma causa): a primeira correção roda em Sonnet com esforço alto; se o mesmo problema voltar, em Opus com esforço alto, até resolver. Cada degrau é uma chamada nova, com o modelo e o esforço passados na chamada, e o esforço `max` não é usado. O `/security-review` nativo roda no PR do M2 e antes da entrega. Os agentes têm nome e instruções em inglês e produzem em português, conforme as [convenções](../codebase/CONVENTIONS.md). Cada marco traz seus logs, métricas e spans, e as decisões e o uso de IA são registrados no mesmo PR, no `STATE.md` e no `PROMPTS.md`.

## Dos requisitos aos marcos

| Requisito | Marco | Comprovado por |
| --- | --- | --- |
| `POST /checkout` → `202` com `orderId` e `status` | M2 | `CHK-*` |
| `GET /orders/{orderId}/status` | M2 | `CHK-*` |
| Sem venda além do estoque | M2 | `CHK-01`, `CHK-02` (controle negativo) |
| Idempotência para retry e duplo clique | M2 | `CHK-*` |
| Worker simulando o envio ao ERP; retry, DLQ e reconciliação | M3 | `ORD-*` |
| `GET /products` com cache e TTL | M4 | `CAT-*` |
| Vitrine sem preço ou disponibilidade defasados além do limite da meta 2; preço informado igual ao cobrado | M2, M4 | `CHK-06`, `CAT-06` |
| OpenAPI com schemas de sucesso e erro | M1 a M4 | validação de requisição e resposta em todos os testes; `FND-07` |
| Logs com `correlationId` e `orderId`; métricas de cache, checkout e fila; trace ligando requisição, cache, repositório e worker | M1 a M5 | `OBS-*`, `FND-05`, `CAT-12`, `ORD-18` |
| Dashboard, alertas e runbook | M5 | README e `OBS-03` |
| Garantias do sistema; modos de falha com mitigação e instrumentação | M5, M6 | README, cada linha ligada a um teste |
| Testes de regra de negócio, cache e concorrência | M2 a M4 | todos os critérios |
| Design conceitual por tema | M1 a M6 | `ARCHITECTURE.md` e `DOC-*` |
| README, `PROMPTS.md`, repositório público e executável | M6 | clone limpo pela URL pública, sem credenciais |

---

## M0 — Planejamento · CONCLUÍDO

Visão, escopo, ordem de execução, decisões, critérios e design registrados antes de qualquer código. As ADRs passaram a "aceita" ao fechar o marco.

**Pronto quando:** cada requisito está ligado a um marco e cada decisão tem as alternativas registradas.

## M1 — Fundação

**Meta:** o esqueleto roda, testa e passa no CI antes de existir regra de negócio.

- **Primeiro PR, só o fluxo de trabalho:** `AGENTS.md` (instruções em inglês, apontando para as convenções), o `CLAUDE.md` que o importa, os quatro agentes, `.claude/settings.json` com `opusplan`, as guardas de papel e as regras de aprovação, e o template de PR ("o que a IA gerou / o que foi mudado / como foi verificado").
- Design de diagnóstico em rascunho (`DOC-DIA`).
- Spike de ferramental (R8): Express com um schema zod que valida a requisição e gera o OpenAPI 3.1, PostgreSQL no Testcontainers, um span filho e uma métrica.
- `package.json` com versões exatas e `engines`, `.nvmrc`, `tsconfig` e lint.
- Compose com PostgreSQL (com healthcheck), serviço de migração, API e worker, estes só depois das migrações (`depends_on` com `service_completed_successfully`); `node` como comando de cada contêiner; `stop_grace_period: 30s` e `restart: unless-stopped` na API e no worker.
- Migrações da loja e do `erp_sim`, e os dados iniciais do ERP simulado num *seed* que só o compose roda; até o M4, cada teste cria os dados que usa.
- CI: `npm ci` → lint → `tsc --noEmit` → testes → `openapi.yaml` em dia → limite de tamanho das specs e das instruções da IA, no Node do `.nvmrc` e na 24.12.
- Contrato base (schema de erro RFC 9457 e resposta `default`), telemetria, `/health`, encerramento gracioso e o ERP simulado.
- README inicial: pré-requisitos (Docker e Node a partir da 24.12), um comando para subir e outro para testar, a tabela requisito → arquivo → teste e um `requests.http`.

**Pronto quando:** `FND-*` passam.

## M2 — Checkout

**Meta:** comprar sem overselling, sem pedido duplicado, pelo preço informado e sem esperar o ERP.

- Design de concorrência e idempotência (`DOC-CON`).
- Transação do checkout, respostas, status do pedido e contrato das duas rotas, conforme o design.
- `/security-review` no PR, porque é o marco que recebe dados do cliente.

**Pronto quando:** `CHK-*` passam.

## M3 — Processamento assíncrono

**Meta:** todo pedido aceito é processado pelo menos uma vez e termina faturado, falho ou na DLQ, de onde a reconciliação e o reprocessamento em lote o tiram; ele é faturado no máximo uma vez, com o limite do R6.

- Design de mensageria e resiliência (`DOC-MSG`).
- Worker (envio, desfechos, reconciliação e runbook) e camada anticorrupção, conforme o design.

**Pronto quando:** `ORD-*` passam, contando faturas no ERP com falhas injetadas pelo ERP simulado.

## M4 — Vitrine e frescor

**Meta:** `GET /products` rápido e independente do ERP; com o ERP respondendo, defasagem de até 65,5 s mais a duração de uma rodada.

- Design de cache e performance da vitrine (`DOC-CAC`).
- Catálogo com cache e sincronização, conforme o design.

**Pronto quando:** `CAT-*` passam, com relógio controlado.

## M5 — Observabilidade e operação

**Meta:** detectar degradação e furo de estoque antes da reclamação do cliente.

- Design de observabilidade (`DOC-OBS`) e as métricas que completam o conjunto do design.
- Operação no README, em PromQL, com os nomes de `/metrics`:
  - SLIs e SLOs do design e um dashboard de exemplo;
  - alertas: SLO com burn rate; DLQ e idade da fila; promessa acima do estoque e rejeição por falta de estoque; erro de configuração no ERP; sincronização parada;
  - um runbook por alerta: DLQ (reprocessar em lote, ou cancelar depois de consultar o ERP), ERP fora ou com erro de configuração, furo de estoque e sincronização parada;
  - tabela de modos de falha (falha → detecção → mitigação → teste), cobrindo pelo menos: ERP lento, fora e fora além da janela de retry; fatura sem resposta e depois do timeout; worker que morre e mensagem que derruba o processo; banco indisponível e SKU disputado; origem do cache em erro; sincronização parada; venda em outro canal; preço alterado entre a vitrine e o checkout.

**Pronto quando:** `OBS-*` passam e o README traz a operação completa.

## M6 — Documentação e entrega

**Meta:** quem chega ao repositório entende, executa e confere tudo sem precisar perguntar.

- Design de diagnóstico e arquitetura alvo, versão final (`DOC-DIA`), e a revisão do `ARCHITECTURE.md` pelos critérios `DOC-*` e contra o código.
- README de entrada: pré-requisitos e comandos; mapa requisito → arquivo → teste; garantias, cada uma com a hipótese de que depende e o teste que a prova; decisões em uma linha, com link para as ADRs; simplificações, limitações, hipóteses e premissas; "Como a IA foi usada", com os prompts principais e o link para o `PROMPTS.md`.
- `PROMPTS.md`, alimentado em cada marco, revisado para manter só conteúdo técnico.
- `/security-review` final.
- Verificação: repositório público; clone limpo pela URL pública, sem credenciais; compose, testes e CI verde.

**Pronto quando:** cada requisito da tabela acima está comprovado num clone limpo.

---

## Ordem de corte

Se for preciso reduzir, os cortes vêm nesta ordem, sem tirar nenhum requisito da tabela acima. O que for cortado sai também das metas e vira limitação documentada no README.

1. O zeramento de SKU ausente do ERP.
2. O `expectedUnitPrice` e o `409 price-changed`.
3. As métricas que não alimentam alerta nem SLO, exceto `hit`, `miss`, o desfecho do checkout e as de frescor do cache.
4. A operação no README fica com um dashboard, os alertas e o runbook de DLQ.
5. A tabela de modos de falha fica só com as linhas que têm teste.
6. As fases de 30 e 90 dias viram um parágrafo.

## Adicionais

Fora do escopo principal. Entram só depois que M1 a M6 estiverem completos, nesta ordem:

1. Seção curta "segurança e limites" no README: sem autenticação, abuso possível, limites do contrato, preço lido do banco e o que muda em produção.
2. Estimativa de capacidade no design de diagnóstico, a partir das premissas de carga.
3. Plano de rollout por fase, com critério de saída e rollback.
4. `/livez` e `/readyz` separados.
5. Diagrama de sequência (Mermaid) do checkout ao faturamento.

## Arquitetura alvo

Descrita no `ARCHITECTURE.md`, fora deste escopo:

- cache L2 compartilhado, CDN e cabeçalhos de cache HTTP;
- fila gerenciada (SQS com DLQ e redrive policy) alimentada pela outbox;
- várias réplicas do worker, com a sincronização coordenada e o limite de chamadas e os pools divididos entre elas;
- sincronização incremental e captura de mudanças (CDC) a partir de uma réplica do MySQL do ERP, se a replicação puder ser habilitada;
- eventos de domínio;
- autenticação e autorização na borda.
