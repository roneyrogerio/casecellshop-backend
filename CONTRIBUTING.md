# Contribuir

Como preparar a máquina, rodar as checagens e abrir um PR. O que o projeto é e como rodá-lo está no [`README.md`](README.md); as convenções de código, testes, commits e escrita, no [`CONVENTIONS.md`](.specs/codebase/CONVENTIONS.md).

## Pré-requisitos

- Docker, com o Compose v2.20.2 ou mais novo.
- Node.js a partir da 24.12; a versão de referência é a do [`.nvmrc`](.nvmrc), que o `nvm use` escolhe. Abaixo do piso, `npm install` e `npm test` param com o erro `EBADDEVENGINES` (npm 10.9 ou mais novo). O Node roda o TypeScript direto, sem build.

## Checagens

| Comando | O que roda | Quando |
| --- | --- | --- |
| `npm run verify:fast` | lint, tipos e os testes ligados aos arquivos mudados | durante o trabalho; é o que o hook de parada dos agentes roda |
| `npm run verify` | lint, tipos, testes unitários, OpenAPI e as conferências do repositório | no `pre-push` do repositório |
| `npm run verify:full` | o `verify` mais os testes de integração, com Docker | antes de um PR sair do rascunho |

Outros comandos: `npm run lint`, `npm run typecheck`, `npm run openapi` (gera o `openapi.yaml` a partir do contrato), `npm run lint:openapi` e `npm run check:instructions`. O CI roda tudo no Node do `.nvmrc` e de novo na 24.12, menos os testes que sobem o `docker compose`, cuja imagem já fixa o Node 26.

As consultas e as migrações usam o Kysely com os tipos gerados do banco migrado: depois de uma migração nova, rode `node scripts/check-db-types.ts --write`. Uma coluna apagada ou renomeada quebra o `npm run typecheck`, e o CI confere que os tipos estão em dia (`FND-09`).

## Fluxo de trabalho

Cada marco segue a skill [`/marco`](.claude/skills/marco/SKILL.md): plano aprovado, testes antes do código, implementação, revisão independente e PR. As regras de todo agente estão no [`AGENTS.md`](AGENTS.md). A `main` só muda por PR, com o CI verde e a aprovação do mantenedor, impostos por um ruleset do GitHub.

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

Na sessão do Claude Code na nuvem, o GitHub é a conta conectada ao ambiente (GitHub App do Claude ou `/web-setup`), e o `setup:local` não se aplica. O diagnóstico também roda lá, mas o ambiente ainda não está preparado: a imagem traz o Node 22 (o projeto pede o 26), o Docker precisa ser iniciado a cada sessão, e o servidor MCP do GitHub não está na lista de rede padrão nem tem como receber o token lá (AD-013).
