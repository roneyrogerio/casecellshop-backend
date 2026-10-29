# Uso de IA

Registro do uso de IA neste repositório. Cada entrada traz o pedido, o que a IA produziu, o que foi aceito, corrigido ou rejeitado, e como foi verificado. Entram os pedidos que geraram código, spec ou decisão relevante e todo caso em que a saída da IA foi corrigida ou rejeitada; ajustes mecânicos, como formatação e renomeação, não entram. O fluxo de agentes está no [`AGENTS.md`](AGENTS.md). As decisões que saíram daqui estão no [`STATE.md`](.specs/project/STATE.md) e nas [convenções](.specs/codebase/CONVENTIONS.md).

## M0 — Planejamento

### Specs escritas com IA e revisadas por revisores independentes

- **Pedido:** escrever a visão, o roadmap, as decisões e os critérios antes do código, e revisá-los contra os requisitos.
- **O que a IA fez:** escreveu as specs. Cinco agentes revisores, em contexto limpo e sem ver as rodadas anteriores, revisaram em sete rodadas.
- **Triagem:** um achado só contava se mais de um revisor o apontasse, ou se a fonte o confirmasse. O ciclo parou quando os achados viraram casos de borda e pedidos de corte.
- **Erros da própria IA pegos na revisão:**

  | Erro | Correção |
  | --- | --- |
  | API do OpenTelemetry 1.10.0 com o SDK 2.12, o que quebraria o `npm ci` | API 1.9.1 |
  | `sdk-trace-base`, que não propaga contexto | `sdk-trace` + `context-async-hooks` |
  | `max-age` com `Age`, contando a idade duas vezes (RFC 9111) | `no-store` |
  | Soma do limite de frescor errada | 65,5 s, depois de tirar um timer |
  | Atraso mínimo contado do fim da chamada | Contado do início, 45 s (H4) |
  | Marcador de envio sem momento de escrita definido | Gravado na reivindicação (L-005) |
  | Sincronização que pulava a linha disputada, deixando SKUs sem atualização | Desconto pelo `sold_total` (L-004) |

- **Verificação:** versões conferidas no npm; RFCs e documentação lidas na fonte.

### Reorganização das specs no formato de origem

- **Pedido:** caber nos limites de tamanho do formato, sem perder informação.
- **O que a IA fez:** dividiu o conteúdo em `spec.md` (critérios), `design.md` (o "como") e ADRs enxutas.
- **Corrigido antes do commit:** a comparação com a versão anterior, mecânica (números, código, IDs) e frase a frase, achou cerca de 20 justificativas perdidas na condensação. Elas foram restauradas.

## PR #1 — Fluxo de trabalho com IA

### Agentes e escalonamento de modelo

