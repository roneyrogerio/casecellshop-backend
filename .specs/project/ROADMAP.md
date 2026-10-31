# Roadmap

**Marco atual:** M3 — Processamento assíncrono

Os critérios de aceite estão em [`spec.md`](../features/casecellshop/spec.md); o "como" de cada parte, em [`design.md`](../features/casecellshop/design.md).

## Como cada marco é feito

Pela skill `/marco` (`.claude/skills/marco/SKILL.md`), na arquitetura da AD-012:
1. A sessão principal planeja, e o mantenedor aprova o plano.
2. O `test-writer` escreve os testes antes.
3. O `implementer` escreve o código.
4. O `reviewer` revisa cada fatia.
5. O mantenedor aprova o PR, e o GitHub faz o merge com o ruleset satisfeito (AD-013).

Uma mudança de processo vai num PR próprio, com teto de tempo, antes do marco que ela afeta.

## Dos requisitos aos marcos

| Requisito | Marco | Comprovado por |
| --- | --- | --- |
| `POST /checkout` → `202` com `orderId` e `status` | M2 | `CHK-*` |
| `GET /orders/{orderId}/status` | M2, M3 | `CHK-*`, `ORD-19` |
| Sem venda além do estoque | M2 | `CHK-01`, `CHK-02` (controle negativo) |
| Idempotência para retry e duplo clique | M2 | `CHK-*` |
| Worker simulando o envio ao ERP; retry, DLQ e reconciliação | M3 | `ORD-*` |
| `GET /products` com cache e TTL | M4 | `CAT-*` |
| Vitrine sem preço ou disponibilidade defasados além do limite da meta 2; preço informado igual ao cobrado | M2, M4 | `CHK-06`, `CAT-06` |
| OpenAPI com schemas de sucesso e erro | M1 a M4 | validação de requisição e resposta em todos os testes; `FND-07` |
| Logs com `correlationId` e `orderId`; métricas de cache, checkout e fila; trace ligando requisição, cache, repositório e worker | M1 a M5 | `OBS-*`, `FND-05`, `CAT-12`, `ORD-18` |
| Dashboard, alertas e runbook | M5 | README e `OBS-03` |
| Garantias do sistema; modos de falha com mitigação e instrumentação | M5, M6 | `DOC-OPS-01`: README, cada linha ligada a um teste |
| Testes de regra de negócio, cache e concorrência | M2 a M4 | todos os critérios |
| Design conceitual por tema | M1 a M6 | `ARCHITECTURE.md` e `DOC-*` |
| README, `PROMPTS.md`, repositório público e executável | M6 | clone limpo pela URL pública, sem credenciais |
| Respostas às cinco perguntas (Parte 1.A), com o link do repositório público no fim | M6 | `DOC-ENT-01` |

---

## M0 — Planejamento · CONCLUÍDO

Visão, escopo, ordem de execução, decisões, critérios e design registrados antes de qualquer código. As ADRs passaram a "aceita" ao fechar o marco.

**Pronto quando:** cada requisito está ligado a um marco e cada decisão tem as alternativas registradas.

## M1 — Fundação · CONCLUÍDO

**Meta:** o esqueleto roda, testa e passa no CI antes de existir regra de negócio.

- **Primeiro PR, só o fluxo de trabalho:** `AGENTS.md` (instruções em inglês, apontando para as convenções), o `CLAUDE.md` que o importa, os quatro agentes, `.claude/settings.json` com o modelo da sessão principal, as guardas de papel e as regras de aprovação, e o template de PR ("o que a IA gerou / o que foi mudado / como foi verificado").
- Design de diagnóstico em rascunho (`DOC-DIA`).
- Spike de ferramental (R8): Express com um schema zod que valida a requisição e gera o OpenAPI 3.1, PostgreSQL no Testcontainers, um span filho e uma métrica.
- `package.json` com versões exatas e `engines`, `.nvmrc`, `tsconfig` e lint.
- Compose com PostgreSQL (com healthcheck), serviço de migração, API e worker, estes só depois das migrações (`depends_on` com `service_completed_successfully`); `node` como comando de cada contêiner; `stop_grace_period: 30s` e `restart: unless-stopped` na API e no worker.
- Migrações da loja e do `erp_sim`, e os dados iniciais do ERP simulado num *seed* que só o compose roda; até o M4, cada teste cria os dados que usa.
- CI: `npm ci` → lint → `tsc --noEmit` → testes → `openapi.yaml` em dia → limite de tamanho das instruções da IA (o das specs saiu com a AD-012), no Node do `.nvmrc` e na 24.12.
- Contrato base (schema de erro RFC 9457 e resposta `default`), telemetria, `/health`, encerramento gracioso e o ERP simulado.
- README inicial: pré-requisitos (Docker e Node a partir da 24.12), um comando para subir e outro para testar, a tabela requisito → arquivo → teste e um `requests.http`.

**Pronto quando:** `FND-*` passam.

## F1 — Fábrica v2 · CONCLUÍDO

**Meta:** o fluxo de IA passa a se verificar sozinho e a deixar o humano só onde ele decide, antes do M2, em PRs de processo com teto de tempo (AD-012 a AD-016). Entrou pelos PRs #4, #5 e o de fechamento.

**Pronto quando:**
- os critérios `AI-01` a `AI-18` estão verdes, cada trilho com um controle negativo;
- o CI está verde;
- o ruleset protege a `main`;
- o PR registra o tempo gasto.

## M2 — Checkout · CONCLUÍDO

**Meta:** comprar sem overselling, sem pedido duplicado, pelo preço informado e sem esperar o ERP. Entrou pelos PRs #11 (camada de dados) e #12 (checkout e status do pedido).

