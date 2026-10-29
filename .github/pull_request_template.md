## O que muda

<!-- Marco e resumo em até três linhas. -->

**Marco:**
**Critérios:** <!-- por exemplo, CHK-01 a CHK-12 -->

## Plano

<!-- O plano aprovado do marco, uma linha por item, marcada quando a parte entra. -->

- [ ] 

## O que a IA gerou

<!-- O que veio de cada agente (planner, test-writer, implementer, reviewer) e, em cada correção, o degrau do escalonamento usado. Os prompts principais entram no PROMPTS.md. -->

## O que foi mudado

<!-- O que foi corrigido, rejeitado ou reescrito depois da geração, e por quê. -->

## Como foi verificado

- [ ] Os testes vieram antes do código (commit `test:` antes do `feat:`)
- [ ] CI verde: lint, tipos, testes e limite de tamanho das specs
- [ ] `reviewer` sem achado de severidade alta pendente
- [ ] Specs atualizadas neste PR, sem editar ADR aceita
- [ ] `/security-review`, quando o marco pede (M2 e entrega)
- [ ] `/doctor prompt-audit`, quando o PR muda o `AGENTS.md`, o `CLAUDE.md` ou o `.claude/`

<!-- Comandos rodados e resultados relevantes. -->
