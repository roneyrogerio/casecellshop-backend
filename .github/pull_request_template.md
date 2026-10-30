## O que muda

<!-- Marco e resumo em até três linhas. -->

**Marco:**
**Critérios:** <!-- por exemplo, CHK-01 a CHK-12 -->

## Plano

<!-- O plano aprovado, uma linha por fatia, marcada quando o feat: dela fica verde e uma rodada de revisão a cobre. -->

- [ ] 

## Para o mantenedor ler (~10 min)

<!-- Só o que a máquina não decide por você. O resto está nos checks e no ruleset. -->

- A tabela critério × teste no resumo do CI: cada critério tem um teste cujo nome o prove?
- O texto das respostas do desafio que este marco tocou (as seções do `ARCHITECTURE.md` ligadas aos critérios `DOC-*`).
- Mudanças em specs, ADs, migrações e CI, se houver.

## O que a IA gerou

<!-- O que veio de cada agente (sessão principal, test-writer, implementer, reviewer), com o modelo, o esforço e o degrau de escalonamento de cada correção; os trailers Assisted-by dos commits mostram o mesmo. -->

## Registro do marco

<!-- Rodadas de revisão e achados por severidade; achados errados do reviewer; degraus usados; CI vermelho por causa; aprovações pedidas; 1 a 3 lições; pendências para o próximo plano. -->

## Como foi verificado

<!-- O que o CI e o ruleset garantem não se repete aqui: testes, lint, tipos, contrato, commits, limites das instruções e migrações são checks obrigatórios. Aqui fica só o que não é check. -->

- [ ] Os testes vieram antes do código (commit `test:` antes do `feat:` de cada fatia)
- [ ] A última rodada do `reviewer` cobre o HEAD, sem achado `alta` ou `média` aberto
- [ ] `/security-review`, quando o marco pede (M2 e entrega)
