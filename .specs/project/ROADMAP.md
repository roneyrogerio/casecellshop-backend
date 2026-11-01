# Roadmap

**Marco atual:** F2 — Fábrica v3, qualidade e confiabilidade do código gerado (plano aprovado em 31/10/2026): #17, #18 e #19 entraram; #20 (B1, formatador) entrou; #21 (B2, checagens de código) entrou; #22 (B3, workflows do CI e cadeia de suprimentos) e #25 (teste do compose independente da ordem) entraram; #26 (B4a, guardas do repositório e das dependências) e #28 (preparo da sessão na nuvem) entraram; #27 (B4b, workflows, lint do Kysely e guardas) e #30 (processo, os `baixa` do #27) entraram; o PR C (#29, testes) está pronto para a aprovação; a seguir, os PRs D e E, depois o M4. O M3 terminou nos PRs #13 e #15

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

## M3 — Processamento assíncrono · CONCLUÍDO

**Meta:** todo pedido aceito é processado pelo menos uma vez e termina faturado, falho ou na DLQ, de onde a reconciliação e o reprocessamento em lote o tiram; ele é faturado no máximo uma vez, com o limite do R6.

- Design de mensageria e resiliência (`DOC-MSG`).
- Worker (envio, desfechos, reconciliação e runbook) e camada anticorrupção, conforme o design.
- Em duas partes: a primeira (PR #13) entrega o worker com a fila na própria tabela da outbox; a segunda troca a fila pelo SQS, com o ElasticMQ no compose e nos testes, um *Message Relay* da outbox para o SQS e a DLQ do SQS, e traz a reconciliação e o runbook sobre essa DLQ (AD-021).

**Pronto quando:** `ORD-*` passam, contando faturas no ERP com falhas injetadas pelo ERP simulado, com a fila do faturamento no SQS.

## F2 — Fábrica v3: qualidade e confiabilidade do código gerado

**Meta:** o código que a fábrica gera fica padronizado e confiável por checagens de máquina, e não só por instruções: cada classe de erro que a retrospectiva dos PRs #1 a #16 achou (guardas com brechas, documentação desatualizada, código repetido, verificadores fracos, ciclo de vida, testes que provam menos que dizem) passa a ter a checagem mais cedo possível que a pega. Plano aprovado pelo mantenedor em 31/10/2026; vem antes do M4.

- PR #17: pastas e regras do código (AD-025, AD-026). Concluído.
- PR #18: README para quem avalia e `CONTRIBUTING.md`. Concluído.
- PR #19, guardas da fábrica (AD-027): `implementer` e `test-writer` em worktree própria; hook de parada que confere o que mudou durante o agente e falha fechado; guardas de ferramenta que bloqueiam quando quebram; guarda de escrita do `reviewer`; teste dos comandos das skills contra as permissões; regras por tipo de arquivo para os agentes; o retrato do git que não atribui ao agente o que outra sessão faz (`AI-24` a `AI-33`). Rodar as checagens do hook de parada em paralelo foi medido e descartado: o tempo dele cai com o PR C.
- PR #30, processo: os achados `baixa` do #27 e a skill `/marco` dividida em arquivos de apoio. Concluído; foi o primeiro merge feito pelo GitHub App. Os `baixa` que ficaram estão no #30, em "Para o próximo plano".
- PR B, barreiras no CI, em quatro partes: B1, o formatador (`AI-34`); B2, as checagens de código; B3, os workflows do CI e a cadeia de suprimentos (`AI-42` a `AI-46`); B4, o endurecimento das guardas, em duas partes: B4a, as guardas do repositório e das dependências (`AI-47` a `AI-50`); B4b, o lint do Kysely e os workflows. Conteúdo: Prettier, knip, jscpd sobre a base, a conferência do Kysely como regra de lint (no lugar do verificador por expressão regular), actionlint, zizmor, CodeQL, Dependabot, `npm audit`, cobertura, CI em jobs e busca agendada de teste instável.
- PR C, testes, num PR só, em fatias (decidido pelo mantenedor em 01/11/2026): a estabilidade (o relógio que só avança com o sistema parado, os prazos de teste, o 57P01, o `unit` antes do `integration`), um PostgreSQL e um ElasticMQ por rodada, com banco clonado por arquivo, helpers sem cópias, os controles negativos que faltam, propriedades com o fast-check e fuzzing da API com o Schemathesis. O Stryker fica no PR próprio dos Adicionais.
- PR D, catálogo de eventos de log e de métricas, no padrão de nomes do OpenTelemetry, conferido com o `design.md`.
- PR E, documentação e specs: uma decisão por arquivo (MADR), spec da fábrica separada, critérios com uma exigência por ID, glossário, seção "Escrita", markdownlint, lychee e verificador de caminhos citados.

**Pronto quando:** os critérios de cada PR estão verdes, cada guarda com controle negativo, e a spec da fábrica diz, para cada classe de erro, se a checagem a garante ou só a reduz.

## M4 — Vitrine e frescor

**Meta:** `GET /products` rápido e independente do ERP; com o ERP respondendo, defasagem de até 65,5 s mais a duração de uma rodada.

- Design de cache e performance da vitrine (`DOC-CAC`).
- Catálogo com cache e sincronização, conforme o design.
- Uso pelo Insomnia sem passo manual (pedido do mantenedor, 31/10/2026): o `servers` do contrato aponta para `http://localhost:3000` (hoje é `/`, que não resolve num arquivo importado), e, se couber, a API serve o `/openapi.json`.

**Pronto quando:** `CAT-*` passam, com relógio controlado, junto com a cláusula do `FND-07` para o `GET /products` (schemas de sucesso e de erro), e, com um `docker compose up --build`, o `openapi.yaml` importado no Insomnia faz `GET /products`, `POST /checkout` e `GET /orders/{orderId}/status` contra `http://localhost:3000`, sem passo manual.

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

## Pendências

Itens pedidos ou decididos pelo mantenedor que ainda não estão num PR. Cada um diz onde entra. As pendências de um PR para o seguinte ficam na descrição dele: as do PR 2 do M3 estão no #13, em "Para o próximo plano".

- **Testes unitários do `src/` anterior ao M3** (pedido do mantenedor, PR próprio). Lacunas por prioridade:
  - **alta:** o `503` do `/health` (status, `Retry-After`, problem+json, log `health_failed`, span ERROR), por integração com o contêiner parado; o `traceparent` de entrada continuar o trace (`request-context.ts`); os campos obrigatórios do log fora de requisição;
  - **média:** `validate.ts` (caminho, mensagem, um erro por chave, origens, `messageFor`); `request-context.ts` (labels, log `http_request`, span ERROR no `5xx`, `close` sem `finish`); `lifecycle.ts` (um sinal só, `exit` 0 e 1, prazo de 25 s); `pool.ts` (`statement_timeout`, `lock_timeout` e o ouvinte `db_pool_error`); a mesma identidade de serviço no log e no trace;
  - **baixa:** o exportador escolhido por `OTEL_TRACES_EXPORTER`; o `404` e o `x-powered-by`; `envPort` e `requireEnv`.
  - **Decisões do mantenedor antes do PR:** o ID dos testes sem critério no `spec.md`; dois `SPEC_DEVIATION` (fora de requisição o log não traz `correlationId`, `trace_id` nem `span_id`; o `lifecycle.ts` usa `setTimeout` direto, contra a regra do relógio injetável); o provedor de cobertura, que seria dependência nova; e o `OTEL_TRACES_EXPORTER`, que ignora em silêncio um valor desconhecido.
- **Limite de paralelismo da integração (FND-13):** com os contêineres da rodada (FND-14, PR C), a medição do `maxWorkers` com a máquina carregada variou demais (de 52 s a 139 s na integração, sem relação com o número de arquivos em paralelo); o limite segue em 4 até repetir 4 e 8 numa máquina ociosa.
- **Fuzzing com catálogo (M4):** o fuzzing do FND-16 roda com o catálogo da loja vazio no compose, e todo `POST /checkout` com dados válidos pelo contrato recebe `422 /problems/unknown-sku` (medido em 01/11/2026: 241 casos, nenhuma checagem reprovada, 6 de 17 respostas do contrato alcançadas). Quando a sincronização do M4 encher o catálogo, o fuzzing passa a alcançar o `202`, o `409` e o preço mudado.
- **Achados `baixa` das Revisões 4, 5 e 8 do PR C (#29), para o próximo plano:**
  - A16: o `no-port-before-up` não vê o `listen` com função, com objeto sem `port`, com `undefined` ou com uma variável igual a 0;
  - A17: o import dinâmico de `node:child_process` e dos contêineres escapa do `no-restricted-imports` (o padrão e o de namespace já reprovam, conferido com o oxlint numa árvore temporária); falta um teste de ligação pelo `lint-tree` que rode o oxlint nas pastas;
  - A18: o `globToRegExp` de `test/helpers/glob.ts` traduz errado a vírgula fora de chaves e a classe `[!…]`;
  - A22 (Revisão 5): o `restricted-imports.test.ts` não exige o `default` nos `importNames`, então tirá-lo da configuração não reprova nada;
  - A24 (Revisão 5): três propriedades extras do FND-15 ("sorteio 0 dá o atraso mínimo", "mensagem bem formada é aceita", "preço e estoque só como inteiro seguro") não têm versão quebrada como controle;
  - A19: os testes de processo de `.claude/hooks/subagent-stop.test.ts` chamam o `spawnSync` sem prazo (um deles estourou os 5 s com a suíte inteira e passa sozinho); passar para o `runHook` e estender o `no-restricted-imports` a `.claude/**/*.test.ts`;
  - A28 (Revisão 8): nenhum controle negativo do `apiFuzzJobViolations` põe o passo que cria o `schemathesis-report` antes do checkout.
- **Achados `baixa` do #27 (B4b) que seguem abertos** (numeração do #27; os outros saíram no #30):
  - o merge do #30 pelo App, em 01/11/2026, confirmou o `env.HEAD` no `--jq` do `gh`: a aprovação no commit atual foi achada e o auto-merge ligado. Seguem a confirmar o `--author app/github-actions` no `gh issue list` do agendado e o segundo `gh pr merge --auto` num PR que já tem o auto-merge ligado. A busca do PR por `gh pr list --head`, do #30, roda pela primeira vez no próximo merge.
- **Piso de cobertura por dado e pela cobertura medida (próximo PR de processo; decidido em 01/11/2026):** a conferência do AI-49 lê o `vitest.config.ts` como texto, e cada revisão acha um jeito novo de esconder um piso menor (A4 do #26, A15 e A7 do #27); a regra do `]:` também reprova código válido. Ler o arquivo pela árvore de sintaxe não fecha o caso: o TypeScript 7.0.2 não expõe mais a API estável (`createSourceFile`), e nenhuma leitura do arquivo vê uma opção de linha de comando (`--coverage.thresholds.lines=0`), que o Vitest aplica por cima da configuração. A troca:
  - o piso sai para um arquivo de dados (`coverage-floor.json`), que o `vitest.config.ts` importa e passa ao `thresholds`;
  - o `check-baselines.ts` compara o arquivo da base com o do PR por um esquema fechado do zod, sem expressão regular;
  - na perna com `--coverage`, o relatório `json-summary` do Vitest é conferido contra o piso da base, o que torna inofensivos um `vitest.config.ts` que deixe de usar o arquivo, uma opção de linha de comando ou uma variável de ambiente;
  - saem o `floorOf`, o `coverageBlock`, as expressões regulares e a regra do `// prettier-ignore`; o AI-49 troca a "forma fixa" por estas três conferências; sem dependência nova.
- **Ambiente da sessão remota do Claude Code (PR de ambiente):** feito no PR do `AI-51` (AD-028); falta o mantenedor colar a chamada do `scripts/cloud-setup.ts` no script de preparo do ambiente em claude.ai/code (CONTRIBUTING.md, "Sessão do Claude Code na nuvem"; opcional, só acelera o início) e confirmar numa sessão nova que o relatório do início sai "Ambiente pronto". O GitHub MCP do `.mcp.json` segue fora da nuvem (AD-013); lá, o GitHub vem pelas ferramentas da própria sessão.
- **Spans do `ErpClient` e da outbox (A16 do #13, M5):** o design pede spans manuais nos dois; no M3 só a tentativa tem span.
- **Gauges de fila (M5):** pendentes e DLQ pelo `GetQueueAttributes` do SQS; a idade da mensagem mais antiga não existe na API do SQS (só no CloudWatch), então sai da outbox ou do `SentTimestamp` da mensagem.
- **Varredura de simplificação** (pedido do mantenedor, depois do M3): procurar uma biblioteca que faz o que outra já faz, ou código nosso que uma dependência já resolve, e simplificar só com prova técnica de que a qualidade melhora.
- **Pular o job `test` em PR que só muda `.specs/**` ou o `README.md`** (depois do B3): calculado no próprio YAML, com uma lista estreita de caminhos que nenhum teste lê, e nunca por `paths-ignore`, que deixaria o `ci-ok` pendente.
- **Contadores ainda sem registro (M5):** um counter só aparece no `/metrics` depois do primeiro registro (por exemplo, `erp_config_error_total`), e um alerta sobre série ausente precisa tratar isso.
- **Ações nas contas do mantenedor:**
  - feitas em 01/11/2026:
    - o ruleset exige só o `ci-ok`, a branch atualizada, o resultado do CodeQL (High or higher, Errors) e a aprovação do último push;
    - a opção "Require an additional approval for unattributed Copilot pull requests" foi desligada no bloqueio do #26 (L-008);
    - o App `casecellshop-merge` foi criado e instalado só neste repositório, com o ambiente `merge` restrito à `main` (AI-10);
  - a conferir: as atualizações de segurança do Dependabot; apagar as branches `chore/agentic-factory-v2` e `chore/ai-factory-v2`; a validade do token do bot; a proteção de push contra segredos (push protection).

## Ordem de corte

Se for preciso reduzir, os cortes vêm nesta ordem, sem tirar nenhum requisito da tabela acima. O que for cortado sai também das metas e vira limitação documentada no README.

1. As métricas que não alimentam alerta nem SLO, exceto `hit`, `miss`, o desfecho do checkout, o processamento da fila e as de frescor do cache.
2. A operação no README fica com um dashboard, os alertas e o runbook de DLQ.
3. A tabela de modos de falha fica só com as linhas que têm teste.
4. As fases de 30 e 90 dias viram um parágrafo, que ainda cita cache, fila, banco próprio da loja, workers, sincronização, observabilidade e reconciliação com o ERP (`DOC-DIA-04`).

## Adicionais

Fora do escopo principal. Entram só depois que M1 a M6 estiverem completos, nesta ordem:

1. **Teste de mutação com o Stryker** (decidido pelo mantenedor em 31/10/2026, PR próprio): mede se os testes, escritos por IA, pegam erro, e a nota entra em "Como a IA foi usada" no README. No CI, os módulos sem banco (camada anticorrupção do ERP, semáforo, cálculo do retry, validação e erros); fora do CI, uma rodada incremental no worker, no relay e no checkout, que sobem contêiner. Dependência nova, com a linha no `STATE.md` e o critério com ID no `spec.md` no plano desse PR.
2. Seção curta "segurança e limites" no README: sem autenticação, abuso possível, limites do contrato, preço lido do banco e o que muda em produção.
3. Estimativa de capacidade no design de diagnóstico, a partir das premissas de carga.
4. Plano de rollout por fase, com critério de saída e rollback.
5. `/livez` e `/readyz` separados.
6. Diagrama de sequência (Mermaid) do checkout ao faturamento.

## Arquitetura alvo

Descrita no `ARCHITECTURE.md`, fora deste escopo:

- cache L2 compartilhado, CDN e cabeçalhos de cache HTTP;
- o SQS gerenciado da AWS no lugar do ElasticMQ, e o EventBridge na saída do relay para um segundo consumidor dos eventos de pedido;
- várias réplicas do worker, com a sincronização coordenada e o limite de chamadas e os pools divididos entre elas;
- sincronização incremental e captura de mudanças (CDC) a partir de uma réplica do MySQL do ERP, se a replicação puder ser habilitada;
- eventos de domínio;
- autenticação e autorização na borda.
