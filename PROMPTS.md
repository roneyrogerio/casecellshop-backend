# Prompts de IA

A IA aqui não trabalha por pedidos avulsos: trabalha por um fluxo fixo, em que cada marco tem um plano aprovado, critérios de aceite, testes escritos antes do código por um agente e implementação por outro, e uma revisão independente. Os prompts que direcionam a IA em todo marco são as instruções desse fluxo, versionadas no repositório. Abaixo delas, por marco, ficam as orientações do mantenedor que mudaram o rumo, o que a IA errou e onde o erro foi pego.

## Onde estão os prompts que governam os agentes

| Prompt | Arquivo | Quando entra |
| --- | --- | --- |
| Regras de todo agente, em toda sessão | [`AGENTS.md`](AGENTS.md), carregado pelo [`CLAUDE.md`](CLAUDE.md) | sempre |
| Roteiro de cada marco: plano, delegação, revisão e PR | [`.claude/skills/marco/SKILL.md`](.claude/skills/marco/SKILL.md) | quando o marco começa |
| Pedido de cada delegação (o mapa da tarefa: critérios, trechos da spec, arquivos) | [`.claude/skills/marco/delegation.md`](.claude/skills/marco/delegation.md), seção "Task map" | em cada chamada de agente |
| Mensagens de commit e registro de decisões | [`commits.md`](.claude/skills/marco/commits.md) e [`decisions.md`](.claude/skills/marco/decisions.md), na mesma skill | em cada commit e em cada AD |
| Papel de quem escreve os testes | [`.claude/agents/test-writer.md`](.claude/agents/test-writer.md) | antes do código |
| Papel de quem implementa | [`.claude/agents/implementer.md`](.claude/agents/implementer.md) | depois dos testes |
| Papel de quem revisa | [`.claude/agents/reviewer.md`](.claude/agents/reviewer.md) | em cada rodada de revisão |
| Convenções de teste, de código e de documentação | [`.claude/rules/`](.claude/rules/) (`tests.md`, `architecture.md`, `docs.md`) | quando um arquivo do tipo é lido ou escrito |
| Subir o sistema e conferir o fluxo principal | [`.claude/skills/app-check/SKILL.md`](.claude/skills/app-check/SKILL.md) | antes de o PR sair do rascunho |

Essas instruções só mudam por PR, com CI e revisão; o histórico delas está no git. O que direcionou e corrigiu a IA fica onde é conferido: a intenção, nos critérios do [`spec.md`](.specs/features/casecellshop/spec.md) e no plano aprovado de cada PR; as decisões, nas ADs do [`STATE.md`](.specs/project/STATE.md); os erros, nos relatórios do `reviewer` postados em cada PR; e quem fez cada commit (sessão principal ou qual agente, com modelo, esforço e degrau da escada), nos trailers `Assisted-by`. Os exemplos do M2 e do começo do M3 estão no [`ARCHITECTURE.md`](ARCHITECTURE.md), seção "Prompts de IA relevantes", e não se repetem aqui.

## Orientações do mantenedor citadas literalmente

O pedido desta entrega (M5, operação, e M6, README), no início da sessão, em trecho:

```text
How to work (time is short; the maintainer decided):
- ONE PR for the whole session, from start to merge. Do not open follow-up PRs or one PR per slice; slices are commits in this PR.
- Every reviewer finding inside this session's scope (alta, média and baixa alike) is fixed in this same PR before it leaves draft. The reviewer checks the fix delta in the same round, and you repeat until nothing is open. Do not defer anything to a "next plan" or a later PR. Rule from Google's code review practices: cleanup promised "for later" rarely happens, so it is done in the current change.
```

No meio da mesma sessão, depois de o plano propor um leitor de PromQL próprio para o teste do `OBS-03`:

```text
Detalhe, antes de fazer qualquer coisa, consulte a documentação da ferramenta que você estiver usando e verifique se isso é um padrão. Jamais faça gambiarra. A gente não vai fazer nenhum tipo de gambiarra.
```