- Design de concorrência e idempotência (`DOC-CON`).
- Primeira fatia, antes do checkout: a camada de dados da AD-017 (Kysely, tipos gerados e conferidos no CI, conferência das formas proibidas e guarda da transação), migrando o `/health`, o ERP simulado e o seed; as migrações passam ao `Migrator` do Kysely, com a do `erp_sim` reescrita em TypeScript, a conferência do `AI-01` na regra nova e o node-pg-migrate removido; as instruções dos agentes passam às regras do Kysely no mesmo PR.
  - Antes da conversão, a sessão principal ajusta o que o `implementer` não edita (AI-04): o `include` do `tsconfig.json` e o `overrides` do `.oxlintrc.json` (`FND-11`); a regra de migrações do `AGENTS.md` e do `implementer.md`; o comentário do `ci.yml`; e o `scripts/check-migrations.ts`, depois dos testes novos do `test-writer`.
  - Depois disso, o `implementer` escreve a migração em TypeScript, apaga o `.sql` e troca o runner.
- Transação do checkout, respostas, status do pedido e contrato das duas rotas, conforme o design.
- `/security-review` no PR, porque é o marco que recebe dados do cliente.

**Pronto quando:** `CHK-*`, `FND-09`, `FND-10`, `FND-11` e `AI-19` passam, junto com as cláusulas novas do M2 nos critérios que já existiam: os arquivos `.ts` no `AI-01`, o `.kysely-codegenrc*` no `AI-04`, as duas conferências no `AI-05` e no `AI-17`, e os schemas de sucesso e de erro do `POST /checkout` e do `GET /orders/{orderId}/status` no `FND-07`.

## M3 — Processamento assíncrono

**Meta:** todo pedido aceito é processado pelo menos uma vez e termina faturado, falho ou na DLQ, de onde a reconciliação e o reprocessamento em lote o tiram; ele é faturado no máximo uma vez, com o limite do R6.

- Design de mensageria e resiliência (`DOC-MSG`).
- Worker (envio, desfechos, reconciliação e runbook) e camada anticorrupção, conforme o design.

**Pronto quando:** `ORD-*` passam, contando faturas no ERP com falhas injetadas pelo ERP simulado.

## M4 — Vitrine e frescor

**Meta:** `GET /products` rápido e independente do ERP; com o ERP respondendo, defasagem de até 65,5 s mais a duração de uma rodada.

- Design de cache e performance da vitrine (`DOC-CAC`).
- Catálogo com cache e sincronização, conforme o design.

**Pronto quando:** `CAT-*` passam, com relógio controlado, junto com a cláusula do `FND-07` para o `GET /products` (schemas de sucesso e de erro).

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
- README de entrada: pré-requisitos e comandos; mapa requisito → arquivo → teste; garantias, cada uma com a hipótese e o teste que a prova, e a tabela de modos de falha (`DOC-OPS-01`); decisões em uma linha, cada uma com o trade-off aceito e o link para a ADR; riscos residuais e como são detectados; simplificações, limitações, hipóteses e premissas; "Como a IA foi usada", com o link para o `PROMPTS.md`.
- O README de entrada começa por subir, testar e conferir, sem exigir a configuração da fábrica; a configuração de máquina dos agentes vai para um documento próprio, com link.
- Índice das cinco perguntas no README e no topo do `ARCHITECTURE.md` (`DOC-IDX-01`).
- O texto de resposta às cinco perguntas, entregue fora do repositório, com o link do repositório público no fim, como o desafio pede, e uma cópia versionada no repositório (`DOC-ENT-01`).
- `/security-review` final.
- Verificação: repositório público; clone limpo pela URL pública, sem credenciais; compose, testes e CI verde.

**Pronto quando:** cada requisito da tabela acima está comprovado num clone limpo.

---

## Ordem de corte

Se for preciso reduzir, os cortes vêm nesta ordem, sem tirar nenhum requisito da tabela acima. O que for cortado sai também das metas e vira limitação documentada no README.

1. As métricas que não alimentam alerta nem SLO, exceto `hit`, `miss`, o desfecho do checkout, o processamento da fila e as de frescor do cache.
2. A operação no README fica com um dashboard, os alertas e o runbook de DLQ.
3. A tabela de modos de falha fica só com as linhas que têm teste.
4. As fases de 30 e 90 dias viram um parágrafo, que ainda cita cache, fila, banco próprio da loja, workers, sincronização, observabilidade e reconciliação com o ERP (`DOC-DIA-04`).

## Adicionais

Fora do escopo principal. Entram só depois que M1 a M6 estiverem completos, nesta ordem:

1. Seção curta "segurança e limites" no README: sem autenticação, abuso possível, limites do contrato, preço lido do banco e o que muda em produção.
2. Estimativa de capacidade no design de diagnóstico, a partir das premissas de carga.
3. Plano de rollout por fase, com critério de saída e rollback.
4. `/livez` e `/readyz` separados.
5. Diagrama de sequência (Mermaid) do checkout ao faturamento.
6. Relay da outbox para um SQS local (ElasticMQ), num perfil opcional do compose, publicando o evento "pedido faturado" fora do caminho crítico (AD-021); pede dependência nova e AD própria.

## Arquitetura alvo

Descrita no `ARCHITECTURE.md`, fora deste escopo:

- cache L2 compartilhado, CDN e cabeçalhos de cache HTTP;
- fila gerenciada (SQS com DLQ e redrive policy) alimentada pela outbox;
- várias réplicas do worker, com a sincronização coordenada e o limite de chamadas e os pools divididos entre elas;
- sincronização incremental e captura de mudanças (CDC) a partir de uma réplica do MySQL do ERP, se a replicação puder ser habilitada;
- eventos de domínio;
- autenticação e autorização na borda.
