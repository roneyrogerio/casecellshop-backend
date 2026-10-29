# Especificações

O que construir e por quê fica escrito e versionado antes do código. Cada teste aponta para o critério de aceite que comprova.

| Arquivo | Responde |
| --- | --- |
| [`project/PROJECT.md`](project/PROJECT.md) | O que é o sistema, as metas, o escopo, as hipóteses e as premissas de carga |
| [`project/ROADMAP.md`](project/ROADMAP.md) | Como cada marco é feito, a ordem dos marcos e o critério de pronto de cada um |
| [`project/STATE.md`](project/STATE.md) | As decisões de projeto (`AD-NNN`), as escolhas de ferramenta, os riscos, as lições e as ideias adiadas |
| [`features/casecellshop/spec.md`](features/casecellshop/spec.md) | A lista única de critérios de aceite com ID (`FND`, `CHK`, `ORD`, `CAT`, `OBS`, `DOC`) |
| [`features/casecellshop/design.md`](features/casecellshop/design.md) | Como construir: componentes, dados, consultas, contrato, observabilidade e parâmetros |
| [`codebase/CONVENTIONS.md`](codebase/CONVENTIONS.md) | As convenções do repositório: commits, pull requests, branches, testes, idioma e instruções da IA |
| `openapi.yaml` (raiz, criado no M1) | O contrato HTTP. Os testes validam requisições e respostas contra ele |
| `ARCHITECTURE.md` (raiz, criado no M1) | O diagnóstico, a arquitetura alvo e o porquê de cada bloco, por tema |

## Como manter as specs

**O que vai em cada arquivo.** Visão, metas, escopo e hipóteses no `PROJECT`; marcos no `ROADMAP`; decisões de projeto, riscos, lições e ideias adiadas no `STATE`; critérios com ID no `spec.md`; o "como" no `design.md`; convenções no `CONVENTIONS`.

**Limite de tamanho**, em palavras. O CI falha acima dele (`FND-06`):

| Arquivo | Limite |
| --- | --- |
| `PROJECT.md` | 1.200 |
| `ROADMAP.md` | 1.800 |
| `STATE.md` | 6.000 |
| `spec.md` | 3.000 |
| `design.md` | 4.800 |
| `CONVENTIONS.md` | 1.800 |

**Mudanças.**

- Toda mudança na spec entra pelo PR do marco que a causou.
- Uma decisão aceita não é editada: uma nova `AD-NNN` a substitui, e a antiga passa a "substituída por AD-NNN".
- Um desvio entre a spec e o código, achado pelo `planner` ou na implementação, fica marcado `SPEC_DEVIATION` no critério até ser resolvido no mesmo PR.
- Perto do limite de um arquivo, o texto é consolidado; nada é apagado sem ir para o arquivo certo.

A estrutura separa o que muda em ritmos diferentes: a visão, a ordem de entrega, as decisões, os critérios e o "como". As decisões usam o formato ADR (contexto, decisão, alternativas consideradas, trade-off e quando rever), para que a alternativa descartada e o motivo continuem visíveis quando o código mudar. A estrutura é adaptada da skill [`tlc-spec-driven`](https://github.com/tech-leads-club/agent-skills) v2.0.0 (TechLeads.club), sob a licença CC-BY-4.0, que exige esta atribuição.
