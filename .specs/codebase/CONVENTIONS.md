# Convenções

Valem para todo o repositório, desde o primeiro commit.

- **Commits:** [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), no formato `<tipo>(<escopo>): <descrição>`.
  - O tipo fica em inglês, porque é a palavra fixa do padrão: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci` ou `chore`.
  - A descrição fica em português, com o verbo no presente, em minúscula, sem ponto final e com até 72 caracteres no cabeçalho. Exemplo: `feat(checkout): adiciona reserva atômica de estoque`.
  - O corpo explica a motivação.
  - O tipo no início separa feature, correção, teste e documentação no histórico.
- **Pull requests:** um por marco, com o título no formato do commit, a descrição em português pelo template ("o que a IA gerou / o que foi mudado / como foi verificado") e o merge feito por uma pessoa, sem squash, para o histórico mostrar o teste antes do código.
- **Branches:** `<tipo>/<assunto>`, em inglês, como `feat/checkout` ou `chore/ai-workflow`.
- **Testes:** ficam em `test/`, fora do `src/`, em arquivos `*.test.ts`, o padrão que o Vitest encontra sem configuração.
  - `test/unit/`: sem Docker (`npm run test:unit`);
  - `test/integration/`: com Testcontainers e supertest, uma pasta por área do `spec.md`, como `checkout/`, `orders/` e `catalog/`.
  - O Vitest separa os dois como *projects*, como no exemplo da documentação dele.
  - O nome de cada teste começa com o ID do critério que ele prova.
- **Idioma:**
  - **inglês** para o que é identificador ou instrução de máquina: nomes de arquivos, variáveis, funções, classes, métricas e eventos de log, códigos de erro da API, e as instruções lidas pela IA (`AGENTS.md`). Assim, os nomes do código ficam no mesmo idioma das bibliotecas e dos padrões que ele usa (HTTP, OpenTelemetry, Prometheus);
  - **português** para o que pessoas leem: comentários, mensagens de log e de erro, documentação, descrição de commits e de PRs.
