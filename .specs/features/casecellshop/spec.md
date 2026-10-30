# CaseCellShop — critérios de aceite

Lista única de critérios, cada um com ID. O nome de cada teste leva o ID do critério que ele prova (`CHK-01 …`). Os critérios `DOC-*` são conferidos na revisão do `ARCHITECTURE.md`. Um critério só muda pelo PR do marco; um desvio encontrado na implementação fica marcado `SPEC_DEVIATION` até ser resolvido.

Problema, metas e escopo: [`PROJECT.md`](../../project/PROJECT.md). Como construir: [`design.md`](design.md).

| Prefixo | Área | Marco |
| --- | --- | --- |
| `FND` | Fundação | M1 |
| `CHK` | Checkout | M2 |
| `ORD` | Processamento assíncrono | M3 |
| `CAT` | Vitrine e sincronização | M4 |
| `OBS` | Observabilidade | M1 a M5 |
| `DOC` | Design conceitual | M1 a M6 |
| `AI` | Fábrica agêntica (o fluxo de IA, não o produto) | F1 |

## Fundação

- **FND-01** `docker compose up` sobe tudo, com as migrações aplicadas antes da API e do worker.
- **FND-02** `npm test` passa local e no CI. O CI verde nas duas versões do Node prova o critério em todo PR; a execução local é registrada uma vez, no PR do M1. Não tem teste próprio.
- **FND-03** Uma requisição fora do contrato recebe `400` em `application/problem+json`, com o `correlationId` no corpo e no `X-Request-Id`.
- **FND-04** Uma fatura criada no ERP simulado continua lá depois de o worker reiniciar.
- **FND-05** O span do repositório sai como filho do span da requisição.
- **FND-06** O CI falha se um arquivo que carrega em toda sessão passar do limite de tamanho: até 200 linhas no `AGENTS.md` e no `CLAUDE.md` (a recomendação do Claude Code para o que carrega em toda sessão), a mesma régua em cada agente de `.claude/agents/` (escolha do projeto, porque o corpo do agente carrega em toda chamada dele) e até 500 linhas em cada `SKILL.md` de `.claude/skills/` (a recomendação do Claude Code para skills). As specs não têm teto de palavras: os agentes as leem por trecho, e não inteiras (AD-012).
- **FND-07** O CI falha se o `openapi.yaml` commitado divergir do gerado pelo contrato em `src/contract/`, ou se não passar no lint de OpenAPI 3.1.
- **FND-08** A guarda de caminho (`.claude/hooks/path-guard.mjs`) nega ao `test-writer` editar fora de `test/` e dos arquivos `*.test.ts`, e ao `implementer` editar os arquivos `*.test.ts`, `test/`, `.specs/`, `.claude/`, `src/contract/`, `openapi.yaml`, `ARCHITECTURE.md`, `AGENTS.md` e `CLAUDE.md`, com o caminho relativo, absoluto, com `..` ou em outra caixa; nega também um caminho fora do repositório e uma entrada ilegível, e deixa passar a sessão principal.

## Fábrica agêntica

Estes critérios provam os trilhos determinísticos do fluxo de IA. O motivo de cada um está na AD-012 e na tabela de ferramentas do [`STATE.md`](../../project/STATE.md). Os testes ficam ao lado do que testam.

