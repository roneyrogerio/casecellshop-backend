# Prompts de IA

Este projeto não mantém um diário de prompts. A IA aqui não trabalha por pedidos avulsos: trabalha por um fluxo fixo, em que cada marco tem um plano aprovado, critérios de aceite, testes escritos antes do código por um agente e implementação por outro, e uma revisão independente. Os prompts que de fato direcionam a IA são as instruções desse fluxo, e elas estão versionadas no próprio repositório.

## Onde estão os prompts relevantes

| Prompt | Arquivo | Quando entra |
| --- | --- | --- |
| Regras de todo agente, em toda sessão | [`AGENTS.md`](AGENTS.md), carregado pelo [`CLAUDE.md`](CLAUDE.md) | sempre |
| Roteiro de cada marco: plano, delegação, revisão e PR | [`.claude/skills/marco/SKILL.md`](.claude/skills/marco/SKILL.md) | quando o marco começa |
| Pedido de cada delegação (o mapa da tarefa: critérios, trechos da spec, arquivos) | modelo na seção "Plan" da mesma skill | em cada chamada de agente |
| Papel de quem escreve os testes | [`.claude/agents/test-writer.md`](.claude/agents/test-writer.md) | antes do código |
| Papel de quem implementa | [`.claude/agents/implementer.md`](.claude/agents/implementer.md) | depois dos testes |
| Papel de quem revisa | [`.claude/agents/reviewer.md`](.claude/agents/reviewer.md) | em cada rodada de revisão |
| Convenções de teste | [`.claude/rules/tests.md`](.claude/rules/tests.md) | quando um teste é lido ou escrito |

## Por que não há diário

- **As instruções acima governam o que a IA faz.** Elas só mudam por PR, com CI e revisão, e o histórico delas está no git. Um diário de prompts repetiria o que já está versionado e envelheceria a cada marco.
- **O que direcionou e corrigiu a IA fica onde é conferido:**
  - a intenção, nos critérios do [`spec.md`](.specs/features/casecellshop/spec.md) e no plano aprovado de cada PR;
  - as decisões e as alternativas descartadas, nas ADs e na tabela de ferramentas do [`STATE.md`](.specs/project/STATE.md);
  - os erros da IA e as correções, nos relatórios do revisor postados em cada PR e nas mensagens dos commits que os corrigiram;
  - quem fez cada commit (sessão principal ou qual agente, com modelo, esforço e degrau da escada), nos trailers `Assisted-by`.
- **O controle não depende de ler prompts.** Os testes nascem antes do código, escritos por outro agente; um hook impede o agente de terminar com checagem vermelha; guardas impedem cada papel de mexer no que não é dele; e o merge só acontece com o CI verde e a aprovação do mantenedor. O fluxo e os motivos estão na AD-012 do [`STATE.md`](.specs/project/STATE.md).
