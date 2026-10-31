# Especificações

O que construir e por quê fica escrito e versionado antes do código. Cada teste aponta para o critério de aceite que comprova.

| Arquivo | Responde |
| --- | --- |
| [`project/PROJECT.md`](project/PROJECT.md) | O que é o sistema, as metas, o escopo, as hipóteses e as premissas de carga |
| [`project/ROADMAP.md`](project/ROADMAP.md) | A ordem dos marcos e o critério de pronto de cada um; como cada marco é feito está na skill `/marco` |
| [`project/STATE.md`](project/STATE.md) | As decisões de projeto (`AD-NNN`), as escolhas de ferramenta, os riscos, as lições e as ideias adiadas |
| [`project/STATE-ARCHIVE.md`](project/STATE-ARCHIVE.md) | A AD-007, substituída no M1 e guardada com o texto como foi aceito; não recebe mais nada |
| [`features/casecellshop/spec.md`](features/casecellshop/spec.md) | A lista única de critérios de aceite com ID (`FND`, `CHK`, `ORD`, `CAT`, `OBS`, `DOC`, `AI`) |
| [`features/casecellshop/design.md`](features/casecellshop/design.md) | Como construir: componentes, dados, consultas, contrato, observabilidade e parâmetros |
| [`codebase/CONVENTIONS.md`](codebase/CONVENTIONS.md) | As convenções do repositório: pastas do código, commits, pull requests, branches, testes, idioma e instruções da IA |
| `src/contract/` e `openapi.yaml` (criados no M1) | O contrato HTTP em zod e o OpenAPI 3.1 gerado dele. A validação e os testes usam os mesmos schemas |
| `ARCHITECTURE.md` (raiz, criado no M1) | O diagnóstico, a arquitetura alvo e o porquê de cada bloco, por tema |

## Como manter as specs

**O que vai em cada arquivo.** Visão, metas, escopo e hipóteses no `PROJECT`; marcos no `ROADMAP`; decisões de projeto, riscos, lições e ideias adiadas no `STATE`; critérios com ID no `spec.md`; o "como" no `design.md`; convenções no `CONVENTIONS`.

**Tamanho.** As specs não têm teto de palavras: os agentes as leem por trecho, guiados pelo mapa de cada tarefa, e não inteiras (AD-012). O que tem limite é o que o Claude Code carrega em toda sessão ou reanexa depois de compactar: o `AGENTS.md`, o `CLAUDE.md` e cada agente até 200 linhas; cada skill até 500 linhas e 12.000 bytes; e cada regra de `.claude/rules/` até 40.000 caracteres (`FND-06`). Para a leitura por trecho funcionar, cada assunto fica sob um título próprio e estável, e as ADs ficam em blocos `### AD-NNN`.

O `ARCHITECTURE.md` da raiz é a resposta conceitual do desafio, escrita para quem avalia, e não um documento que os agentes carregam em todo trabalho.

**Mudanças.**

- Toda mudança na spec entra pelo PR do marco que a causou, ou por um PR de decisão que o mantenedor aprova (como a troca da camada de dados e o alinhamento ao PDF); uma cláusula nova num critério que já passava leva o marco que a entrega.
- Um desvio entre a spec e o código, achado no plano ou na implementação, fica marcado `SPEC_DEVIATION` no critério até ser resolvido no mesmo PR.
- Um assunto repetido em dois arquivos é consolidado num só, e o outro aponta para ele.

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
- uma instrução de como fazer, que vai no `design.md`, no `AGENTS.md` ou na skill `/marco`.

**Onde.**

| Tipo | Onde |
| --- | --- |
| Produto ou arquitetura | `AD-NNN` no `STATE.md` |
| Ferramenta ou processo | Linha na tabela de ferramentas do `STATE.md` |
| Risco em aberto | Tabela de riscos do `STATE.md` |
| Erro que mudou o rumo | `L-NNN` no `STATE.md` |
| Instruções da IA | `AGENTS.md`, a skill e os agentes em `.claude/`; o `PROMPTS.md` explica por que não há diário de prompts |

**Estrutura de uma AD:**
- contexto;
- decisão;
- alternativas consideradas, cada uma com o motivo do descarte;
- trade-off;
- quando rever;
- referências, se houver.

**Ciclo:**
- a AD nasce "proposta" no PR que a cria e fica aceita com o merge dele; a substituída é marcada no mesmo PR;
- aceita, não é editada: uma nova AD a substitui, e as duas se apontam ("substituída por AD-NNN" / "substitui AD-NNN"); quando a nova muda só uma parte, "alterada pela AD-NNN" / "altera a AD-NNN".

**Fontes.**

- O motivo é escrito nos termos do projeto: as hipóteses (H1a–H4), os critérios, as ADs anteriores, os atributos de qualidade e as restrições. Ele se sustenta com todos os links removidos.
- Documentação, normas e livros entram em "Referências", como evidência verificável do que a decisão afirma.
- Como outro projeto ou empresa resolve o mesmo problema entra só como evidência: em "Alternativas consideradas", dizendo por que serve ou não serve aqui, ou em "Referências". Popularidade ("é o padrão", "a maioria usa") e autoridade ("a empresa X faz assim") nunca são o motivo.
- O texto descreve fatos, em voz ativa, sem narrar a pesquisa ("a pesquisa mostrou", "depois de pesquisar").

**Formato das referências.** Link descritivo, nunca URL solta, seguido do que a fonte sustenta nesta decisão:

| Fonte | Formato |
| --- | --- |
| Página ou seção | `[Autor ou organização, *Título*, seção](URL#âncora): o que sustenta` |
| Norma ou RFC | `[IETF, *RFC 9457*, seção 3](URL): o que sustenta` |
| Código de outro repositório | link permanente com o SHA do commit e as linhas (`/blob/<sha>/caminho#L10-L20`), nunca o de uma branch |
| Livro | `Autor, *Título*, edição, capítulo` |
| Página que muda (documentação de fornecedor, blog) | o formato da página, mais "consultado em DD/MM/AAAA" |

Dentro do repositório, cite o ID (`AD-NNN`, `ORD-11`, `H4`) e não a âncora de um título, que quebra quando o título muda. Mensagem de commit, README e comentário de código citam o ID da AD, sem link externo.

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
