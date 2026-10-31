## Resumo de decisão

<!-- Até ~300 palavras. O mantenedor lê só este bloco, em 2 a 5 minutos (AD-023). -->

**Entrega:** <!-- uma frase: marco, critérios e o que fica de fora -->

**Precisa do seu julgamento:** <!-- ADs novas ou substituídas, exceções, SPEC_DEVIATION, o trecho alterado de uma resposta DOC-*, riscos residuais; ou "nada" -->

**Evidência de máquina:**

- CI:
- critérios com teste: <!-- N de N; critério sem teste ou teste alterado, listado -->
- última revisão: <!-- APROVADO, 0 alta e 0 média -->
- `/security-review`:
- `app-check`:
- testes apagados, pulados ou afrouxados: <!-- não -->

**Áreas de risco tocadas:** migração <!-- sim/não --> · concorrência · contrato · CI e permissões <!-- cada "sim" com link para o trecho -->

## Plano

<!-- O plano aprovado, uma linha por fatia, marcada quando o feat: dela fica verde e uma rodada de revisão a cobre. -->

- [ ] 

## O que a IA gerou

<!-- O que veio de cada agente (sessão principal, test-writer, implementer, reviewer), com o modelo, o esforço e o degrau de escalonamento de cada correção; os trailers Assisted-by dos commits mostram o mesmo. -->

## Registro do marco

<!-- Rodadas de revisão e achados por severidade; achados errados do reviewer; degraus usados; CI vermelho por causa; aprovações pedidas; 1 a 3 lições; pendências para o próximo plano. -->

## Como foi verificado

<!-- O que o CI e o ruleset garantem não se repete aqui: testes, lint, tipos, contrato, commits, limites das instruções e migrações são checks obrigatórios. Aqui fica só o que não é check. -->

- [ ] Os testes vieram antes do código (commit `test:` antes do `feat:` de cada fatia)
- [ ] A última rodada do `reviewer` cobre o HEAD, sem achado `alta` ou `média` aberto
- [ ] `/security-review`, quando o marco pede (M2 e entrega)
