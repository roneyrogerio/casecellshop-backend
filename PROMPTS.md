# Uso de IA

Registro do uso de IA neste repositório. Cada entrada traz o pedido, o que a IA produziu, o que foi aceito, corrigido ou rejeitado, e como foi verificado. Entram os pedidos que geraram código, spec ou decisão relevante e todo caso em que a saída da IA foi corrigida ou rejeitada; ajustes mecânicos, como formatação e renomeação, não entram. O fluxo de agentes está no [`AGENTS.md`](AGENTS.md). As decisões que saíram daqui estão no [`STATE.md`](.specs/project/STATE.md) e nas [convenções](.specs/codebase/CONVENTIONS.md).

## M0 — Planejamento

### Specs escritas com IA e revisadas por revisores independentes

- **Pedido:** escrever a visão, o roadmap, as decisões e os critérios antes do código, e revisá-los contra os requisitos.
- **O que a IA fez:** escreveu as specs. Cinco agentes revisores, em contexto limpo e sem ver as rodadas anteriores, revisaram em sete rodadas.
- **Triagem:** um achado só contava se mais de um revisor o apontasse, ou se a fonte o confirmasse. O ciclo parou quando os achados viraram casos de borda e pedidos de corte.
- **Erros da própria IA pegos na revisão:**

  | Erro | Correção |
  | --- | --- |
  | API do OpenTelemetry 1.10.0 com o SDK 2.12, o que quebraria o `npm ci` | API 1.9.1 |
  | `sdk-trace-base`, que não propaga contexto | `sdk-trace` + `context-async-hooks` |
  | `max-age` com `Age`, contando a idade duas vezes (RFC 9111) | `no-store` |
  | Soma do limite de frescor errada | 65,5 s, depois de tirar um timer |
  | Atraso mínimo contado do fim da chamada | Contado do início, 45 s (H4) |
  | Marcador de envio sem momento de escrita definido | Gravado na reivindicação (L-005) |
  | Sincronização que pulava a linha disputada, deixando SKUs sem atualização | Desconto pelo `sold_total` (L-004) |

- **Verificação:** versões conferidas no npm; RFCs e documentação lidas na fonte.

### Reorganização das specs no formato de origem

- **Pedido:** caber nos limites de tamanho do formato, sem perder informação.
- **O que a IA fez:** dividiu o conteúdo em `spec.md` (critérios), `design.md` (o "como") e ADRs enxutas.
- **Corrigido antes do commit:** a comparação com a versão anterior, mecânica (números, código, IDs) e frase a frase, achou cerca de 20 justificativas perdidas na condensação. Elas foram restauradas.

## PR #1 — Fluxo de trabalho com IA

### Agentes e escalonamento de modelo

