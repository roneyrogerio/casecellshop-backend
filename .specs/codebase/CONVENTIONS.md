# Convenções

Valem para todo o repositório, desde o primeiro commit.

- **Commits:** [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), no formato `<tipo>(<escopo>): <descrição>`.
  - O tipo fica em inglês, porque é a palavra fixa do padrão: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci` ou `chore`.
  - A descrição fica em português, com o verbo no presente, começando em minúscula (nomes próprios no meio ficam como são), sem ponto final e com até 72 caracteres no cabeçalho. O commitlint confere no CI (`commitlint.config.mjs`). Exemplo: `feat(checkout): adiciona reserva atômica de estoque`.
  - O corpo explica a motivação.
  - Um commit feito com IA leva dois trailers: `Co-Authored-By` com o modelo e `Assisted-by: <papel>:<modelo> effort=<nível> step=<degrau>`, na convenção do kernel Linux, para o histórico mostrar quem produziu cada commit. O autor do commit é o mantenedor, que responde por ele.
  - O tipo no início separa feature, correção, teste e documentação no histórico.
- **Pull requests:** um por marco (ou dois, se o plano passar do corte de tamanho), aberto em rascunho pela conta `honeyforge-bot`, com o plano aprovado como checklist e o título no formato do commit (AD-013).
  - O único comentário é o relatório do `reviewer`, um por rodada, idêntico ao que ele escreveu.
  - O mantenedor aprova no GitHub, e o ruleset exige essa aprovação sobre o último push; a aprovação liga o auto-merge, e o merge é por merge commit, sem squash, para o histórico mostrar o teste antes do código.
  - Sem issues: o trabalho parte do marco no `ROADMAP.md` e dos critérios no `spec.md`.
  - Título, descrição e comentários ficam em português, com identificadores, caminhos, comandos e IDs como estão.
  - O passo a passo de cada marco está na skill `/marco`.
- **Branches:** `<tipo>/<assunto>`, em inglês, como `feat/checkout` ou `chore/ai-workflow`.
- **Testes:** arquivos `*.test.ts`, os unitários ao lado do arquivo que testam e os de integração em `test/integration/<área>/`, com o nome começando pelo ID do critério. As regras completas estão em `.claude/rules/tests.md`, que o Claude Code carrega quando um teste é lido ou escrito.
- **Instruções da IA:** o `AGENTS.md` traz só o que toda tarefa usa e chega aos agentes pelo `CLAUDE.md`; o roteiro do marco fica na skill `/marco`, carregada sob demanda; os trilhos (guardas, hook de parada, permissões, GitHub pelo MCP) estão no `.claude/settings.json` e nas AD-012 e AD-013.
- **Idioma:**
  - **inglês** para o que é identificador ou instrução de máquina: nomes de arquivos, variáveis, funções, classes, métricas e eventos de log, códigos de erro da API, e as instruções lidas pela IA (`AGENTS.md`). Assim, os nomes do código ficam no mesmo idioma das bibliotecas e dos padrões que ele usa (HTTP, OpenTelemetry, Prometheus);
  - **português** para o que pessoas leem: comentários, mensagens de log e de erro, documentação, descrição de commits e de PRs;
  - um **prompt citado** literalmente mantém o idioma em que foi escrito, num bloco de código, como código; a explicação ao redor fica em português.
