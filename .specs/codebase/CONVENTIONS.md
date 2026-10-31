# Convenções

Valem para todo o repositório, desde o primeiro commit.

- **Commits:** [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), no formato `<tipo>(<escopo>): <descrição>`.
  - O tipo fica em inglês, porque é a palavra fixa do padrão: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci` ou `chore`.
  - A descrição fica em português, com o verbo no presente, começando em minúscula (nomes próprios no meio ficam como são) e sem ponto final, com o cabeçalho até 100 caracteres: as regras do `@commitlint/config-conventional`, sem regras próprias, conferidas no CI e por um hook `commit-msg` local. Exemplo: `feat(checkout): adiciona reserva atômica de estoque`.
  - O corpo explica a motivação.
  - Um commit feito com IA leva dois trailers: `Co-Authored-By` com o modelo e `Assisted-by: <papel>:<modelo> effort=<nível> step=<degrau>`, na convenção do kernel Linux, para o histórico mostrar quem produziu cada commit. O autor do commit é o mantenedor, que responde por ele.
  - O tipo no início separa feature, correção, teste e documentação no histórico.
- **Pull requests:** um por marco (ou dois, se o plano passar do corte de tamanho), aberto em rascunho pela identidade configurada no clone (`AI-14`; a conta de máquina, no modo `bot`), com o plano aprovado como checklist e o título no formato do commit (AD-013).
  - O único comentário é o relatório do `reviewer`, um por rodada, idêntico ao que ele escreveu.
  - O mantenedor aprova no GitHub, e o ruleset exige essa aprovação sobre o último push; a aprovação liga o auto-merge, e o merge é por merge commit, sem squash, para o histórico mostrar o teste antes do código.
  - Sem issues: o trabalho parte do marco no `ROADMAP.md` e dos critérios no `spec.md`.
  - Título, descrição e comentários ficam em português, com identificadores, caminhos, comandos e IDs como estão.
  - O passo a passo de cada marco está na skill `/marco`.
- **Branches:** `<tipo>/<assunto>`, em inglês, como `feat/checkout` ou `chore/ai-workflow`.
- **Pastas do código (AD-025):** uma pasta por capacidade do negócio, uma por tecnologia de fronteira, uma para o que todo o código usa, e uma entrada por processo.

  | Pasta | Tipo | O que guarda |
  | --- | --- | --- |
  | `src/main/` | entradas | Um arquivo por processo (`api.ts`, `worker.ts`, `runbook.ts`, `migrate.ts`): lê a configuração, monta as dependências e liga o processo. Nenhuma regra de negócio |
  | `src/app.ts` | composição | A fábrica do app HTTP, sem abrir porta, que a API e os testes usam |
  | `src/checkout/`, `src/orders/`, `src/health/`, `src/billing/`, `src/catalog/` (M4) | negócio | Tudo de uma capacidade: rotas, consultas, e os laços e comandos que rodam fora da requisição (o relay, o worker, a reconciliação e o runbook ficam em `billing/`) |
  | `src/erp/`, `src/db/`, `src/queue/`, `src/http/`, `src/cache/` (M4) | fronteira | A porta e o adaptador de cada tecnologia: o ERP (com o simulado em `erp/sim/`), o PostgreSQL, o SQS, o Express e o cache em processo |
  | `src/contract/` | contrato | Os schemas em zod da API e da mensagem do faturamento; o `openapi.yaml` sai daqui |
  | `src/shared/` | transversal | Relógio, configuração, encerramento, logs, telemetria, identidade do serviço e semáforo |

  - As dependências seguem um sentido só: `main/` e `app.ts` montam tudo; o negócio usa a fronteira, o contrato e o `shared/`; a fronteira e o `shared/` não importam pastas de negócio, e uma pasta de negócio não importa o interior de outra.
  - Arquivo novo entra na pasta da capacidade ou da tecnologia que ele serve. Uma pasta nova de negócio nasce com o marco que traz a capacidade, nunca uma pasta por camada (`services/`, `repositories/`) ou genérica (`utils/`).
  - As migrações ficam fora de `src/`, em `migrations/<schema>/`, e os scripts do repositório em `scripts/`.
  - O sentido das dependências e a ausência de ciclos são conferidos pelo `npm run lint` (`no-restricted-imports` por pasta e `import/no-cycle`, AD-026).
- **Tamanho e forma do código (AD-026):** conferidos pelo `npm run lint` em `src/`, contando só linhas com código (sem linhas em branco nem comentários).

  | Medida | Limite | Regra do oxlint |
  | --- | --- | --- |
  | Linhas por arquivo | 300 | `max-lines` |
  | Linhas por função | 50 | `max-lines-per-function` |
  | Complexidade ciclomática por função | 10 | `complexity` |
  | Níveis de aninhamento de blocos | 4 | `max-depth` |
  | Parâmetros por função; acima disso, um objeto de opções | 4 | `max-params` |
  | Callbacks aninhados | 4 | `max-nested-callbacks` |

  - Quando um limite é ultrapassado, a função ou o arquivo é dividido por responsabilidade. O limite não sobe e a regra não é desligada num arquivo sem uma AD que diga por quê.
  - Nos testes, `describe` e `it` são funções, então os limites de linhas por arquivo, linhas por função e callbacks aninhados não valem para `*.test.ts`.
  - Em `src/`, as variáveis de ambiente são lidas só em `src/shared/config.ts` (`node/no-process-env`).
- **Testes:** arquivos `*.test.ts`, os unitários ao lado do arquivo que testam e os de integração em `test/integration/<área>/`, com o nome começando pelo ID do critério. A pasta é a área do `spec.md` em inglês: `foundation/` (Fundação), `checkout/` (Checkout), `billing/` (Processamento assíncrono), `catalog/` (Vitrine e sincronização) e `observability/` (Observabilidade); os testes da Fábrica agêntica ficam ao lado do script ou do hook que testam, ou em `test/repo/` quando testam a configuração do repositório. Ajudantes ficam em `test/helpers/` e dados de teste em `test/fixtures/`, com nomes em inglês como o resto dos arquivos. As regras completas estão em `.claude/rules/tests.md`, que o Claude Code carrega quando um teste é lido ou escrito.
- **Instruções da IA:** o `AGENTS.md` traz só o que toda tarefa usa e chega aos agentes pelo `CLAUDE.md`; o roteiro do marco fica na skill `/marco`, carregada sob demanda; os trilhos (guardas, hook de parada, permissões, GitHub pelo MCP) estão no `.claude/settings.json` e nas AD-012 e AD-013.
- **Idioma:**
  - **inglês** para o que é identificador ou instrução de máquina: nomes de arquivos, variáveis, funções, classes, métricas e eventos de log, códigos de erro da API, e as instruções lidas pela IA (`AGENTS.md`). Assim, os nomes do código ficam no mesmo idioma das bibliotecas e dos padrões que ele usa (HTTP, OpenTelemetry, Prometheus);
  - **português** para o que pessoas leem: comentários, mensagens de log e de erro, documentação, descrição de commits e de PRs;
  - um **prompt citado** literalmente mantém o idioma em que foi escrito, num bloco de código, como código; a explicação ao redor fica em português.