- **Pedido:** um conjunto mínimo de agentes, cada um num ponto em que um olhar separado reduz um viés, com escalonamento de modelo.
- **O que a IA fez:** propôs `planner`, `test-writer` e `reviewer`, com a sessão principal escrevendo o código e trocando para Opus depois de duas reprovações.
- **Corrigido:** conferindo a documentação, a troca não funcionava. O `/model` e o `/effort` são comandos de quem usa, não da IA, e o `/effort` digitado fica salvo como padrão.
- **Resultado:** entrou o `implementer`. A escada passa `model` e `effort` na chamada, que vencem o frontmatter, e cada degrau é uma chamada nova, porque um agente retomado mantém o esforço.
- **Verificação:** [subagentes](https://code.claude.com/docs/en/sub-agents) e [configuração de modelo](https://code.claude.com/docs/en/model-config) do Claude Code.

### Pasta e nome dos testes

- **O que a IA fez:** propôs `test/`, depois o formato híbrido, com o teste de unidade ao lado do código.
- **Rejeitado:** o híbrido, questionado na revisão. A maioria dos critérios atravessa HTTP, banco e worker e não pertence a um arquivo do `src/`.
- **Resultado:** `test/unit/` (sem Docker) e `test/integration/<área>/`, separados como *projects* do Vitest. Assim, o commit `test:` só toca em `test/`. O nome de cada teste é o ID do critério seguido da descrição em português.
- **Verificação:** o padrão de busca lido no pacote `vitest@5.0.5`; documentação de `include` e *projects*.

### Instruções da IA

- **O que a IA fez:** um `CLAUDE.md` que só importa o `AGENTS.md`, e o limite de 200 linhas por arquivo de instrução.
- **Por quê:**
  - o Claude Code só lê o `AGENTS.md` direto quando não há `CLAUDE.md`, e a partir da v2.1.277;
  - o arquivo de instrução carrega em toda sessão: quanto maior, mais contexto ocupa e menos é seguido, por isso o teto de 200 linhas.
- **Verificação:** [memória e instruções](https://code.claude.com/docs/en/memory) do Claude Code.

### Quem publica no PR

- **Pedido:** descobrir quais agentes comentam no PR e de que forma.
- **O que a IA fez:** propôs o padrão de publicação e o conferiu nas regras do GitHub e na documentação do Claude Code.
- **Resultado:**
  - só o revisor comenta, um comentário por rodada, e nunca aprova: o PR sai da conta do mantenedor, que não pode aprovar o próprio PR, e o comentário de cada rodada guarda a marcação que define o escalonamento;
  - o plano vai como checklist na descrição do PR;
  - não há issues, porque a spec é a fonte da verdade e uma issue repetiria o marco.

### Auditoria das instruções

- **O que a IA fez:** duas auditorias dos arquivos de instrução, pelo guia de `prompt-audit` do Claude Code.
- **Resultado:** nenhum padrão escrito para modelo antigo e nenhum caminho quebrado. Seis contradições entre arquivos foram corrigidas, uma delas introduzida pela própria IA na rodada anterior: a checagem de integridade dos testes barrava a correção legítima de um teste.

### Guardas dos agentes

- **O que a IA fez:** um hook de caminho por papel e regras `ask` e `deny` (decisão na tabela de ferramentas do `STATE.md`).
- **Corrigido antes de aplicar:** o hook ia no frontmatter de cada agente. A documentação mostrou que esse hook é pulado sem aviso quando a pasta não está marcada como confiável, então ele foi para o `settings.json`, pelo `agent_type`.
- **Verificação:**
  - uma matriz de 20 casos;
  - de ponta a ponta com `claude -p --agent`: o `implementer` foi bloqueado em `test/` e o `test-writer` em `src/`;
  - a leitura do `.env` foi negada pela regra.
  
  Merge, revisão e criação de issue não foram testados ao vivo, porque uma falha teria efeito real.

## M1 — Fundação

### Contrato: escrito à mão ou gerado pelo código

- **Pedido:** decidir, com dados, entre o `openapi.yaml` escrito à mão com um validador e o OpenAPI gerado a partir do código.
- **O que a IA fez:** levantou as opções compatíveis com Node 24, Express 5, TypeScript 6 e *type stripping*, com versões, downloads e mantenedores, e recomendou manter o contrato à mão, pesando o esforço de escrever a validação.
- **Corrigido:** o critério. O código é escrito pela IA e revisado antes do merge, então o esforço não decide; a escolha passou a ser só pela qualidade: uma fonte para validação, tipos e documentação.
- **Resultado:** AD-010, contrato em zod gerando o OpenAPI 3.1, conferido no CI (`FND-07`), em substituição à AD-007.
- **Verificação:** versões e mantenedores no npm; o suporte ao TypeScript 6 do gerador de tipos, ainda em issues abertas; a geração de OpenAPI 3.1 na documentação do `zod-to-openapi`.

### Versões

- **Pedido:** usar as versões estáveis mais atuais, já que o plano estava no Node 24 com o 26 disponível.
- **O que a IA fez:** conferiu, nas fontes, a última versão de cada peça e as compatibilidades entre elas (`engines` e `peerDependencies`).
- **Resultado:** AD-011.
  - Node 26.13.0 LTS, com piso na 24.12 e CI nas duas linhas.
  - OpenTelemetry 3.
  - O resto já estava na última versão.
  - O TypeScript fica no 6.0.3, porque o `typescript-eslint` exige `<6.1.0`.
  - O PostgreSQL 18.6 é o mais atual; o 19 ainda não saiu.
- **Verificação:**
  - o índice de versões e o calendário de releases do Node;
  - `npm view` de cada pacote;
  - a página de versões do PostgreSQL e as imagens oficiais no Docker Hub.