Resultado, com cada troca aprovada pelo mantenedor e registrada no `STATE.md`:

- o leitor de PromQL por expressões regulares foi descartado antes do commit; o teste lê as consultas pelo analisador oficial do PromQL (`@prometheus-io/lezer-promql`);
- a segunda versão do teste ainda lia o Markdown por expressões regulares; o README passou a ser lido pelo parser CommonMark (`mdast-util-from-markdown`), a âncora do runbook pelo `github-slugger`, e o catálogo pela fonte que gera o `telemetry.md`, em vez das tabelas dele;
- os alertas foram para o formato de arquivo de regras do Prometheus, conferido pelo `promtool check rules`;
- o burn rate seguiu a tabela do livro de SRE do Google, o que corrigiu o rascunho: o par de 6 h e 30 min é `page`, e não aviso.

Os registros dos PRs anteriores não citam o mantenedor literalmente; as orientações abaixo são paráfrases do que cada PR registra.

## M3 — Processamento assíncrono

### [#13](https://github.com/roneyrogerio/casecellshop-backend/pull/13): envio ao ERP com retry e DLQ

- **Orientação:** aprovar um PR acima do corte de 800 linhas, o M3 em dois PRs e o SQS como fila, com o ElasticMQ; três mudanças de processo dentro do PR do marco, como exceção.
- **O que a IA fez:** o worker com a classificação de erro na camada anticorrupção, retry com *full jitter*, DLQ, semáforo de 30 chamadas e o span ligado ao checkout; a skill `app-check`.
- **Pego na revisão:**
  - a receita da `app-check` foi escrita sem ser rodada: usava `curl`, que o projeto nega, e postava um comentário que a guarda do GitHub recusa (A19 e A20, `alta`, [Revisão 4](https://github.com/roneyrogerio/casecellshop-backend/pull/13#issuecomment-6541849389));
  - a camada anticorrupção aceitava catálogo com `priceCents` fracionário e `onHand` negativo (A1, `média`, [Revisão 1](https://github.com/roneyrogerio/casecellshop-backend/pull/13#issuecomment-6541052009));
  - a sessão principal inseriu a AD-021 no meio da AD-020, já aceita (A25, `média`, [Revisão 5](https://github.com/roneyrogerio/casecellshop-backend/pull/13#issuecomment-6542283042)).
- **Instruções que mudaram:** o "sem mock de banco" do `tests.md` virou uma ordem de dublês (a implementação real; a falha injetada na fronteira; o mock que conta chamadas só quando o critério é o número de chamadas), porque dois testes corretos violavam a regra literal; o `reviewer` passou a conferir a correção de texto na mesma rodada (AD-022).
- **Verificação:** `verify:full` com 2.256 testes, `/security-review` sem achado, `app-check` e CI verde.

### [#15](https://github.com/roneyrogerio/casecellshop-backend/pull/15): fila no SQS, relay, reconciliação e runbook

- **Orientação:** aceitar o PR acima do corte; pôr no primeiro commit a regra de que pendências e preferências ficam no repositório, e não na memória do agente.
- **O que a IA fez:** a outbox virou só caixa de saída, com o *Message Relay*; o worker passou a consumir do SQS; entraram a permissão de chamada por pedido (AD-024), a reconciliação e o runbook `redrive | cancel`.
- **Pego:** o `pre-push` pegou um `set` com função na permissão de chamada (AI-19), que o `verify:fast` do hook de parada não roda; o CI ficou vermelho porque um teste de persistência do ElasticMQ disputava a fila com o worker do compose, e o erro estava na premissa do teste. Os outros achados estão no `ARCHITECTURE.md`.
- **Instruções que mudaram:** o `AGENTS.md` ganhou o parágrafo "toda decisão, pendência e preferência fica no repositório", para uma sessão na nuvem começar do mesmo lugar que a local.
- **Verificação:** 25 de 25 critérios com teste, 6 rodadas, `/security-review`, `app-check` e CI verde.

## F2 — Fábrica v3

| PR | Orientação | O que a IA errou e onde foi pego | O que mudou nas instruções |
| --- | --- | --- | --- |
| [#17](https://github.com/roneyrogerio/casecellshop-backend/pull/17), pastas e lint (AD-025, AD-026) | trocar, numa errata da AD-012, nomes de empresas pelo princípio técnico | a regra nova de errata contradizia o `STATE.md`, a `/marco` e o `reviewer.md` (A1, `média`, [Revisão 1](https://github.com/roneyrogerio/casecellshop-backend/pull/17#issuecomment-6551052530)); o próprio `reviewer` atribuiu uma frase ao guia errado do Google sem abrir a página, e a sessão principal conferiu na fonte ([Revisão 2](https://github.com/roneyrogerio/casecellshop-backend/pull/17#issuecomment-6551167332)) | o `reviewer.md` passou a aceitar errata datada numa AD aceita |
| [#18](https://github.com/roneyrogerio/casecellshop-backend/pull/18), README e `CONTRIBUTING.md` | o README é o que o avaliador lê primeiro, e o mantenedor julga o texto | o `cancel` do runbook estava descrito sem a condição de consultar o ERP antes (`média`) | — |
| [#19](https://github.com/roneyrogerio/casecellshop-backend/pull/19), agentes em worktree (AD-027) | commitar antes de delegar e não mexer na pasta principal com um agente rodando | com o `cwd` numa worktree, a sessão principal podia forjar um relatório de revisão (A1, `média`, [Revisão 1](https://github.com/roneyrogerio/casecellshop-backend/pull/19#issuecomment-6552116716)); uma branch movida numa worktree sumia da comparação, e a primeira correção não fechou o caso ([Revisão 2](https://github.com/roneyrogerio/casecellshop-backend/pull/19#issuecomment-6552213094)) | `isolation: worktree` no `implementer` e no `test-writer`; as regras `architecture.md` e `docs.md`; o `implementer` não pode subir limite nem desligar regra de lint |
| [#20](https://github.com/roneyrogerio/casecellshop-backend/pull/20), Prettier (AI-34) | — | o hook não formatava os arquivos das worktrees; a `/security-review` achou a configuração do Prettier sem guarda; os dois com teste que falhava antes | — |
| [#21](https://github.com/roneyrogerio/casecellshop-backend/pull/21), knip, jscpd, cobertura e Kysely no lint | trocar o ast-grep do plano por uma regra de lint | a regra nova deixava passar formas que o script antigo pegava (A1, `média`, [Revisão 1](https://github.com/roneyrogerio/casecellshop-backend/pull/21#issuecomment-6553644668)) | `check:unused` e `check:duplication` no hook de parada |
| [#22](https://github.com/roneyrogerio/casecellshop-backend/pull/22), CI em jobs e cadeia de suprimentos | o ruleset passa a exigir só o `ci-ok` | nenhum teste conferia o que o CodeQL exclui (A12, `média`, [Revisão 2](https://github.com/roneyrogerio/casecellshop-backend/pull/22#issuecomment-6554624141)); o actionlint e o CodeQL acharam problemas no próprio PR | — |
| [#25](https://github.com/roneyrogerio/casecellshop-backend/pull/25), restart do ElasticMQ | — | o agendado, com ordem embaralhada, pegou um teste que só passava rodando por último | — |
| [#26](https://github.com/roneyrogerio/casecellshop-backend/pull/26), guardas do repositório | — | um lockfile sem `packages` passava (A2, `média`, [Revisão 1](https://github.com/roneyrogerio/casecellshop-backend/pull/26#issuecomment-6555451884)), e a correção abriu outra brecha (A9, [Revisão 2](https://github.com/roneyrogerio/casecellshop-backend/pull/26#issuecomment-6555594667)) | — |
| [#27](https://github.com/roneyrogerio/casecellshop-backend/pull/27), merge pelo GitHub App | criar o App `casecellshop-merge` e o ambiente `merge` | a sessão principal mandou um arquivo de `scripts/` ao `implementer`, e a guarda negou; um registro no ROADMAP exagerava a causa e os números | `scripts/` e os hooks são da sessão principal |
| [#29](https://github.com/roneyrogerio/casecellshop-backend/pull/29), testes estáveis, propriedades e fuzzing | um PR só, em fatias | o Schemathesis não gravava o relatório no runner Linux (A25, `alta`, [Revisão 7](https://github.com/roneyrogerio/casecellshop-backend/pull/29#issuecomment-6563111888)); o fast-check achou um defeito de produção, o mesmo erro duas vezes no mesmo campo do `400` | — |
| [#30](https://github.com/roneyrogerio/casecellshop-backend/pull/30), `baixa` do #27 e a `/marco` dividida | corrigir no PR uma regressão do próprio PR | uma edição feita pelo Bash, e não pelas ferramentas de edição, relatada como desvio | o `delegation.md`: mapa da tarefa, como trazer o trabalho do agente, o CI e a espera sem `sleep` |
| [#32](https://github.com/roneyrogerio/casecellshop-backend/pull/32), piso de cobertura | decidir pela pesquisa entre uma regra local e o `oxlint-plugin-eslint` | a lista fechada de argumentos do CI reprovou as flags novas da cobertura | o `reviewer` passou a conferir o `coverage-floor.json` |
| [#34](https://github.com/roneyrogerio/casecellshop-backend/pull/34), pular os testes em PR só de documentação (AI-53) | trazer para o PR o fuzzing, a guarda em execução e os `baixa` | o `ci-ok` decidia por uma lista de proibidos; a `/security-review` notou que o pulo dependia da base do PR | — |

## PR D — Catálogo de telemetria ([#33](https://github.com/roneyrogerio/casecellshop-backend/pull/33), AD-029)

- **Orientação:** um PR só, com tudo corrigido nele e sem gambiarra; 2 achados `média` e 24 `baixa`, todos corrigidos no PR.
- **O que a IA fez:** um `telemetry.ts` por pasta, o `AppLogger` opaco com o `eventLogger` tipado, a métrica HTTP pela convenção do OpenTelemetry e o `telemetry.md` gerado.
- **Pego:**
  - nada provava que o `tsc` recusa um nome ou um valor fora da declaração (A1, `média`, [Revisão 1](https://github.com/roneyrogerio/casecellshop-backend/pull/33#issuecomment-6564836799));
  - um cliente que desconecta era gravado como status 200 (A6, `média`, [Revisão 2](https://github.com/roneyrogerio/casecellshop-backend/pull/33#issuecomment-6565193728));
  - o `app-check` mostrou que a própria skill filtrava os nomes antigos das métricas.
- **Lição:** uma conferência que lê código como texto deixa brechas; fechar a classe de erro pelo tipo e pelo lint dispensou a heurística. A mesma lição levou o teste do `OBS-03` ao analisador oficial do PromQL.
- **Instruções que mudaram:** no `AGENTS.md`, métricas e eventos de log declarados no `telemetry.ts` da pasta e escritos só pelos instrumentos tipados e pelo `eventLogger`, com o `telemetry.md` gerado (OBS-07); o `npm run telemetry-doc` entrou nos comandos.
- **Verificação:** 4.852 testes, Revisão 8 sem achado, `/security-review` sem achado ([comentário](https://github.com/roneyrogerio/casecellshop-backend/pull/33#issuecomment-6568242977)), `app-check` e CI verde.

## O controle não depende de ler prompts

Os testes nascem antes do código, escritos por outro agente; um hook impede o agente de terminar com checagem vermelha; guardas impedem cada papel de mexer no que não é dele; e o merge só acontece com o CI verde e a aprovação do mantenedor. O fluxo e os motivos estão na AD-012 do [`STATE.md`](.specs/project/STATE.md).
