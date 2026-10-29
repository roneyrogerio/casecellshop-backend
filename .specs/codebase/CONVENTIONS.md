# Convenções

Valem para todo o repositório, desde o primeiro commit.

- **Commits:** [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), no formato `<tipo>(<escopo>): <descrição>`.
  - O tipo fica em inglês, porque é a palavra fixa do padrão: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci` ou `chore`.
  - A descrição fica em português, com o verbo no presente, em minúscula, sem ponto final e com até 72 caracteres no cabeçalho. Exemplo: `feat(checkout): adiciona reserva atômica de estoque`.
  - O corpo explica a motivação.
  - Um commit com contribuição relevante da IA leva o trailer `Co-Authored-By` do modelo, e a descrição do PR diz o que a IA gerou. Quem faz o merge revisou o resultado e responde por ele.
  - O tipo no início separa feature, correção, teste e documentação no histórico.
- **Pull requests:** um por marco, com o título no formato do commit, a descrição em português pelo template ("o que a IA gerou / o que foi mudado / como foi verificado") e o merge feito por uma pessoa, sem squash, para o histórico mostrar o teste antes do código.
  - O PR abre em rascunho no início do marco, com o plano aprovado como checklist na descrição, marcado conforme cada parte entra.
  - O único comentário é o parecer do `reviewer`, um por rodada. O andamento aparece nos commits e no checklist, e as falhas do CI ficam nos checks.
  - Sem issues: o trabalho parte do marco no `ROADMAP.md` e dos critérios no `spec.md`, que o PR cita.
  - Nenhum agente aprova nem pede mudanças: o PR sai da conta da pessoa responsável, que não pode aprovar o próprio PR, e o merge é decisão dela.
  - Título, descrição e comentários ficam em português, com identificadores, caminhos, comandos e IDs como estão.
- **Branches:** `<tipo>/<assunto>`, em inglês, como `feat/checkout` ou `chore/ai-workflow`.
- **Testes:** ficam em `test/`, fora do `src/`, em arquivos `*.test.ts`, o padrão que o Vitest encontra sem configuração.
  - `test/unit/`: sem Docker (`npm run test:unit`);
  - `test/integration/`: com Testcontainers e supertest, uma pasta por área do `spec.md`, como `checkout/`, `orders/` e `catalog/`.
  - O Vitest separa os dois como *projects*.
  - O nome de cada teste começa com o ID do critério que ele prova, seguido da descrição em português, como `CHK-01 50 checkouts simultâneos com estoque 5 aceitam exatamente 5`. As variáveis e funções do teste seguem em inglês.
- **Instruções da IA:**
  - o `AGENTS.md` é a fonte única. O `CLAUDE.md` só o importa (`@AGENTS.md`), para o Claude Code lê-lo também nas sessões que não leem o `AGENTS.md` direto;
  - o `AGENTS.md` fica abaixo de 200 linhas, porque carrega em toda sessão: quanto maior, mais contexto ocupa e menos é seguido. A mesma régua vale para cada agente de `.claude/agents/`;
  - cada agente tem um papel só, e a `description` dele é curta, porque as de todos carregam em toda sessão;
  - quando um desses arquivos muda, o `/doctor prompt-audit` roda antes do merge;
  - os limites de papel e as ações que pedem aprovação são aplicados pelo Claude Code, não só pela instrução (`.claude/settings.json`): um hook impede o `test-writer` de editar fora de `test/` e o `implementer` de editar testes, specs, contrato e instruções; commit, push e escrita no PR sempre pedem aprovação; merge, revisão de PR, issue, push forçado e leitura do `.env` são negados.
- **Idioma:**
  - **inglês** para o que é identificador ou instrução de máquina: nomes de arquivos, variáveis, funções, classes, métricas e eventos de log, códigos de erro da API, e as instruções lidas pela IA (`AGENTS.md`). Assim, os nomes do código ficam no mesmo idioma das bibliotecas e dos padrões que ele usa (HTTP, OpenTelemetry, Prometheus);
  - **português** para o que pessoas leem: comentários, mensagens de log e de erro, documentação, descrição de commits e de PRs.