- **AI-01** A conferência de migrações do CI só olha os `.sql`: aceita uma migração nova e a remoção do `migrations/store/.gitkeep`, e reprova alterar ou apagar um `.sql` que já está na base.
- **AI-02** `it.only`, `it.skip`, `describe.only` e `describe.skip` reprovam o `npm run lint`, e todo `*.test.ts` fora de `test/integration/` roda no projeto `unit` do Vitest, para que nenhum teste fique de fora do CI sem aviso.
- **AI-03** O hook de parada (`.claude/hooks/subagent-stop.mjs`) devolve o `implementer` ao trabalho enquanto o lint, o typecheck ou os testes ligados aos arquivos alterados falharem, e devolve o `test-writer` enquanto o lint ou o typecheck falharem. Na quarta parada do mesmo agente, ele deixa terminar e avisa que a falha virou exceção para a sessão principal.
- **AI-04** A guarda de caminho nega ao `implementer` o que configura a verificação (`.github/`, `scripts/`, `vitest.config.ts`, `tsconfig.json`, `.oxlintrc.json`, `commitlint.config.mjs`, `redocly.yaml`, `.npmrc` e `.claude/`) e continua liberando `src/`, `migrations/` e o `package.json`.
- **AI-05** O `ci.yml` declara `permissions: contents: read` no topo, fixa toda action por SHA, não interpola `github.base_ref` em `run:` e faz o checkout com `persist-credentials: false`. Entra no F2, antes de o repositório ficar público.
- **AI-06** O `.claude/settings.json` libera `git commit`, `git push` (que sai com a credencial do bot) e as nove ferramentas do GitHub do fluxo; nega `gh`, `curl`, `wget` e `security` (credencial do dono ou leitura do token), push forçado ou de remoção, e, por nome, `merge_pull_request`, `pull_request_review_write`, `update_pull_request_branch`, `create_or_update_file`, `push_files` e `delete_file`; mantém os `deny` de `.env`; desliga o modo `bypassPermissions`; e liga os hooks de parada, de ambiente (`SessionStart`) e do GitHub.
- **AI-07** A skill `.claude/skills/marco/SKILL.md` existe, só carrega quando invocada (`disable-model-invocation: true`) e tem até 500 linhas. O `AGENTS.md` não descreve o roteiro do marco, nenhum agente manda ler o `AGENTS.md` (ele já chega pelo `CLAUDE.md`), e não existe agente `planner` nem menção a ele nas instruções.
- **AI-08** O acesso ao GitHub age como a conta do bot e só oferece o necessário, igual em qualquer sessão aberta na pasta do projeto. O `.mcp.json` versionado declara o servidor `github` (o MCP oficial do GitHub) com a lista fechada de ferramentas no `X-MCP-Tools` (sem merge, sem aprovação, sem escrita de arquivo) e `X-MCP-Lockdown: true` fixos no arquivo. O `headersHelper` (`scripts/github-mcp-headers.ts`) só acrescenta o token do bot, lido do chaveiro: sem token, falha sem imprimir cabeçalho; na nuvem (`CLAUDE_CODE_REMOTE=true`), devolve `{}`. O credential helper do git (`scripts/git-credential-bot.ts`) só responde para `https://github.com`. O hook `.claude/hooks/github-guard.mjs` recusa criar PR fora de rascunho e recusa comentário de revisão (`## Revisão`) que não seja idêntico a um relatório salvo em `.claude/reviews/`.
- **AI-09** Em toda sessão, local ou na nuvem, o hook de ambiente (`scripts/check-env.ts`) diz o que falta e como resolver, sem bloquear: versão do Node contra o `.nvmrc`, dependências instaladas, Docker, `origin` em HTTPS, identidade do bot (token no chaveiro e login `honeyforge-bot`), o servidor `github` declarado no `.mcp.json` e a credencial do git apontando para o bot. Na máquina, ele mesmo configura a credencial do git quando o token existe e ela falta; o que só uma pessoa pode fazer (guardar o token, aceitar a confiança da pasta) ele explica. Na nuvem, confere só o que existe lá.
- **AI-10** O merge segue a aprovação do dono, sem ser ferramenta de agente: o workflow `.github/workflows/merge-on-approval.yml` roda quando uma revisão é enviada, só age se ela for `approved` e de autor `OWNER`, e liga o auto-merge com merge commit (`gh pr merge --auto --merge`). O GitHub só mescla quando o ruleset está satisfeito, e o workflow tem só as permissões `contents: write` e `pull-requests: write`.

## Checkout