- **Pedido:** um conjunto mínimo de agentes, cada um num ponto em que um olhar separado reduz um viés, com escalonamento de modelo.
- **O que a IA fez:** propôs `planner`, `test-writer` e `reviewer`, com a sessão principal escrevendo o código e trocando para Opus depois de duas reprovações.
- **Corrigido:** conferindo a documentação, a troca não funcionava. O `/model` e o `/effort` são comandos de quem usa, não da IA, e o `/effort` digitado fica salvo como padrão.
- **Resultado:** entrou o `implementer`. A escada passa `model` e `effort` na chamada, que vencem o frontmatter, e cada degrau é uma chamada nova, porque um agente retomado mantém o esforço.
- **Verificação:** [subagentes](https://code.claude.com/docs/en/sub-agents) e [configuração de modelo](https://code.claude.com/docs/en/model-config) do Claude Code.

### Pasta e nome dos testes

- **O que a IA fez:** propôs `test/`, depois o formato híbrido, com o teste de unidade ao lado do código.
- **Rejeitado:** o híbrido, questionado na revisão. A maioria dos critérios atravessa HTTP, banco e worker e não pertence a um arquivo do `src/`.
- **Resultado:** `test/unit/` (sem Docker) e `test/integration/<área>/`, separados como *projects* do Vitest. Assim, o commit `test:` só toca em `test/`. O nome de cada teste é o ID do critério seguido da descrição em português.
- **Verificação:** o padrão de busca lido no pacote `vitest@5.0.5`; documentação de `include` e *projects*.

### Instruções da IA

- **O que a IA fez:** um `CLAUDE.md` que só importa o `AGENTS.md`, e o limite de 200 linhas por arquivo de instrução.
- **Por quê:**
  - o Claude Code só lê o `AGENTS.md` direto quando não há `CLAUDE.md`, e a partir da v2.1.277;
  - o arquivo de instrução carrega em toda sessão: quanto maior, mais contexto ocupa e menos é seguido, por isso o teto de 200 linhas.
- **Verificação:** [memória e instruções](https://code.claude.com/docs/en/memory) do Claude Code.

### Quem publica no PR

- **Pedido:** descobrir quais agentes comentam no PR e de que forma.
- **O que a IA fez:** propôs o padrão de publicação e o conferiu nas regras do GitHub e na documentação do Claude Code.
- **Resultado:**
  - só o revisor comenta, um comentário por rodada, e nunca aprova: o PR sai da conta do mantenedor, que não pode aprovar o próprio PR, e o comentário de cada rodada guarda a marcação que define o escalonamento;
  - o plano vai como checklist na descrição do PR;
  - não há issues, porque a spec é a fonte da verdade e uma issue repetiria o marco.

### Auditoria das instruções

- **O que a IA fez:** duas auditorias dos arquivos de instrução, pelo guia de `prompt-audit` do Claude Code.
- **Resultado:** nenhum padrão escrito para modelo antigo e nenhum caminho quebrado. Seis contradições entre arquivos foram corrigidas, uma delas introduzida pela própria IA na rodada anterior: a checagem de integridade dos testes barrava a correção legítima de um teste.

### Guardas dos agentes

- **O que a IA fez:** um hook de caminho por papel e regras `ask` e `deny` (decisão na tabela de ferramentas do `STATE.md`).
- **Corrigido antes de aplicar:** o hook ia no frontmatter de cada agente. A documentação mostrou que esse hook é pulado sem aviso quando a pasta não está marcada como confiável, então ele foi para o `settings.json`, pelo `agent_type`.
- **Verificação:**
  - uma matriz de 20 casos;
  - de ponta a ponta com `claude -p --agent`: o `implementer` foi bloqueado em `test/` e o `test-writer` em `src/`;
  - a leitura do `.env` foi negada pela regra.
  
  Merge, revisão e criação de issue não foram testados ao vivo, porque uma falha teria efeito real.

## M1 — Fundação

### Abertura do M1

- **Pedido:** seguir o fluxo do `AGENTS.md` no M1, tratando cada atrito do próprio fluxo como achado; o `planner` resolve a ordem entre o spike de ferramental e os testes, e o plano só segue com a aprovação do mantenedor.
- **Prompt** (literal, no idioma original):

````text
Continue the CaseCellShop backend from milestone M1 (Fundação), following the workflow in AGENTS.md exactly. This milestone is also the first real run of that workflow, so treat any friction or defect in the workflow itself as a finding.

Where things stand:

- PR #1 (AI workflow: AGENTS.md, CLAUDE.md, the four agents, `.claude/settings.json` with the guardrails, the PR template and PROMPTS.md) is merged into `main`.
- Branch `feat/foundation` is pushed, with no PR yet. Its one commit, `3cf3452`, proposes two decisions, both already approved by the maintainer:
  - AD-010: the contract is written in zod in `src/contract/`; `@asteasolutions/zod-to-openapi` generates `openapi.yaml` (OpenAPI 3.1), which CI checks (`FND-07`).
  - AD-011: latest stable versions, pinned exactly. Node 26.13.0, with a 24.12 floor and CI on both; OpenTelemetry 3; TypeScript 6.0.3 as the documented exception.
- AD-010 and AD-011 stay "proposta" until the last commit before the M1 merge. In that commit:
  - mark them "aceita";
  - mark AD-007 "substituída por AD-010" and AD-008 "alterada pela AD-011";
  - move AD-007 to `.specs/project/STATE-ARCHIVE.md`, because `STATE.md` is at about 5,430 of its 6,000 words.
- There is no `package.json`, code, test or CI yet.
- Versions verified on 29/10/2026, all latest stable and compatible (pin them exactly, per AD-011; re-check only a package whose install shows a newer stable):

  | Area | Versions |
  | --- | --- |
  | Runtime | Node 26.13.0 (floor 24.12); TypeScript 6.0.3; `@types/node` 24.19.2 |
  | HTTP | `express` 5.3.0; `@types/express` 5.0.6 |
  | Contract | `zod` 4.6.7; `@asteasolutions/zod-to-openapi` 9.1.0; `yaml` 2.9.1; `@redocly/cli` 2.72.1 |
  | Database | PostgreSQL 18.6; `pg` 8.23.1; `@types/pg` 8.23.1 |
  | Logs | `pino` 10.4.0; `pino-http` 11.0.0 |
  | OpenTelemetry | `@opentelemetry/api` 1.10.0; `sdk-trace`, `sdk-metrics`, `context-async-hooks`, `core` and `resources` 3.0.0; `exporter-prometheus` and `exporter-trace-otlp-http` 0.300.0 |
  | Tests | `vitest` 5.0.5; `supertest` 7.3.1; `testcontainers` and `@testcontainers/postgresql` 12.2.1 |
  | Lint | `eslint` 10.13.0; `typescript-eslint` 8.72.1 |

Do, in order:

1. `git switch feat/foundation && git pull`.
2. Read:
   - `.specs/README.md`;
   - the M1 section of `ROADMAP.md`;
   - the `FND-*` and `DOC-DIA-*` criteria in `spec.md`;
   - AD-010, AD-011 and risks R1, R2 and R8 in `STATE.md`;
   - `design.md` as needed.
3. Delegate the M1 plan to `planner`. The plan must:
   - resolve the ordering problem: `test-writer` must run the tests it writes, but Vitest and Testcontainers do not exist until the tooling spike (R8) lands, so sequence the spike and the `test-writer` and `implementer` steps so that every step can run;
   - say which commit each item goes in (`test:` before `feat:`);
   - list which M1 decisions need a new AD or tool-table row.
4. Show me the plan in Portuguese and wait for my approval before writing anything.
5. Then follow steps 2 to 6 of the AGENTS.md workflow:
   - update the spec;
   - draft the `DOC-DIA` section of `ARCHITECTURE.md`;
   - write the contract;
   - commit, and open the draft PR with the plan as a checklist;
   - run `test-writer`, then `implementer`;
   - post the `reviewer` report as a PR comment;
   - I merge.

Fold these spec items into the M1 PR:

- In the language rule of `CONVENTIONS.md` and in the `PROMPTS.md` template: a prompt quoted verbatim keeps its original language, like code, with the explanation in Portuguese around it.
- Record this kickoff prompt verbatim in `PROMPTS.md`, under M1, as the request that started the milestone.

Test the flow while you work. Confirm each item below in the PR description, under "Como foi verificado", and record any defect under the decision-record rule:

- `planner` proposes without editing files;
- the `PreToolUse` hook in `.claude/settings.json` works:
  - `test-writer` is blocked outside `test/`;
  - `implementer` is blocked in `test/`, `.specs/`, `src/contract/` and the AI instruction files;
- every `git commit`, `git push` and `gh pr` write asks me first;
- the escalation ladder is applied per problem, with `model` and `effort` passed on the `implementer` call, and each step is a new call;
- each `reviewer` report is posted as one comment per round, starts with "## Revisão <n>", and never approves;
- decisions and AI usage land in `STATE.md` and `PROMPTS.md` in the same PR.

Never commit or push without my approval. Talk to me in Brazilian Portuguese.
````

- **O que a IA fez:** o `planner` propôs o plano em 13 commits, com o spike do R8 pelo `implementer` num commit `build:` antes do contrato e dos testes, e cinco desvios de spec (D1 a D5).
- **Corrigido:**
  - o `planner` afirmou que o PR #1 não estava na `main`; o `git log origin/main` mostrou o merge (`57f7428`);
  - a sessão principal, ao repassar as perguntas do plano, deixou de fora a de quando o CI entra; ela foi feita depois.
- **Resultado:** plano aprovado pergunta a pergunta: `FND-01` como teste que sobe o compose; só as tabelas que o M1 testa; ERP simulado só no modo normal; `FND-08` para a guarda de caminho; CI no fim do marco; D1 a D5 aceitos.
- **Verificação:** `git status` limpo depois do `planner`; `git log origin/main`.

### Contrato: escrito à mão ou gerado pelo código

- **Pedido:** decidir, com dados, entre o `openapi.yaml` escrito à mão com um validador e o OpenAPI gerado a partir do código.
- **O que a IA fez:** levantou as opções compatíveis com Node 24, Express 5, TypeScript 6 e *type stripping*, com versões, downloads e mantenedores, e recomendou manter o contrato à mão, pesando o esforço de escrever a validação.
- **Corrigido:** o critério. O código é escrito pela IA e revisado antes do merge, então o esforço não decide; a escolha passou a ser só pela qualidade: uma fonte para validação, tipos e documentação.
- **Resultado:** AD-010, contrato em zod gerando o OpenAPI 3.1, conferido no CI (`FND-07`), em substituição à AD-007.
- **Verificação:** versões e mantenedores no npm; o suporte ao TypeScript 6 do gerador de tipos, ainda em issues abertas; a geração de OpenAPI 3.1 na documentação do `zod-to-openapi`.

### Versões

- **Pedido:** usar as versões estáveis mais atuais, já que o plano estava no Node 24 com o 26 disponível.
- **O que a IA fez:** conferiu, nas fontes, a última versão de cada peça e as compatibilidades entre elas (`engines` e `peerDependencies`).
- **Resultado:** AD-011.
  - Node 26.13.0 LTS, com piso na 24.12 e CI nas duas linhas.
  - OpenTelemetry 3.
  - O resto já estava na última versão.
  - O TypeScript fica no 6.0.3, porque o `typescript-eslint` exige `<6.1.0`.
  - O PostgreSQL 18.6 é o mais atual; o 19 ainda não saiu.
- **Verificação:**
  - o índice de versões e o calendário de releases do Node;
  - `npm view` de cada pacote;
  - a página de versões do PostgreSQL e as imagens oficiais no Docker Hub.

### Modelo da sessão principal

- **Pedido:** o mantenedor notou que o planejamento com ele rodava em Sonnet, e pediu que o orquestrador tivesse modelo e esforço fixos no projeto, mudando só a pedido explícito.
- **O que a IA fez:** leu a documentação do `opusplan`, do plan mode, da precedência das configurações e do `agent` como sessão principal, e comparou com outro projeto do mantenedor, que roda em Opus pela configuração de usuário.
- **Corrigido:**
  - a IA disse primeiro que o `opusplan` "funcionou como configurado"; o mantenedor apontou que o fluxo prometia Opus para planejar e não entregava, e o defeito passou a ser tratado como do desenho do fluxo;
  - a IA disse que o esforço seria o padrão do modelo; a configuração de usuário tinha `modelSettings` com `xhigh` para o Opus, e a documentação mostrou que um `effortLevel` de projeto vence esse valor.
- **Resultado:** `"model": "opus"` e `"effortLevel": "high"` no `.claude/settings.json` (linha "Sessão principal" na tabela de ferramentas). O plan mode não liga sozinho, e na extensão do VS Code o modo inicial nem vem do projeto.
- **Verificação:** documentação de configuração de modelo, de modos de permissão, de configurações e de subagentes do Claude Code.

### Acesso a dados: Prisma, Drizzle, Kysely ou SQL

- **Pedido:** o mantenedor preferia o Prisma, pela simplicidade, e pediu para conferir se ele cobre o que o projeto usa do PostgreSQL.
- **O que a IA fez:** listou, do `design.md`, os recursos usados (`ON CONFLICT DO NOTHING`, `UPDATE` com aritmética entre colunas, `FOR UPDATE SKIP LOCKED`, `now() + interval`, `RETURNING`, `lock_timeout` e os códigos de erro, dois schemas) e conferiu cada um no Prisma 7, no Prisma 8, no Drizzle e no Kysely.
- **Corrigido:** a IA disse que o Prisma não tinha lock de linha; o Prisma 8 ganhou `forUpdate({ skipLocked })` em 07/10/2026. Mas o 8 ainda é release candidate, embora a tag `latest` do npm aponte para ele; o estável é o 7.10.1.
- **Resultado:** mantido o `pg` com SQL explícito (AD-001). O Prisma 8 não é estável e deixa o `ON CONFLICT` e a reserva em SQL cru, com migrações em TypeScript; o Prisma 7 deixa toda a concorrência em `$queryRaw`; no Drizzle, as consultas críticas também seriam templates `sql`. Reabrir se o projeto ganhar CRUD e filtros dinâmicos.
- **Verificação:** `dist-tags` e metadados no npm; documentação do Prisma 8 (SQL builder, transações, versões suportadas, migrações); o PR #30555 do Prisma; o código-fonte dos builders do Drizzle e do Kysely.

### Redis ou PostgreSQL

- **Pedido:** saber se o desafio exige Redis e se quem avalia prefere vê-lo.
- **O que a IA fez:** releu o PDF do desafio, que cita "Redis/fila local" como uma opção de serviço de apoio, e pesquisou o que costuma pesar numa avaliação.
- **Resultado:** tudo no PostgreSQL (AD-003, AD-005). O PDF pede cache com TTL "ou estratégia equivalente" e uma fila, sem nomear o Redis; a outbox responde à pergunta do pedido fantasma numa transação só. O Redis fica na arquitetura alvo, como cache compartilhado entre instâncias.
- **Verificação:** o texto do PDF.

### Ferramenta de migração

- **Pedido:** migrações que funcionem com vários programadores e PRs, com uma ferramenta testada pela comunidade.
- **O que a IA fez:** comparou o Flyway, o Rails, o node-pg-migrate, o dbmate, o Postgrator, o postgres-migrations, o graphile-migrate, o `@databases/pg-migrations` e o umzug quanto a `.sql` puro, tabela de controle, ordem, *checksum*, *advisory lock*, transação por arquivo e manutenção.
- **Rejeitado:** a IA recomendou primeiro um runner próprio e afirmou que o node-pg-migrate não aceitava `.sql`. O mantenedor pediu outra pesquisa, e a API programática mostrou o carregador `sql`.
- **Resultado:** node-pg-migrate 9.0.0, com uma regra no CI que barra alterar ou apagar uma migração já na `main`, porque ele não confere o conteúdo do que já rodou (linha "Migrações" na tabela de ferramentas).
- **Verificação:** documentação do Flyway, do node-pg-migrate, do dbmate e do Rails; `npm view` com a data de cada versão.

### Revisões das propostas do plano

- **Teste do `FND-01`:** a IA trocou o teste que sobe o compose por uma checagem estática do `compose.yaml`, para deixar o `npm test` rápido. O mantenedor perguntou se aquilo testava algo; não provava que o compose sobe, e o teste real voltou, com o `npm run test:unit` como caminho rápido.
- **Exceção do `FND-07`:** a IA propôs que o `test-writer` alterasse o `openapi.yaml` por um momento, para ver o teste falhar; a guarda de caminho bloquearia isso. O teste ganha, em vez disso, um caso negativo com uma cópia errada do OpenAPI em `test/fixtures/`.
- **Lint do OpenAPI:** a IA recomendou o `recommended`, em que aviso não reprova. O mantenedor pediu para conferir a documentação antes; como vários avisos apontam contrato incorreto (exemplo que contradiz o schema, campo obrigatório inexistente), ficou o `recommended-strict`, com cada exceção justificada.
- **Limites do `STATE-ARCHIVE.md` e do `ARCHITECTURE.md`:** conferidos na `tlc-spec-driven` v2.0.0 (commit `1a6fffb`). O arquivo morto não tem limite e não é carregado; o `ARCHITECTURE.md` limitado da skill é o mapeamento de código existente, em `.specs/codebase/`, e não o documento de entrega da raiz.
- **Dados iniciais do ERP simulado:** *seed* separado das migrações, como o guia do Rails recomenda para dados de demonstração.

### Teste da guarda de caminho no fluxo real

- **Pedido:** confirmar, com os subagentes chamados pela sessão principal, que a guarda barra o `test-writer` fora de `test/` e o `implementer` em `test/`, `.specs/`, `src/contract/` e nas instruções da IA. No PR #1, o teste tinha sido feito só com `claude -p --agent`.
- **O que a IA fez:** seguiu a sonda do plano: um `Edit` de texto inexistente em cada caminho, para nada mudar se a guarda falhasse.
- **Corrigido:**
  - nenhuma das 13 sondas do `implementer` e das 2 do `test-writer` foi barrada; todas voltaram "arquivo não existe" ou "texto não encontrado", e a guarda pareceu quebrada. O script do hook, chamado direto com a mesma entrada, negava. A causa era a sonda: o `Edit` inválido para na validação da ferramenta e não chega ao hook (L-006);
  - para ver a entrada do hook, a IA tentou acrescentar um hook temporário ao `.claude/settings.json`; o classificador do modo automático negou a edição como "Self-Modification", e ela não foi contornada.
- **Resultado:** com `Write` de arquivos novos, o hook negou o `test-writer` em `src/` e o `implementer` em `test/`, `.specs/`, `src/contract/`, `.claude/`, `Test/` (outra caixa), `./src/../test/` e no caminho absoluto de `test/`, e deixou o `implementer` criar `src/sonda-guarda.ts`, apagado em seguida. O R10 registra o que a guarda não cobre: a escrita pelo Bash.
- **Verificação:** a mensagem de negação do hook em cada caso; `git status` limpo depois de cada sonda.
- **Atrito do fluxo:** a alteração do `.claude/settings.json` no commit `a17d028` foi feita por um script no Bash e passou, enquanto o `Edit` do mesmo arquivo foi negado agora. Daqui em diante, uma mudança em `.claude/` pela sessão principal só entra com o diff mostrado ao mantenedor antes.

### Onde ficam os testes

- **Pedido:** o mantenedor perguntou se o padrão em projetos grandes é a pasta de testes separada ou o teste junto do arquivo que ele testa, e pediu o porquê técnico.
- **O que a IA fez:** mostrou que não há um padrão único e que o mais recomendado é o híbrido. Recomendou manter tudo em `test/`, decidido no PR #1.
- **Corrigido:** o argumento principal da IA, de que a guarda de caminho deixaria de funcionar com o teste ao lado do código, estava errado: o hook pode separar os papéis pelo nome `*.test.ts`. O mantenedor decidiu pelo híbrido.
- **Resultado:** unitários ao lado do arquivo testado; integração em `test/integration/<área>/`; helpers e fixtures em `test/`; o `.dockerignore` deixa os testes fora da imagem. O hook, os três agentes, o `AGENTS.md`, o `CONVENTIONS.md`, o `FND-08`, o `vitest.config.ts` e o `tsconfig.json` mudaram juntos (linha "Testes" da tabela de ferramentas, que substitui a escolha do PR #1).
- **Verificação:**
  - fontes primárias: o Rust Book (unitário junto do código para testar a unidade isolada; integração numa pasta à parte, pela interface pública), o guia de estilo do Angular ("Unit tests should live in the same directory as the code-under-test"), o artigo de Kent C. Dodds sobre colocação e a documentação do `go build`, que ignora os `_test.go`;
  - o hook, chamado direto com onze pares de agente e caminho, decidiu cada um como esperado.

### Decisões do implementer conferidas com o mantenedor

- **Pedido:** o `implementer` escreveu o código do M1 e listou as decisões que tomou sem a spec fixá-las; três dependiam do mantenedor.
- **O que a IA fez e o que ficou:**
  - **Sem migração da loja no M1.** O plano aprovado previa "uma migração mínima da loja", mas nenhum critério do M1 usa tabela da loja, e uma migração na `main` não pode mais ser editada. A primeira tabela da loja nasce no M2, com o teste que a usa.
  - **`pino-http` removido.** O pino continua como a biblioteca de log; o `pino-http` só gera o log da requisição, e o middleware do projeto já o faz junto com o span e a métrica. A auto-instrumentação do OpenTelemetry, que dispensaria os spans manuais, depende em ESM do `module.register()`, descontinuado no Node 26 (DEP0205), e a AD-008 continua valendo.
  - **Exportador de traces desligado por padrão,** ligado com `OTEL_TRACES_EXPORTER=console` ou `otlp`. O design dizia "console em desenvolvimento", o que encheria o log com o healthcheck a cada 2 s; o design foi corrigido.
- **Corrigido:** as actions do CI estavam na v4; a AD-011 pede a última estável, e foram para a v7 (degrau 1 da escada).
- **Verificação:** a documentação do OpenTelemetry (logs pelas bibliotecas existentes; logs em JS "em desenvolvimento"), a do Node 26 (`module.register`) e a do `pino-http`; a comparação de pino, winston, bunyan e LogTape no npm; `npm test` com 125 testes verdes, inclusive o compose real.
