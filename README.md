# CaseCellShop backend

Serviço entre a loja virtual da CaseCellShop e um ERP legado que não pode ser alterado. Ele serve o catálogo do próprio banco, por um cache em memória; reserva o estoque de forma atômica no checkout; e envia os pedidos ao ERP de forma assíncrona, por uma outbox. O ERP é simulado dentro do processo, atrás da porta `ErpClient`.

**Estado:** M1 (Fundação) e F1 (Fábrica v2) concluídos; o próximo marco é o M2 (Checkout). O esqueleto roda, testa e passa no CI, com o contrato, as migrações, o ERP simulado, a telemetria e o compose, e o fluxo de IA se verifica sozinho. As regras de negócio entram nos marcos seguintes do [`ROADMAP.md`](.specs/project/ROADMAP.md).

## Pré-requisitos

- Docker, com o Compose v2.20.2 ou mais novo;
- Node.js a partir da 24.12; a versão de referência é a do [`.nvmrc`](.nvmrc) (26.13.0). O Node roda o TypeScript direto, sem build.

## Subir

```sh
docker compose up --build
```

Sobem o PostgreSQL, as migrações (que terminam antes de a API e o worker subirem), a API, o worker e o Jaeger.

| O quê | Endereço |
| --- | --- |
| API | `http://localhost:3000` (`GET /health`) |
| Métricas da API | `http://localhost:3000/metrics` |
| Traces (Jaeger) | `http://localhost:16686`, serviço `casecellshop-api` |

As portas mudam com `API_PORT` e `JAEGER_UI_PORT`. O [`requests.http`](requests.http) tem as requisições de exemplo.

## Testar

```sh
npm ci
npm test            # tudo, com PostgreSQL e compose reais no Docker
npm run test:unit   # só os unitários, sem Docker
```

Os testes que tocam o banco rodam contra um PostgreSQL real, pelo Testcontainers: o que se prova é o comportamento do banco, como lock, transação e índice único, e um mock não o reproduz.

A partir do M2, as consultas são escritas pelo Kysely, com os tipos gerados do banco migrado: uma coluna apagada ou renomeada numa migração quebra o `npm run typecheck`, e o CI confere que os tipos estão em dia (`FND-09`).

Outros comandos: `npm run lint`, `npm run typecheck`, `npm run openapi` (gera o `openapi.yaml` a partir do contrato), `npm run lint:openapi` e `npm run check:instructions`. O CI roda todos, no Node do `.nvmrc` e na 24.12. `npm run verify` roda o mesmo sem os testes de integração, em cerca de um minuto, e é o que o `pre-push` do repositório executa; `npm run verify:full` inclui a integração, com o Docker.

## Critérios do M1

| Critério | O que garante | Onde | Teste |
| --- | --- | --- | --- |
| `FND-01` | `docker compose up` sobe tudo, com as migrações antes da API e do worker | [`compose.yaml`](compose.yaml), [`src/main/migrate.ts`](src/main/migrate.ts) | [`compose.test.ts`](test/integration/foundation/compose.test.ts) |
| `FND-02` | `npm test` passa local e no CI | [`ci.yml`](.github/workflows/ci.yml) | O CI e a execução local registrada no PR |
| `FND-03` | Requisição fora do contrato recebe `400` em `application/problem+json`, com o `correlationId` | [`src/http/`](src/http/) | [`contract-validation.test.ts`](test/integration/foundation/contract-validation.test.ts) |
| `FND-04` | A fatura do ERP simulado continua lá depois de o worker reiniciar | [`src/erp/sim/`](src/erp/sim/) | [`erp-sim.test.ts`](test/integration/foundation/erp-sim.test.ts) |
| `FND-05` | O span do repositório sai como filho do span da requisição | [`src/telemetry.ts`](src/telemetry.ts), [`src/health/repository.ts`](src/health/repository.ts) | [`tracing.test.ts`](test/integration/foundation/tracing.test.ts) |
| `FND-06` | O CI falha se uma instrução que o Claude Code carrega em toda sessão passar do limite dele | [`scripts/check-instructions.ts`](scripts/check-instructions.ts) | [`check-instructions.test.ts`](scripts/check-instructions.test.ts) |
| `FND-07` | O CI falha se o `openapi.yaml` divergir do contrato ou não passar no lint | [`src/contract/`](src/contract/), [`scripts/generate-openapi.ts`](scripts/generate-openapi.ts) | [`generate-openapi.test.ts`](scripts/generate-openapi.test.ts) |
| `FND-08` | A guarda de caminho limita o que cada agente de IA edita | [`.claude/hooks/path-guard.mjs`](.claude/hooks/path-guard.mjs) | [`path-guard.test.ts`](.claude/hooks/path-guard.test.ts) |