- **CHK-01** 50 checkouts simultâneos para um item com estoque 5, repetidos em laço com o pool do teste fixado: 5 × `202`, 45 × `409` por falta de estoque, nenhum `5xx`, e as invariantes do estoque conferidas no banco.
- **CHK-02** Controle negativo: uma versão ingênua do repositório, com uma janela forçada entre ler e gravar, vende além do estoque no mesmo teste.
- **CHK-03** A mesma chave enviada em paralelo para um item com estoque 1 gera um único pedido.
- **CHK-04** A mesma chave repetida depois de o estoque acabar devolve o pedido original, e não `409`.
- **CHK-05** O mesmo pedido com os campos ou os itens em outra ordem, com a mesma chave, devolve o mesmo pedido, e não `422`.
- **CHK-06** Um `expectedUnitPrice` diferente do banco recebe `409` com o preço atual, e nada é reservado.
- **CHK-07** Dois pedidos com os SKUs {A, B} e {B, A}, em paralelo e em laço, terminam sem deadlock.
- **CHK-08** Um `lock_timeout` na linha de estoque vira `503`; no passo da chave, `409`.
- **CHK-09** O `202` traz `Location`, `Retry-After` e `X-Request-Id`, inclusive na repetição com a mesma chave.
- **CHK-10** `400` sem chave, com SKU repetido ou entrada inválida; `413`, `415`; `422` para a mesma chave com outro corpo ou SKU inexistente; cada causa com o seu `type`.
- **CHK-11** O status do pedido é `pending`, `invoiced` ou `failed` com o motivo; um `orderId` inexistente recebe `404`.
- **CHK-12** O trace sai da requisição e chega à linha da outbox.

## Processamento assíncrono

Com falhas injetadas pelo ERP simulado, contando **faturas no ERP**:

- **ORD-01** Mensagem entregue duas vezes, sem a H1b: uma fatura.
- **ORD-02** Worker que morre (lease abandonado) no meio da chamada, sem a H1b: uma fatura, e a nova reivindicação só acontece depois do atraso mínimo.
- **ORD-03** ERP que fatura e não responde, com e sem a H1b: uma fatura nos dois casos.
- **ORD-04** ERP que fatura depois do timeout, dentro do limite da H4, sem a H1b: uma fatura.
- **ORD-05** ERP que devolve `502` na hora e fatura em seguida, sem a H1b: uma fatura.
- **ORD-06** ERP acima do limite da H4: com a H1b, uma fatura; sem a H1b, o teste demonstra a fatura duplicada que o README declara.
- **ORD-07** Reprocessamento em lote de mensagens da DLQ que já tinham sido enviadas, sem a H1b: uma fatura por pedido.
- **ORD-08** Rejeição permanente, e rejeição por falta de estoque no ERP (H2), liberam a reserva.
- **ORD-09** Na consulta, um `404` de pedido inexistente leva à criação; um `404` sem o corpo esperado é erro de configuração e não cria.
- **ORD-10** Um `400` ou um `401` do ERP não falha o pedido: é transitório e conta no alerta de configuração.
- **ORD-11** Um worker com o lease prestes a vencer não chama o ERP.
- **ORD-12** Uma mensagem que derruba o processo chega à DLQ sozinha, e as outras do mesmo lote são faturadas.
- **ORD-13** Uma mensagem vai para a DLQ depois do limite de tentativas, com a reserva mantida e o pedido `pending`.
- **ORD-14** ERP fora por mais que a janela de retry: os pedidos ficam na DLQ com a reserva; quando o ERP volta, a reconciliação fatura os que ele já tem.
- **ORD-15** O cancelamento pelo runbook encerra a mensagem, e um reprocessamento depois não cria fatura.
- **ORD-16** Uma falha do banco ao gravar o desfecho não manda a mensagem para a DLQ.
- **ORD-17** Duas conclusões simultâneas do mesmo pedido baixam o estoque uma vez só.
- **ORD-18** O span da tentativa é filho do span do checkout.

## Vitrine e sincronização

Com relógio controlado:

- **CAT-01** N leituras concorrentes com a entrada expirada geram 1 consulta à origem.
- **CAT-02** A entrada expira no TTL.
- **CAT-03** As páginas servidas durante um TTL vêm do mesmo instantâneo.
- **CAT-04** Com a origem em erro, a última entrada é servida até o teto, sem esperar a origem durante a pausa; sem entrada, `503`.
- **CAT-05** Um catálogo ainda não sincronizado responde `503`.
- **CAT-06** Uma mudança de preço e uma reposição no ERP aparecem na vitrine dentro do limite da meta 2.
- **CAT-07** Um SKU com vendas durante a rodada é atualizado nela, sem devolver unidade baixada pela loja.
- **CAT-08** Uma rodada não prende as linhas de estoque: um checkout concorrente não recebe `503`.
- **CAT-09** Uma rodada lenta não se sobrepõe à seguinte.
- **CAT-10** A resposta traz `Cache-Control: no-store`.
- **CAT-11** Um SKU removido do ERP aparece como esgotado depois de uma rodada completa e volta se reaparecer; uma rodada que falha no meio não zera nada.
- **CAT-12** O trace de `GET /products` liga requisição, cache e repositório.

## Observabilidade

- **OBS-01** Todo log traz os campos obrigatórios do design e, quando existe, o `orderId`.
- **OBS-02** `/metrics` expõe as métricas de cada área do design, com o tipo indicado.
- **OBS-03** Um teste confere, na saída de `/metrics`, cada métrica usada nos alertas e no dashboard do README.
- **OBS-04** Um pedido sem desfecho em 60 s é contado uma vez, mesmo com várias réplicas da API.
- **OBS-05** Um `orderId` leva aos logs e a um trace da requisição ao ERP.

## Design conceitual

Cada seção do `ARCHITECTURE.md` abre pela decisão, cobre os pontos abaixo, usa os mesmos nomes e números do código e diz, em cada afirmação, se ela está implementada (com arquivo e teste) ou se é proposta da arquitetura alvo.

- **Diagnóstico e arquitetura alvo** (rascunho no M1, final no M6):
  - **DOC-DIA-01** causa raiz de cada problema;
  - **DOC-DIA-02** impacto para o cliente, o negócio e a operação;
  - **DOC-DIA-03** 2 ou 3 caminhos por problema, comparados em custo, complexidade, latência, consistência e esforço operacional;
  - **DOC-DIA-04** arquitetura de 30 a 90 dias, com o que entra em cada fase, citando cache, fila, banco próprio da loja, workers, sincronização, observabilidade e reconciliação com o ERP;
  - **DOC-DIA-05** a nuvem como hipótese de evolução do datacenter atual: cada componente com o serviço gerenciado correspondente, justificado pelo esforço operacional que tira; o ERP no datacenter e a conexão híbrida (VPN ou link dedicado) como fonte de latência e de falha;
  - **DOC-DIA-06** um diagrama simples da arquitetura alvo (Mermaid).
- **Concorrência e idempotência** (M2):
  - **DOC-CON-01** por que uma checagem simples de estoque é insuficiente;
  - **DOC-CON-02** update condicional atômico × lock pessimista × reserva × lock distribuído;
  - **DOC-CON-03** idempotência para retry, duplo clique e reprocessamento;
  - **DOC-CON-04** como o teste prova que não há overselling.
- **Mensageria e resiliência** (M3):
  - **DOC-MSG-01** publicar antes ou depois de gravar o pedido;
  - **DOC-MSG-02** como evitar pedido fantasma e mensagem fantasma;
  - **DOC-MSG-03** retry, DLQ, OpenAPI e testes;
  - **DOC-MSG-04** os prompts de IA relevantes.
- **Cache e performance da vitrine** (M4):
  - **DOC-CAC-01** onde fica cada camada de cache e o papel dela (CDN e HTTP, em processo, L2 compartilhado, banco da loja);
  - **DOC-CAC-02** TTL, invalidação, cache-aside × refresh-ahead, fallback e prevenção de stampede;
  - **DOC-CAC-03** métricas de ganho de latência e custo;
  - **DOC-CAC-04** métricas de que o ganho não veio de dado velho ou incorreto.
- **Observabilidade** (M5):
  - **DOC-OBS-01** logs estruturados e campos obrigatórios;
  - **DOC-OBS-02** counters, gauges e histograms para cache, checkout, fila e ERP;
  - **DOC-OBS-03** traces de `GET /products` e do `POST /checkout` assíncrono;
  - **DOC-OBS-04** SLI e SLO, alertas, dashboard e runbook.
