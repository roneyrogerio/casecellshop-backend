# Contribuir

Como preparar a máquina, rodar as checagens e abrir um PR. O que o projeto é e como rodá-lo está no [`README.md`](README.md); as convenções de código, testes, commits e escrita, no [`CONVENTIONS.md`](.specs/codebase/CONVENTIONS.md).

## Pré-requisitos

- Docker, com o Compose v2.20.2 ou mais novo.
- Node.js a partir da 24.12; a versão de referência é a do [`.nvmrc`](.nvmrc), que o `nvm use` escolhe. Abaixo do piso, `npm install` e `npm test` param com o erro `EBADDEVENGINES` (npm 10.9 ou mais novo). O Node roda o TypeScript direto, sem build.

## Checagens

| Comando | O que roda | Quando |
| --- | --- | --- |
| `npm run verify:fast` | lint, tipos, código sem uso, código repetido e os testes ligados aos arquivos mudados | durante o trabalho; é o que o hook de parada dos agentes roda |
| `npm run verify` | lint, formato, tipos, testes unitários, OpenAPI, código sem uso, código repetido e as conferências do repositório | no `pre-push` do repositório |
| `npm run verify:full` | o `verify` mais os testes de integração, com Docker | antes de um PR sair do rascunho |

O formato do código é o do Prettier (`AI-34`): `npm run format` formata o repositório e `npm run format:check` só confere. Os commits que só reformataram estão no [`.git-blame-ignore-revs`](.git-blame-ignore-revs), que o GitHub já usa; para o `git blame` local pular esses commits também, rode uma vez `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

Outros comandos: `npm run lint`, `npm run typecheck`, `npm run check:unused` (knip), `npm run check:duplication` (jscpd), `npm run openapi` (gera o `openapi.yaml` a partir do contrato), `npm run lint:openapi` e `npm run check:instructions`. O CI tem seis jobs: `Mudanças do PR` decide se o PR só muda arquivos de texto que nenhum teste lê (a lista `DOCS_ONLY_PATHS` do `ci.yml`, AI-53) e, nesse caso, os dois jobs `Node` são pulados; `Checagens` roda uma vez o que não depende da versão do Node (lint, formato, tipos, código sem uso e repetido, `npm audit`, OpenAPI e as conferências do repositório); `Node nvmrc` e `Node 24.12.0` rodam os testes, menos, na 24.12, os que sobem o `docker compose`, cuja imagem já fixa o Node 26, e a cobertura só no `.nvmrc`; `Workflows` confere os arquivos de `.github/workflows/` com o actionlint e o zizmor, que não rodam no pre-push; `Fuzzing da API` roda o Schemathesis do compose contra a API, com a semente fixa; e `ci-ok` junta os resultados e é o check que o merge exige. Fora do CI do PR: o CodeQL (`codeql.yml`) analisa o TypeScript no PR e toda semana; o Dependabot abre os PRs de atualização do npm, das actions e das imagens do `compose.yaml` com 7 dias de espera; e o `nightly.yml` roda todo dia, na `main`, as checagens do job `Checagens`, a suíte com cobertura, os tipos do banco, a suíte com a ordem embaralhada e o fuzzing da API com a semente da execução, e abre uma issue quando algo falha. Onde e por que cada checagem roda está na linha "Momento de cada checagem" do [`STATE.md`](.specs/project/STATE.md).

No VS Code, instale as extensões que o projeto recomenda (`.vscode/extensions.json`): o Prettier e o oxlint mostram o formato e o lint enquanto você escreve, com a configuração do repositório. Com outro editor, o pre-push e o CI conferem o mesmo.

Repetição de código já existente fica na linha de base `.jscpd-baseline.json`; quando você tira uma, atualize a base com `node_modules/.bin/jscpd --config .jscpd.json --baseline .jscpd-baseline.json --update-baseline`. O piso de cobertura fica no `coverage-floor.json`, que o `vitest.config.ts` importa, e só sobe: no PR, o `scripts/check-baselines.ts` o compara com o da `main` e confere a cobertura medida contra o piso da `main` (`AI-49`).

O fuzzing da API (FND-16) roda pelo mesmo serviço do CI: `install -d -m 0777 schemathesis-report && docker compose --profile fuzz run --rm schemathesis`, com `FUZZ_SEED` e `FUZZ_MAX_EXAMPLES` opcionais; o relatório JUnit fica em `schemathesis-report/`. O `install -d` cria o diretório com escrita para a imagem, que roda como uid 1000; no Linux, sem ele, o diretório montado nasce do root e o Schemathesis sai sem rodar.

Os volumes do compose guardam o banco e as mensagens do ElasticMQ entre execuções. Se o histórico de migrações deixar de bater com o banco local, como na troca de migrador da AD-017, recrie os volumes uma vez com `docker compose down -v`.

As consultas e as migrações usam o Kysely com os tipos gerados do banco migrado: depois de uma migração nova, rode `node scripts/check-db-types.ts --write`. Uma coluna apagada ou renomeada quebra o `npm run typecheck`, e o CI confere que os tipos estão em dia (`FND-09`).

## Fluxo de trabalho

Cada marco segue a skill [`/marco`](.claude/skills/marco/SKILL.md): plano aprovado, testes antes do código, implementação, revisão independente e PR. As regras de todo agente estão no [`AGENTS.md`](AGENTS.md). A `main` só muda por PR, com o CI verde e a aprovação do mantenedor, impostos por um ruleset do GitHub.

## Sessões em paralelo

Cada sessão do Claude Code que muda arquivos trabalha na própria worktree, numa branch própria, para as edições não colidirem: `claude --worktree <nome>` (ou `claude -w <nome>`) cria a worktree em `.claude/worktrees/<nome>/` e abre a sessão nela. Dentro de uma sessão, o `implementer` e o `test-writer` já rodam cada um na própria worktree (AI-24). As sessões dividem o histórico do git, então nenhuma delas usa `git stash` sem uma marca própria, e o hook de parada não atribui a um agente o que outra sessão faz nas branches dela (AI-33).

## Preparar a máquina para os agentes

Os agentes agem no GitHub com a identidade escolhida em cada clone, pelo servidor MCP oficial, restrito às ferramentas do fluxo: sem merge, sem aprovação, sem escrita de arquivo (AD-013, AD-014).

1. Rode `npm run setup:local` e responda: com que conta os agentes agem no GitHub e, se for uma conta de máquina, o login e o token. A escolha fica no `.git/config` do clone, fora do repositório, e rodar o comando de novo reaproveita a escolha (é assim que se troca um token vencido). Também dá para passar a escolha direto:
   - **Conta de máquina (recomendado):** `npm run setup:local -- --identity bot --login <conta-do-bot>`. O comando pede o token clássico da conta (escopos `repo` e `workflow`) ao chaveiro do sistema, sem mostrá-lo, e o guarda no item `casecellshop-<conta>` (troque com `--keychain <item>`). Com uma conta separada, você aprova os PRs dos agentes.
   - **A sua própria conta:** `npm run setup:local -- --identity self`. Usa a credencial do GitHub que o git da máquina já tem. Os PRs saem no seu nome, e o GitHub não deixa o autor aprovar o próprio PR: com o ruleset atual, o merge trava.
2. Abra o Claude Code na pasta do projeto e aceite a confiança da pasta, uma vez.

O `.mcp.json` liga o MCP do GitHub, e o início de cada sessão ajusta o push à identidade escolhida e diz o que mais faltar (Node, dependências ou Docker), com o comando para resolver.

| Ambiente | Conta de máquina (`bot`) | A sua própria conta (`self`) |
| --- | --- | --- |
| macOS | Token no Chaveiro (`security`) | Sim |
| Linux com ambiente gráfico | Token no chaveiro do desktop (Secret Service, pelo `secret-tool` do pacote `libsecret-tools`) | Sim, com um credential helper do git |
| Linux sem chaveiro, contêiner, WSL | Com `--token-store file`: o token fica em `~/.config/casecellshop/`, com permissão 600 e sem cifra | Sim; no WSL, com o Git Credential Manager do Git for Windows |
| Windows nativo | Não; use o WSL | Sim, com o Git for Windows |

O setup diz o que falta em cada caso: o pacote a instalar, ou que não há chaveiro e quais são as saídas.

## Sessão do Claude Code na nuvem

A sessão em claude.ai/code roda numa VM que traz o Node 22 (o projeto pede o 26), sem `node_modules` e com o Docker parado. O `scripts/cloud-setup.ts` prepara tudo isso (AI-51, AD-028):

- instala pelo nvm o Node do `.nvmrc` e o põe na frente do PATH, nos comandos da sessão e nos hooks;
- roda o `npm ci` quando o lockfile ou a versão do Node muda;
- grava em `.build-ca.pem`, fora do git, o certificado do proxy da sessão, que o `Dockerfile` usa para o `npm ci` do build da imagem;
- sobe o Docker.

**Automático, sem configurar nada.** O hook de início de sessão (`.claude/settings.json`) roda o script em toda sessão na nuvem, antes do diagnóstico do ambiente. Na máquina, ele não faz nada. Sem o painel, uma sessão nova espera de 1 a 2 minutos no início, para baixar o Node e instalar as dependências; depois, cerca de 1 s.

**Opcional: o script de preparo do painel.** Para a sessão já começar pronta, cole uma vez em claude.ai/code, no menu do ambiente no título da sessão, **Edit cloud environment**, **Setup script**:

```bash
#!/bin/bash
for dir in casecellshop-backend /home/user/casecellshop-backend; do
  if [ -f "$dir/scripts/cloud-setup.ts" ]; then
    node "$dir/scripts/cloud-setup.ts" --setup-script
    break
  fi
done
exit 0
```

A nuvem roda esse script uma vez e guarda o disco (Node, dependências e imagens do Docker) para as sessões seguintes; ela só o roda de novo quando o texto muda ou a cada ~7 dias. O texto não precisa mudar: o que o projeto precisa muda no `scripts/cloud-setup.ts`, por commit, e o hook aplica a mudança na sessão seguinte.

**GitHub.** Na nuvem, o GitHub é a conta conectada ao ambiente (GitHub App do Claude ou `/web-setup`), e o `setup:local` não se aplica. O push precisa do GitHub App do Claude instalado no repositório pela conta dona dele. O servidor MCP do GitHub do `.mcp.json` não está na lista de rede padrão nem tem como receber o token lá (AD-013); na nuvem, o GitHub vem pelas ferramentas da própria sessão.