Os testes unitários ficam ao lado do arquivo que testam; os de integração, em `test/integration/<área>/`.

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): o diagnóstico dos três problemas, os caminhos comparados, a arquitetura de 30 a 90 dias e a nuvem como hipótese.
- [`openapi.yaml`](openapi.yaml): o contrato HTTP em OpenAPI 3.1, gerado do zod em [`src/contract/`](src/contract/).
- [`.specs/`](.specs/README.md): visão, marcos, decisões (`AD-NNN`), critérios de aceite e design.
- [`PROMPTS.md`](PROMPTS.md): onde estão os prompts que governam a IA (as instruções versionadas dos agentes) e por que o projeto não mantém um diário de prompts.
- [`AGENTS.md`](AGENTS.md): as regras que todo agente de IA segue; o passo a passo de cada marco está na skill [`/marco`](.claude/skills/marco/SKILL.md).

## Como o projeto é feito com IA

O código é escrito por agentes do Claude Code, e a confiança vem de verificação automática e independente, não de revisão humana linha a linha (AD-012 e AD-013 em [`STATE.md`](.specs/project/STATE.md)):

- **Testes antes do código.** Um agente escreve os testes a partir dos critérios, sem ler a implementação. Outro implementa, sem poder alterar os testes, o CI nem as configurações que decidem se o trabalho está certo.
- **O agente não termina com checagem vermelha.** Um hook o devolve ao trabalho enquanto o lint, os tipos ou os testes falharem.
- **Revisão independente.** Um terceiro agente, só leitura, revisa cada fatia, e o relatório vai ao PR como foi escrito.
- **Os agentes agem no GitHub com a identidade escolhida em cada clone,** de preferência uma conta de máquina separada da sua, pelo servidor MCP oficial, restrito às ferramentas do fluxo: sem merge, sem aprovação, sem escrita de arquivo.
- **A `main` só muda por PR,** com os checks verdes e a aprovação do mantenedor, impostos por um ruleset do GitHub. A aprovação liga o auto-merge.

**Configurar uma máquina** (terminal ou VS Code):

1. Rode `npm run setup:local` e responda às perguntas: com que conta os agentes agem no GitHub e, se for uma conta de máquina, o login e o token. A escolha fica no `.git/config` do clone, fora do repositório, e rodar o comando de novo reaproveita a escolha (é assim que se troca um token vencido). Também dá para passar a escolha direto:
   - **Conta de máquina (recomendado):** `npm run setup:local -- --identity bot --login <conta-do-bot>`. O comando pede o token clássico da conta (escopos `repo` e `workflow`) ao chaveiro do sistema, sem mostrá-lo, e o guarda no item `casecellshop-<conta>` (troque com `--keychain <item>`). Com uma conta separada, você aprova os PRs dos agentes.
   - **A sua própria conta:** `npm run setup:local -- --identity self`. Usa a credencial do GitHub que o git da máquina já tem. Os PRs saem no seu nome, e o GitHub não deixa o autor aprovar o próprio PR: com o ruleset atual, o merge trava.
2. Abra o Claude Code na pasta do projeto e aceite a confiança da pasta, uma vez.

Pronto: o `.mcp.json` liga o MCP do GitHub sozinho, e o início de cada sessão ajusta o push à identidade escolhida e diz o que mais faltar, como Node, dependências ou Docker, com o comando para resolver.

Onde cada modo funciona:

| Ambiente | Conta de máquina (`bot`) | A sua própria conta (`self`) |
| --- | --- | --- |
| macOS | Token no Chaveiro (`security`) | Sim |
| Linux com ambiente gráfico | Token no chaveiro do desktop (Secret Service, pelo `secret-tool` do pacote `libsecret-tools`) | Sim, com um credential helper do git |
| Linux sem chaveiro, contêiner, WSL | Com `--token-store file`: o token fica em `~/.config/casecellshop/`, com permissão 600 e sem cifra | Sim; no WSL, com o Git Credential Manager do Git for Windows |
| Windows nativo | Não; use o WSL | Sim, com o Git for Windows |

O setup diz o que falta em cada caso (o pacote a instalar, ou que não há chaveiro e quais são as saídas). Foi conferido num contêiner Debian sem chaveiro, nos dois modos.

Na sessão do Claude Code na nuvem, o GitHub é a conta conectada ao ambiente (GitHub App do Claude ou `/web-setup`), e o `setup:local` não se aplica. O diagnóstico também roda lá, mas o ambiente ainda não está preparado: a imagem traz o Node 22 (o projeto pede o 26), o Docker precisa ser iniciado a cada sessão, e o servidor MCP do GitHub não está na lista de rede padrão nem tem como receber o token lá (AD-013).

## Licença

[MIT](LICENSE).
