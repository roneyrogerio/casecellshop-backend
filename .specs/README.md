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
| `src/contract/` e `openapi.yaml` (criados no M1) | O contrato HTTP em zod e o OpenAPI 3.1 gerado dele. A validação e os testes usam os mesmos schemas |
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

Dois arquivos ficam fora da tabela. O `project/STATE-ARCHIVE.md` guarda só ADs substituídas e nenhum agente o carrega, como na `tlc-spec-driven`. O `ARCHITECTURE.md` da raiz é a resposta conceitual do desafio, escrita para quem avalia, e não um documento que os agentes carregam em todo trabalho.

**Mudanças.**

- Toda mudança na spec entra pelo PR do marco que a causou.
- Um desvio entre a spec e o código, achado pelo `planner` ou na implementação, fica marcado `SPEC_DEVIATION` no critério até ser resolvido no mesmo PR.
- Perto do limite de um arquivo, o texto é consolidado; nada é apagado sem ir para o arquivo certo.

A estrutura separa o que muda em ritmos diferentes: a visão, a ordem de entrega, as decisões, os critérios e o "como". As decisões usam o formato ADR (contexto, decisão, alternativas consideradas, trade-off e quando rever), para que a alternativa descartada e o motivo continuem visíveis quando o código mudar. A estrutura é adaptada da skill [`tlc-spec-driven`](https://github.com/tech-leads-club/agent-skills) v2.0.0 (TechLeads.club), sob a licença CC-BY-4.0, que exige esta atribuição.

## Registro de decisões

**O que entra.** Uma decisão é registrada no PR em que é tomada quando:
- muda a estrutura, um atributo de qualidade, uma dependência, um contrato ou a forma de construir (biblioteca, ferramenta, processo);
- é cara de reverter;
- teve duas ou mais opções viáveis;
- ou corrige uma decisão ou premissa anterior.

**O que não entra:**
- uma escolha interna e fácil de refatorar, como um nome ou a organização dentro de um módulo;
- um detalhe que só segue uma decisão já registrada, que vai no `design.md`;
- uma instrução de como fazer, que vai no `design.md` ou no `AGENTS.md`.

**Onde.**

| Tipo | Onde |
| --- | --- |
| Produto ou arquitetura | `AD-NNN` no `STATE.md` |
| Ferramenta ou processo | Linha na tabela de ferramentas do `STATE.md` |
| Risco em aberto | Tabela de riscos do `STATE.md` |
| Erro que mudou o rumo | `L-NNN` no `STATE.md` |
| Uso de IA | `PROMPTS.md`, na raiz |

**Estrutura de uma AD:**
- contexto;
- decisão;
- alternativas consideradas, cada uma com o motivo do descarte;
- trade-off;
- quando rever;
- referências, se houver.

**Ciclo:**
- a AD nasce "proposta" no PR do marco e passa a "aceita" no último commit antes do merge, quando a substituída também é marcada;
- aceita, não é editada: uma nova AD a substitui, e as duas se apontam ("substituída por AD-NNN" / "substitui AD-NNN"); quando a nova muda só uma parte, "alterada pela AD-NNN" / "altera a AD-NNN";
- perto do limite do `STATE.md`, as ADs substituídas vão para `project/STATE-ARCHIVE.md`.

**Fontes.** O motivo é escrito nos termos do projeto (requisitos, restrições e trade-offs) e se sustenta sozinho. Documentação, normas e exemplos de outros projetos entram só em "Referências", como evidência verificável, nunca como o motivo.

**Modelos.** AD, no `STATE.md`:

```markdown
### AD-NNN · <a decisão em poucas palavras>

**Status:** proposta (DD/MM/AAAA); no último commit antes do merge, aceita (DD/MM/AAAA)

**Contexto.** <o problema e as restrições do projeto>

**Decisão.**

- <o que foi decidido>

**Alternativas consideradas:**

- **<alternativa>.** <por que foi descartada, nos termos do projeto>

**Trade-off.** <o que se perde com a escolha>

**Rever quando:** <o fato que reabre a decisão>

**Referências:** <opcional: documentação ou norma que confirma um fato>
```

Linha da tabela de ferramentas: `| Tema | Escolha | Descartado | Por quê |`.

Entrada do `PROMPTS.md`:

~~~markdown
### <assunto>

- **Pedido:** <o que foi pedido>
- **Prompt** (opcional): o texto literal, no idioma original:

  ```text
  <prompt>
  ```

- **O que a IA fez:** <o que ela produziu>
- **Corrigido** ou **Rejeitado:** <o que mudou e por quê, se mudou>
- **Resultado:** <o que ficou>
- **Verificação:** <teste, comando ou fonte que confirmou>
~~~
