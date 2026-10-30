# Estado do projeto

**Atualizado em:** 30/10/2026
**Trabalho atual:** M2 — Checkout (M1 concluído)

Este arquivo guarda as decisões de projeto no formato ADR (contexto, decisão, alternativas consideradas, trade-off e quando rever), as escolhas de ferramenta, os riscos, as lições e as ideias adiadas. O "como" de cada decisão está no [`design.md`](../features/casecellshop/design.md). Uma decisão aceita não é editada: se mudar, uma nova `AD` a substitui, e a antiga passa a "substituída por AD-NNN". As versões citadas foram conferidas em 28 e 29/10/2026.

---

## Decisões de arquitetura

### AD-001 · PostgreSQL como banco próprio da loja

**Status:** aceita (29/10/2026)

**Contexto.** O banco do ERP (MySQL) é só leitura e não é compartilhado com a loja. A loja precisa de um banco transacional para a promessa de estoque, os pedidos, as chaves de idempotência e as mensagens de saída, e os testes de concorrência precisam de conexões reais.

**Decisão.**

- PostgreSQL 18.6 com o driver `pg` 8.23.1, SQL explícito e parametrizado, migrações em `.sql`.
- Valores monetários em centavos, como inteiros: nenhuma comparação de preço depende de ponto flutuante.
- Pools pequenos, com `statement_timeout`, `lock_timeout` e espera máxima por conexão; prazos gravados pelo relógio do banco.
- Retenção: chaves de idempotência por pelo menos 24 h e mensagens concluídas por 7 dias, com limpeza por SQL documentado.

**Alternativas consideradas:**

- **Memória.** A atomicidade viria do event loop; o teste de concorrência não exercitaria lock de linha nem transação.
- **SQLite (`node:sqlite`).** API síncrona e sem `SKIP LOCKED`.
- **MySQL 8.** Seria o mesmo SGBD do ERP, mas a loja não compartilha banco com ele, então não há ganho. Não tem `RETURNING`, e o DDL faz commit implícito, o que impede migrações transacionais.
- **ORM ou query builder.** Esconderiam o SQL de concorrência, que precisa ser lido e revisado.

**Trade-off.** Exige Docker, e o SQL escrito à mão não é tipado.

**Rever quando:** a limpeza da outbox disputar recursos com o tráfego. Aí, particionar a outbox por dia.

### AD-002 · Estoque como promessa

**Status:** aceita (29/10/2026)

**Contexto.** O ERP é a fonte da verdade do estoque físico; a loja controla quanto ainda pode **prometer**. Checar e baixar em passos separados é o *check-then-act* que causa o overselling, e a reserva precisa de um momento de saída que não se aplique duas vezes.

**Decisão.**

- `on_hand` espelha o ERP pela sincronização; `reserved` é da loja; `sold_total` soma as baixas locais e só cresce.
- Reserva por `UPDATE` condicional (`on_hand - reserved >= :q`), no último passo da transação do checkout, para o lock da linha durar o mínimo. Nenhuma reserva nova passa do estoque conhecido no momento dela; uma sincronização posterior pode trazer um `on_hand` menor que as reservas já feitas, e isso aparece na métrica de promessa acima do estoque.
- Uma ordem de lock única e transições do pedido por compare-and-set: o estoque só muda se a transição afetou uma linha.
- Detalhes: [`design.md`, "Checkout"](../features/casecellshop/design.md#checkout-ad-002-ad-006).

**Alternativas consideradas:**

- **Coluna única de estoque.** Uma carga vinda do ERP sobrescreveria as reservas em andamento (L-001).
- **Sincronização que libera as reservas, sem baixa local.** Entre o faturamento e a sincronização seguinte, a unidade sairia de `reserved` sem sair de `on_hand`, e a loja a prometeria duas vezes.
- **`SELECT … FOR UPDATE` + `UPDATE`.** Correto, mas são duas idas ao banco, e a checagem fica na aplicação.
- **Contador no Redis.** Fica fora da transação do pedido, e um failover com replicação assíncrona pode perder uma escrita confirmada.
- **Lock distribuído.** Um lock com prazo pode expirar durante uma pausa do processo e deixar dois donos; exigiria um fencing token verificado pelo recurso. O banco já dá a garantia.

**Trade-off.**

- Entre duas sincronizações, e durante uma queda do ERP, vendas de outros canais deixam o `on_hand` local acima do real. O ERP rejeita o excedente (H2), o pedido vira falho com a reserva liberada e entra na métrica de overselling real.
- Um pedido já faturado no ERP e ainda `pending` na loja é descontado duas vezes, pela leitura do ERP e pela reserva. O erro é para menos e dura até a primeira rodada depois da conclusão local, o que pode levar horas se o pedido ficar na DLQ.

**Rever quando:** a rejeição por falta de estoque no ERP deixar de ser rara. Aí, reduzir o intervalo da sincronização ou passar para CDC.

### AD-003 · Outbox transacional como fila, no próprio PostgreSQL

**Status:** aceita (29/10/2026)

**Contexto.** Publicar antes de gravar o pedido gera mensagem fantasma; publicar depois gera pedido fantasma se o processo cair entre os dois passos. Um worker atrasado não pode desfazer o que outro concluiu, e o ERP lento não pode receber mais chamadas do que aguenta.

**Decisão.**

- A mensagem de saída é gravada na mesma transação do pedido, e a tabela da outbox é a fila.
- Reivindicação com `FOR UPDATE SKIP LOCKED`, lease, token e tentativa contada, com commit antes da chamada; conclusão só com o token. Um semáforo limita as chamadas ao ERP.
- `first_sent_at`, gravado na primeira reivindicação e nunca apagado: toda tentativa seguinte consulta o ERP pela referência antes de criar, inclusive depois de um reprocessamento.
- Atraso mínimo contado do início da última chamada, para a consulta acontecer depois do limite da H4.
- DLQ depois do limite de tentativas, reconciliação periódica da DLQ e um runbook para reprocessar em lote ou cancelar.
- Detalhes: [`design.md`, "Worker"](../features/casecellshop/design.md#worker-envio-ad-003).

**Alternativas consideradas:**

- **SQS no LocalStack.** Desde a versão 2026.03.0 exige token de conta, e a outbox continuaria necessária para evitar a escrita dupla.
- **BullMQ com Redis.** Mais infraestrutura e a mesma escrita dupla entre o banco e a fila.
- **Fila em memória.** Perde mensagens se o processo cair.
- **DLQ por janela de tempo desde a primeira tentativa.** Cobre melhor uma queda longa, mas não tem equivalente direto no SQS e é mais difícil de testar.
- **Consultar antes de criar só depois de um timeout, ou pelo número da tentativa.** O primeiro não cobre o worker que morreu no meio da chamada; o segundo falha depois de um reprocessamento, que zera o contador.
- **Gravar `first_sent_at` junto com o resultado.** Um worker que morre no meio da chamada deixaria o marcador vazio.
- **Redrive automático da DLQ.** Precisa distinguir a mensagem que derruba o processo de uma queda do ERP, com estado e regras a mais. Para uma DLQ que só recebe quedas longas, o reprocessamento em lote é mais simples e igualmente seguro.
- **Confirmar a rejeição antes de marcar o pedido como falho, ou conferir de novo os pedidos falhos.** Cobririam o pedido falho com fatura tardia, que só acontece quando a H1b e a H4 falham juntas (R6), ao custo de estado, métrica, alerta e runbook próprios. Fica como limitação declarada.
- **Circuit breaker na reivindicação.** Acrescenta um estado por processo.
- **Cancelamento pela reconciliação.** Uma consulta durante uma criação ainda em processamento levaria a um pedido falho com fatura; a decisão manual, com consulta prévia, é mais segura.

**Trade-off.** O worker trabalha por polling, com vazão menor que a de uma fila gerenciada. Uma queda do ERP mais longa que a janela de retry exige um reprocessamento em lote pelo runbook; até lá, os pedidos ficam pendentes, com a reserva feita.

**Rever quando:** surgir um segundo consumidor dos eventos de pedido, ou a vazão medida passar do que o polling sustenta. Aí, um relay publica a outbox no SQS, com a redrive policy dele.

### AD-004 · ERP simulado em processo, atrás de uma camada anticorrupção

**Status:** aceita (29/10/2026)

**Contexto.** As falhas a tolerar são de tempo e de resultado: lentidão, indisponibilidade, rejeição e resposta perdida depois de o ERP já ter faturado. O estado do simulador precisa sobreviver ao reinício do worker, porque é isso que a consulta pela referência lê.

**Decisão.**

- O ERP simulado é um módulo no processo do worker, atrás da porta `ErpClient`, com estado no schema `erp_sim` do mesmo PostgreSQL, acessado só por ele. O ERP real usa MySQL; o schema guarda só o estado que, no ERP real, fica atrás da API.
- Ele responde por um transporte simulado e tem comportamentos configuráveis para cada falha, as hipóteses H1a a H3 e um modo sem a H1b.
- A camada anticorrupção é um adaptador único: aplica o timeout, classifica o resultado por operação numa lista fechada e não repete chamadas.
- Detalhes: [`design.md`, "ERP simulado e camada anticorrupção"](../features/casecellshop/design.md#erp-simulado-e-camada-anticorrupção-ad-004).

**Alternativas consideradas:**

- **Estado do fake em memória.** Some quando o worker reinicia, e a consulta pela referência deixaria de achar faturas que existem.
- **Um contêiner MySQL para o fake.** Imita o SGBD do ERP, mas acrescenta um serviço e um driver só para o estado de um simulador que a loja nunca lê direto.
- **ERP fake como serviço HTTP separado.** Dá timeout de rede real, mas acrescenta um serviço e um ponto de falha sem mudar a lógica da camada anticorrupção. Um adaptador HTTP implementa a mesma porta.
- **Mock gerado do contrato.** Não guarda o estado dos pedidos faturados.

**Trade-off.** O timeout é simulado por atraso, não por rede. O fake divide o servidor de banco com a loja, então uma queda do PostgreSQL derruba os dois juntos. Nos testes, a morte do worker é simulada pelo abandono do lease.

**Rever quando:** houver o contrato real do ERP. Aí entra um adaptador HTTP para a mesma porta, e nada fora da camada anticorrupção muda.

### AD-005 · Cache de latência na vitrine, em memória

**Status:** aceita (29/10/2026)

**Contexto.** A vitrine precisa de latência baixa e não pode ter stampede quando o cache expira. A origem é o banco da loja. É um cache de **latência**: sem ele, o serviço continua correto, só mais lento, e nenhuma decisão de estoque depende dele.

**Decisão.**

- Uma entrada em processo com o catálogo inteiro, com TTL curto e jitter, single-flight e *stale-if-error* com teto de idade.
- Invalidação só por expiração; o checkout decide pelo banco. Disponibilidade em faixas.
- `Cache-Control: no-store`: sem CDN no escopo, uma camada fora do serviço serviria dado defasado sem aparecer nas métricas.
- O custo é medido pelas consultas à origem por requisição, porque o ERP não é chamado no caminho da vitrine. A taxa de `409` no checkout mostra a vitrine exibindo o que não vale mais.
- Detalhes: [`design.md`, "Vitrine e cache"](../features/casecellshop/design.md#vitrine-e-cache-ad-005).

**Alternativas consideradas:**

- **Uma entrada por página.** Cada página expiraria na sua hora, e um SKU poderia aparecer duas vezes ou sumir entre páginas.
- **Redis.** Coerente entre instâncias, mas é um contêiner, um cliente e um modo de falha a mais para uma instância. Fica como L2 na arquitetura alvo.
- **Invalidação por evento entre processos.** Reduz a defasagem, mas acrescenta um caminho de falha que um TTL de segundos já limita.
- ***Stale-while-revalidate* ou refresh-ahead.** Escondem a latência de uma origem que aqui é um banco local; ganho pequeno com TTL de segundos.
- **`Cache-Control` para uma CDN.** Com o TTL restante e sem `Age`, seria correto, mas não há CDN no escopo.

**Trade-off.** Cada instância pode servir um dado defasado durante o TTL.

**Rever quando:** o catálogo deixar de caber numa entrada, houver várias instâncias da API com hit ratio baixo, ou houver uma CDN na frente. Aí entram as entradas por segmento, o L2 e os cabeçalhos de cache.

### AD-006 · Idempotência por `Idempotency-Key`, gravada primeiro na transação

**Status:** aceita (29/10/2026)

**Contexto.** Duplo clique, retry do cliente e reprocessamento não podem gerar dois pedidos. Checar a chave com um `SELECT` antes de gravar repete o *check-then-act*, e a chave precisa vir antes da reserva: senão, a repetição de um pedido que levou a última unidade receberia `409` em vez do pedido original.

**Decisão.**

- `Idempotency-Key` obrigatório no `POST /checkout`, seguindo o `draft-ietf-httpapi-idempotency-key-header-08` (ainda não RFC): um header com nome e semântica de `400` e `422` que o cliente já pode conhecer.
- A chave e o hash do payload normalizado são o primeiro passo da transação, por `INSERT … ON CONFLICT DO NOTHING`. Mesma chave e mesmo corpo devolvem o pedido original; outro corpo, `422`.
- **Diferenças do draft:** uma requisição concorrente com a mesma chave espera a primeira terminar e recebe o pedido original, com `409` só depois do `lock_timeout`; a repetição devolve o status atual do pedido, e não uma cópia da primeira resposta.
- A chave vale por pelo menos 24 h.
- Detalhes: [`design.md`, "Checkout"](../features/casecellshop/design.md#checkout-ad-002-ad-006).

**Alternativas consideradas:**

- **Chave natural derivada do corpo.** Bloquearia dois pedidos legítimos e iguais.
- **Chave no Redis com `SET NX`.** Fica fora da transação do pedido.

**Trade-off.** O cliente precisa gerar a chave e reenviá-la. Sem autenticação, o escopo da chave é global.

**Rever quando:** houver autenticação. A unicidade passa a ser `(cliente, chave)`.

### AD-007 · Contrato OpenAPI antes do código e erros em RFC 9457

**Status:** aceita (29/10/2026); substituída por AD-010 (29/10/2026). O texto está no [`STATE-ARCHIVE.md`](STATE-ARCHIVE.md).

### AD-008 · Observabilidade com OpenTelemetry (spans manuais) e pino

**Status:** aceita (29/10/2026); alterada pela AD-011 (versão do OpenTelemetry)

**Contexto.** Cada pedido precisa ser rastreável da requisição ao ERP. As métricas precisam mostrar cache, checkout, fila, estoque, ERP e sincronização, e os alertas precisam apontar para séries que existem.

**Decisão.**

- Logs JSON pelo pino, com campos obrigatórios e o contexto levado pelo `AsyncLocalStorage`.
- OpenTelemetry JS na linha 2.12, com spans manuais e o `traceparent` gravado na outbox, para o worker continuar o trace.
- Métricas pela API de métricas do OpenTelemetry, expostas em `/metrics` no formato Prometheus, com labels de uma lista fechada; os sinais lidos do banco saem da API.
- Alertas em PromQL, com um teste que confere cada série usada.
- Detalhes: [`design.md`, "Observabilidade"](../features/casecellshop/design.md#observabilidade-ad-008).

**Alternativas consideradas:**

- **Auto-instrumentação.** Em ESM, depende dos hooks de carregamento de módulos (`--import` com `module.register`), ainda experimentais no Node.
- **Linha 3.0 do OpenTelemetry** (SDK 3.0.0 e API 1.10.0, de 20/10/2026). Não acrescenta nada que este serviço use; na 2.12 o `sdk-trace` já é o pacote atual, e a migração muda API, SDK e exporters juntos.
- **Métricas por OTLP.** Exigiriam um coletor para ver qualquer número; `/metrics` se confere localmente e serve o Prometheus e o Datadog.
- **Um trace por tentativa, ligado ao checkout por span link.** Evita um trace longo com retries de dezenas de minutos, mas a cadeia requisição → worker → ERP deixa de aparecer numa visão só.
- **`dd-trace`.** Prende a instrumentação a um fornecedor.
- **`prom-client`.** Seria um segundo modelo de instrumentação.

**Trade-off.** Span manual exige disciplina: um caminho sem span não aparece no trace. Com retries longos, o trace de um pedido pode durar dezenas de minutos.

**Rever quando:** a instrumentação por hook de ESM do OpenTelemetry ficar estável. Aí a auto-instrumentação complementa os spans manuais.

### AD-009 · Sincronização periódica de preço e estoque, sem devolver unidade vendida

**Status:** aceita (29/10/2026)

**Contexto.** Uma carga única na subida deixaria preço e estoque congelados. A loja baixa o `on_hand` localmente no faturamento, então uma leitura do ERP feita **antes** de um faturamento e gravada **depois** da baixa local devolveria a unidade vendida. Pular a linha nesse caso evitaria isso, mas um SKU que vende sem parar nunca seria atualizado.

**Decisão.**

- No worker, uma rodada na subida (a carga inicial) e uma por intervalo, uma de cada vez.
- Antes de ler o ERP, guardar `t0` e o `sold_total` de cada SKU; gravar `on_hand = GREATEST(erp − (sold_total − sold_total_t0), 0)`, um `UPDATE` por SKU, em ordem, só se `synced_at < t0`. Toda rodada atualiza todos os SKUs, e o erro é sempre para menos.
- SKU ausente numa rodada completa fica com estoque zero e volta sozinho quando reaparece.
- Com o ERP fora, a loja segue com o último estoque conhecido, e a idade da sincronização dispara alerta.
- Detalhes: [`design.md`, "Sincronização"](../features/casecellshop/design.md#sincronização-ad-009).

**Alternativas consideradas:**

- **Carga única na subida.** Preço e estoque ficariam como foram carregados.
- **Pular a linha quando houve baixa local depois da leitura.** Também não devolve unidade vendida, mas um SKU muito vendido nunca seria atualizado (L-004).
- **Sincronização que libera as reservas, sem baixa local.** Promete a mesma unidade duas vezes (AD-002).
- **Desativar o SKU ausente.** Exige estado de ativação, reativação e uma regra contra a página pulada pela paginação do ERP; zerar o estoque tem o mesmo efeito para o cliente e se corrige sozinho.
- **`UPDATE` de várias linhas por lote.** O PostgreSQL trava as linhas na ordem da varredura, não na do `ORDER BY`; um lote poderia entrar em deadlock com uma reserva de vários SKUs.
- **Coordenação entre réplicas** (linha de controle ou advisory lock). Com um worker, as rodadas já não se sobrepõem; fica na arquitetura alvo.
- **Ler o MySQL do ERP direto.** O acesso de leitura existe, mas as tabelas internas do ERP não são contrato e mudam numa atualização dele. Fica só como plano B da H1a (R6).
- **CDC a partir de uma réplica do ERP.** Frescor de segundos, mas exige binlog em formato ROW e privilégio de replicação, que o acesso de leitura pode não incluir, além de um conector e um broker. Fica na arquitetura alvo.
- **Invalidar o cache a cada correção** (por exemplo, com `NOTIFY`). É um caminho de falha entre processos que o TTL de segundos já limita (AD-005).

**Trade-off.** Com o ERP respondendo, a defasagem vai até 65,5 s mais a duração de uma rodada, que inclui a espera no semáforo dividido com os retries; com o banco da loja em falha, o *stale-if-error* soma até o teto dele. Com o ERP fora, não há limite de tempo. Cada rodada lê o catálogo inteiro, o que cabe em alguns milhares de SKUs, mas cresce com ele.

**Rever quando:** o catálogo crescer a ponto de a leitura completa pesar no ERP, ou o `409` por preço alterado deixar de ser raro. Aí, sincronização incremental (por data de alteração) ou CDC.

---

### AD-010 · Contrato em zod antes do código, com o OpenAPI 3.1 gerado

**Status:** aceita (29/10/2026). Substitui a AD-007.

**Contexto.** O contrato é a fonte da verdade da API e precisa cobrir sucesso, erro e o fluxo assíncrono. Com o contrato só em YAML (AD-007), os tipos das rotas ficam escritos à mão, porque o gerador de tipos a partir do OpenAPI não aceita o TypeScript 6, e o compilador não confere se o código segue o contrato; a validação depende de um pacote com um mantenedor e sem release desde janeiro.

**Decisão.**

- O contrato é escrito em zod 4.6.7 num módulo próprio, `src/contract/`, antes de qualquer handler: os schemas de requisição, resposta e erro, e o registro de cada rota com status e cabeçalhos.
- O `@asteasolutions/zod-to-openapi` 9.1.0 gera o `openapi.yaml` (OpenAPI 3.1), escrito com o `yaml` 2.9.1. O arquivo fica commitado, e o CI falha se ele divergir do gerado ou não passar no lint do Redocly CLI 2.72.1 (`FND-07`).
- Os mesmos schemas validam toda requisição (parâmetros, query, cabeçalhos e corpo) num middleware próprio e, nos testes, o corpo e os cabeçalhos de toda resposta. Os tipos dos handlers são inferidos deles.
- Erros em `application/problem+json` (RFC 9457), com `correlationId` e um `type` por causa, produzidos por um middleware único; falhas do banco mapeadas pelo passo da transação.
- `X-Request-Id` em toda resposta; preço sempre do banco, em centavos; só mudanças aditivas.
- Detalhes: [`design.md`, "Contrato"](../features/casecellshop/design.md#contrato-ad-010).

**Alternativas consideradas:**

- **`openapi.yaml` à mão, validado pelo `express-openapi-validator` (AD-007).** Valida sem código próprio, mas deixa os tipos fora da checagem do compilador e depende de um pacote com um mantenedor e releases parados.
- **`zod-openapi`.** Usa os metadados nativos do zod 4, sem estendê-lo em tempo de execução, mas tem um mantenedor só.
- **TypeBox.** Gera JSON Schema, mas o documento OpenAPI (rotas, status e cabeçalhos) seria montado à mão.
- **Decorators (tsoa).** Não rodam com *type stripping*.
- **oRPC ou express-zod-api.** Trocam o roteamento do Express por um modelo próprio.
- **Formato de erro próprio.** Mais um formato para quem consome a API, sem media type registrado nem campos de extensão definidos.
- **Paginação por cursor.** Resiste a inserções entre páginas, mas aqui as páginas de um TTL já vêm do mesmo instantâneo.

**Trade-off.** A validação das requisições é código próprio, coberto por testes de contrato por rota (R2). O gerador estende o zod uma vez, ao carregar o módulo de contrato.

**Rever quando:** um consumidor precisar de cliente gerado a partir do contrato, ou o gerador deixar de acompanhar as versões do zod. No segundo caso, a troca é pelo `zod-openapi`, sem mudar os schemas.

### AD-011 · Versões: a última estável compatível, fixada

**Status:** aceita (29/10/2026). Altera a AD-008 (versão do OpenTelemetry) e a linha "Runtime" da tabela de ferramentas.

**Contexto.** As versões foram escolhidas antes do código, e duas linhas viraram estáveis nesse meio-tempo: o Node 26 entrou em LTS ativo em 28/10/2026, e o OpenTelemetry JS lançou a linha 3 em 20/10/2026. Sem código escrito, migrar agora não custa nada; depois, cada versão atrasada vira uma migração de código que já roda.

**Decisão.**

- Cada dependência entra na última versão estável compatível com as outras, fixada exata no `package.json`, sem `^` nem `~`. A imagem e o `.nvmrc` também fixam a versão.
- Node.js 26.13.0 LTS (LTS ativo até 20/10/2027, suporte até 30/04/2029) no `.nvmrc`, na imagem e no CI. O `engines` aceita a partir da 24.12, e o CI roda também nela. Os tipos (`@types/node` 24.19.2) ficam na linha mínima, para o compilador barrar uma API que só exista no 26.
- OpenTelemetry JS na linha 3: API 1.10.0, SDK 3.0.0 (`sdk-trace`, `sdk-metrics`, `context-async-hooks`, `core`, `resources`) e exporters 0.300.0.
- TypeScript 7.0.2, com o lint pelo oxlint 1.90.0 e o tsgolint 7.0.2005 (estável desde 09/2026, com todas as regras do `recommendedTypeChecked` do `typescript-eslint`, que só aceita TypeScript abaixo da 6.1) (R1).
- Uma versão nova só entra por uma linha na tabela de ferramentas ou por uma AD, no PR de um marco.

**Alternativas consideradas:**

- **Manter o Node 24.** Funciona, mas entrou em manutenção em 20/10/2026 e perde o suporte em 30/04/2028.
- **Exigir o Node 26 de quem clona.** Garante uma versão só, mas obriga a instalar uma linha com dias de LTS para rodar os testes.
- **Manter o OpenTelemetry 2.12.** Evita uma linha com dias de lançamento, mas deixa o projeto um major atrás desde o primeiro commit. O spike do M1 (R8) confere a 3, e a 2.12 fica de plano B.
- **TypeScript 6.0.3 com o `typescript-eslint`.** Todas as regras com tipos, mas um major atrás até ele aceitar o 7. O Biome cobre só parte da regra de promessa não tratada.
- **Intervalos de versão (`^`).** Cada `npm install` poderia trazer uma versão diferente da testada.

**Trade-off.** Linhas com poucos dias de lançamento (o Node 26 como LTS e o OpenTelemetry 3) podem ter defeitos que ainda não apareceram; o CI na 24.12 e o spike do M1 reduzem o risco.

**Rever quando:** o projeto precisar de uma API que só exista no Node 26 (o piso sobe para a 26), ou o oxlint deixar de cobrir uma regra com tipos de que o projeto dependa.

### AD-012 · Fábrica v2: quatro nós, oráculo fora do alcance de quem implementa e humano só onde decide

**Status:** aceita (30/10/2026, PR #4). O teto fixo de rodadas da revisão é substituído pela AD-015.

**Contexto.** O M1 entregou o que prometia, mas o processo custou mais que o produto:
- **Documentos:** cerca de 162 KB de documentação de processo para 1.105 linhas de código.
- **Leitura por chamada:** cada agente relia de 65 KB a 147 KB, e o `AGENTS.md` entrava duas vezes, pelo `CLAUDE.md` e pela instrução de lê-lo.
- **Aprovações:** cada commit, push e comentário pedia aprovação humana.
- **Revisão:** o PR teve cinco rodadas. As duas últimas só acharam problemas criados pelas correções anteriores.
- **Limites de palavras:** herdados da skill `tlc-spec-driven`, forçaram commits de compressão.
- **Oráculo exposto:** o `implementer` podia editar o CI e as configurações que decidem se o trabalho dele está certo.

A pesquisa da fábrica (palestra de Tariq Shaukat, Spotify, Stripe, Anthropic, METR) converge em verificação determinística e independente, com o humano na intenção e no merge.

**Decisão.**

- **Workflow fixo de quatro nós,** conduzido pela sessão principal com a skill `/marco`:
  1. Plano, em plan mode, aprovado pelo mantenedor.
  2. Testes, pelo `test-writer`.
  3. Código, pelo `implementer`, com a escada até Opus e no máximo duas chamadas no degrau 2.
  4. Revisão, pelo `reviewer`, só leitura.
- **O `planner` sai:** ele relia as specs para propor o plano que a sessão principal, também Opus, refazia, e não verificava nada de forma independente.
- **O oráculo é da sessão principal:** CI, scripts, configurações de verificação e `.claude/`. A guarda nega esses arquivos ao `implementer` (AI-04).
- **Um hook de parada devolve o agente ao trabalho** enquanto lint, typecheck ou os testes ligados às mudanças falharem (AI-03).
- **Revisão:** uma rodada por fatia e uma nova só por commit fora da lista livre. Achado `baixa` vira item do próximo plano. O teto é de 3 rodadas por fatia e 5 por marco.
- **O `AGENTS.md` traz só o que toda tarefa usa,** e o roteiro vai para a skill, carregada sob demanda. Os agentes leem as specs por trecho, guiados por um mapa da tarefa em cada delegação.
- **Onde cada regra fica,** pelo que a documentação do Claude Code recomenda:
  - **specs:** o quê e o porquê do produto (critérios, design, decisões);
  - **`AGENTS.md`:** fatos que toda tarefa usa;
  - **regra por caminho em `.claude/rules/`:** a convenção de uma área, que só carrega quando um arquivo dela é lido ou escrito, como a de testes em `.claude/rules/tests.md`;
  - **skill:** um procedimento de vários passos, carregado sob demanda, como o `/marco`;
  - **hook, `deny` ou ruleset:** o que não admite exceção.

  As invariantes de persistência ficam no `AGENTS.md`, e não numa regra por caminho, porque o plano e a revisão por `git diff` não leem os arquivos que carregariam a regra.
- **As specs ficam sem teto de palavras.** O `FND-06` passa a conferir só o que carrega em toda sessão, com os limites do Claude Code: 200 linhas por instrução e 500 por skill.
- **O humano age em quatro pontos:**
  1. aprova o plano;
  2. decide as exceções;
  3. lê a matriz critério × teste e o texto das respostas do desafio, uns 10 minutos por marco;
  4. aprova e faz o merge.

**Alternativas consideradas:**
- **Manter o `planner`:** sai pelo custo sem independência. Volta como um agente só leitura de baixo custo se um desvio que o plano deveria ver escapar.
- **Agente único com CI forte:** perde a independência entre quem testa e quem implementa. Testes escritos olhando o código tendem a reafirmar o comportamento.
- **Vários agentes em paralelo ou agent teams:** custam cerca de 15x mais tokens, para pouco trabalho paralelizável.
- **Pipeline por `claude -p`:** não aceita a aprovação humana no meio da execução.
- **Juiz LLM no loop do `implementer`:** é instável. O hook determinístico cumpre o papel.
- **Specs com teto menor:** o teto não mede qualidade e força apagar raciocínio.

**Trade-off.** O plano perde um contexto separado do orquestrador. A revisão por fatia pode somar mais rodadas que uma revisão por marco. As regras novas são texto da skill, e a medição do M2 confirma ou corrige.

**Rever quando:** um desvio que o plano deveria ter visto escapar para a implementação; o degrau 2 da escada for usado em mais de um problema de concorrência num marco; ou as rodadas por marco passarem de 5.

**Referências:** [Claude Code, sub-agents](https://code.claude.com/docs/en/sub-agents) (o subagente carrega o `CLAUDE.md`); [Claude Code, memory](https://code.claude.com/docs/en/memory) (até 200 linhas; o roteiro vai para uma skill); [Claude Code, skills](https://code.claude.com/docs/en/skills) (até 500 linhas); [METR, reward hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking); [Spotify, verificadores](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3).

### AD-013 · O GitHub pelo MCP oficial, como a conta de máquina do bot, e a main guardada por ruleset

**Status:** aceita (30/10/2026, PR #4). A conta fixa do bot é substituída pela AD-014.

**Contexto.** Os agentes agiam no GitHub com o token do dono, que é administrador e poderia editar ou apagar qualquer controle do próprio repositório. Como o dono era também o autor do PR, a aprovação do GitHub era impossível, porque o autor não aprova o próprio PR. O desafio exige o repositório público, e no plano gratuito o ruleset só existe em repositório público. O fluxo precisa funcionar igual na sessão local e na nuvem, onde o Claude Code já entrega o GitHub como ferramentas MCP e o proxy bloqueia o GraphQL que o `gh pr` usa.

**Decisão.**

- **Repositório público,** depois da varredura do histórico com o gitleaks, sem achados.
- **Ruleset `main protegida`:**
  - PR obrigatório, com uma aprovação sobre o último push, descartada a cada commit novo;
  - checks obrigatórios (`Node nvmrc`, `Node 24.12.0`, `Commits do PR`);
  - sem push forçado nem deleção;
  - merge só por merge commit.
- **Ruleset `sem push forçado`,** em todas as branches. A remoção de branch fora da `main` continua permitida no servidor: a guarda do Bash já a nega aos agentes (AI-11), e restringi-la no ruleset faria o dono apagar à mão cada branch depois do merge.
- **Os agentes agem como a conta `honeyforge-bot`,** colaboradora com permissão de escrita.
  - **No GitHub:** o servidor MCP oficial (`https://api.githubcopilot.com/mcp/`), declarado no `.mcp.json` versionado e liberado por `enabledMcpjsonServers`. Ele carrega sozinho em qualquer sessão aberta na pasta (terminal, VS Code ou nuvem) depois que a pessoa aceita, uma vez, a confiança da pasta: o Claude Code não roda helpers de um projeto não confiável.
  - **O `X-MCP-Tools`, que faz o próprio servidor expor só as nove ferramentas do fluxo, e o `X-MCP-Lockdown`** ficam fixos no `.mcp.json`. O `headersHelper` (`scripts/github-mcp-headers.ts`) só acrescenta o token do bot, lido do chaveiro a cada conexão. Ele não pode vir de variável de ambiente, porque o Claude Code tira do helper as variáveis com TOKEN ou SECRET no nome.
  - **No push:** o `git push` sai pelo credential helper do bot (`scripts/git-credential-bot.ts`), configurado só neste repositório.
  - **Na nuvem:** o helper devolve `{}`, e a autenticação viria de um segredo de rede do ambiente, com o host `api.githubcopilot.com` liberado, porque ele não está na lista de rede padrão. Isso está **a validar** numa sessão real, e a nuvem não é usada antes da entrega.
- **As permissões valem nos dois ambientes:** liberam as nove ferramentas por nome e negam por nome o merge, a aprovação e a escrita de arquivo. Também negam `gh`, `curl`, `wget` e `security`. O hook `github-guard` exige PR em rascunho e confere que o relatório do `reviewer` chega idêntico ao arquivo salvo.
- **O merge segue a aprovação do dono:** o workflow `merge-on-approval.yml` liga o auto-merge, e o GitHub só mescla com o ruleset satisfeito. Nenhum agente faz merge.
- **Os commits saem com a identidade git do dono,** como responsável. Os trailers `Co-Authored-By` e `Assisted-by` dizem qual papel, modelo, esforço e degrau produziu cada commit.
- **O hook de ambiente (`npm run check:env`, no `SessionStart`)** diz em toda sessão o que falta e como resolver, sem bloquear. Na máquina, ele mesmo configura a credencial do git quando o token existe. O que só uma pessoa faz, guardar o token e aceitar a confiança da pasta, ele explica.

**Alternativas consideradas:**
- **O token do dono:** é administrador e torna a aprovação impossível.
- **O `gh` pelo terminal, com regras de permissão:**
  - *Contra:* todo subcomando fica disponível, e o bloqueio depende de regras que comparam texto.
  - *Contra:* na nuvem, o `gh pr` falha porque o proxy bloqueia o GraphQL.
- **Um script próprio com verbos fixos:**
  - *A favor:* é restrito e mantém o texto do comentário byte a byte.
  - *Contra:* é um wrapper nosso, que teríamos de manter.
  - *Contra:* não roda igual na nuvem, porque o `gh pr` falha lá.
  - Com a restrição feita no próprio servidor, o MCP oficial entrega a mesma restrição sem código nosso.
- **Registro do MCP no escopo local de cada máquina:** não é automático e, por ter precedência sobre o projeto, esconderia o `.mcp.json`.
- **MCP por Docker local, com lançador e hooks de papel e de formato:** a restrição pelo `X-MCP-Tools` e o `headersHelper` eliminam o contêiner, o lançador e o token no ambiente.
- **GitHub App:** é o que o GitHub recomenda para serviços, com tokens de 1 hora por instalação. Mas exige gerar o JWT a partir de uma chave privada sem expiração, e a nuvem do Claude Code usa a conta conectada pelo `/web-setup`, não um App.
- **Token fine-grained:** não alcança repositório pessoal de outro dono em que o bot é colaborador.
- **Merge manual pelo dono:** funciona, com um clique a mais depois da decisão. O auto-merge não reduz a garantia, porque o GitHub só mescla com o ruleset satisfeito.

**Trade-off.**
- **O token clássico tem os escopos `repo` e `workflow`.** A documentação do GitHub recomenda validade e prefere GitHub App para automação; aqui a conta de máquina é o que funciona igual na máquina e na nuvem, e o token deve ser recriado com validade (90 dias). O `workflow` é necessário porque o bot envia commits que mudam `.github/workflows/`.
- **Na nuvem, a autenticação do MCP depende de um segredo de rede ainda não validado.** As permissões por nome valem lá de qualquer forma.
- **No CI do GitHub Actions não rodam agentes.** Se rodarem, o `.mcp.json` com helper não serve, porque lá não há chaveiro nem confiança persistida, e o MCP vai por `--mcp-config` com um segredo do Actions.
- **Com MCP, o texto do comentário passa pelo modelo,** e o hook `github-guard` é que garante a fidelidade do relatório.
- **As regras de Bash comparam texto:** um agente que chamasse o `security` pelo caminho completo ainda leria o chaveiro (R11).

**Rever quando:** o token do bot vazar ou precisar de rotação frequente (o GitHub App entra); o GitHub passar a aceitar o token fine-grained para colaborador de repositório pessoal; ou a nuvem mudar o nome das ferramentas do GitHub.

**Referências:** [Claude Code, MCP](https://code.claude.com/docs/en/mcp) (`headersHelper`, escopos); [GitHub MCP Server, servidor remoto](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) (`X-MCP-Tools`, `X-MCP-Lockdown`); [GitHub, available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets); [GitHub, auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request); [kernel Linux, coding assistants](https://docs.kernel.org/process/coding-assistants.html) (`Assisted-by`). As nove ferramentas e a recusa das demais foram conferidas ao vivo no servidor com o token do bot, em 30/10/2026.

### AD-014 · A identidade do GitHub escolhida em cada clone, sem conta fixa

**Status:** aceita (30/10/2026, PR #5). Substitui, na AD-013, a conta do bot fixa no código e o token só no chaveiro do macOS.

**Contexto.** A AD-013 deixou a conta do bot e o item do chaveiro fixos no código e na documentação. Quem clonasse o projeto teria de usar a mesma conta, o setup só guardava o token no chaveiro do macOS, e numa máquina Linux sem desktop, num contêiner ou no WSL o modo bot não funcionava. Na sessão do Claude Code na nuvem, o GitHub já vem da conta conectada ao ambiente, e nada no clone precisa ser configurado.

**Decisão.**

- **A identidade fica no `git config --local` de cada clone** (`casecellshop.identity`, `botLogin`, `keychainService`, `tokenStore`), gravada pelo `npm run setup:local` (AI-14). O git, o credential helper, o `headersHelper` e os hooks a leem do mesmo lugar, em qualquer shell, e o `.git/config` já está no retrato do git dos subagentes (AI-12).
- **Dois modos:**
  - **`bot`:** uma conta de máquina separada de quem aprova, para a aprovação do PR continuar possível. O token fica no chaveiro do sistema (o Chaveiro no macOS, o Secret Service no Linux). Sem chaveiro, a pessoa escolhe explicitamente um arquivo fora do repositório, com permissão 600 e aviso em toda sessão de que ele não é cifrado.
  - **`self`:** a credencial do GitHub que o git da máquina já guarda, lida sem nunca abrir prompt. O diagnóstico avisa em toda sessão que, assim, a pessoa é autora dos PRs e não consegue aprová-los.
- **Na nuvem, a identidade é a conta do ambiente:** o setup não se aplica e o diagnóstico não pede identidade.
- **O setup é interativo e repetível:** sem argumentos, pergunta na primeira vez e reaproveita depois; troca só o token ausente ou recusado, pede confirmação para trocar o de outra conta e não mexe no chaveiro quando não dá para conferir o token.
- **Nenhuma conta fica fixa em `scripts/` nem em `.claude/hooks/`,** e um teste reprova o que fixar uma.

**Alternativas consideradas:**
- **A conta fixa da AD-013:** não serve a outra pessoa nem a outra conta.
- **A escolha por variável de ambiente:** o git chama o credential helper de shells que podem não tê-la.
- **Um arquivo local ignorado pelo git:** seria mais um arquivo para os scripts lerem e para proteger dos agentes.
- **Só o modo bot:** deixaria de fora quem não pode ou não quer manter uma segunda conta.
- **Guardar o token do bot sempre num arquivo:** mais simples, mas sem a proteção do chaveiro onde ele existe.

**Trade-off.** No modo `self`, o merge trava no ruleset atual, que exige a aprovação de outra conta; a escolha é da pessoa, com o aviso. O arquivo sem cifra protege menos que o chaveiro, e por isso só entra por escolha explícita. No Windows nativo, o modo bot não funciona: o caminho é o WSL.

**Rever quando:** houver mais de uma pessoa usando a fábrica com regras de aprovação diferentes; o projeto adotar um GitHub App (a identidade passa a ser o App); ou o Windows nativo precisar do modo bot.

**Referências:** [git-config, variáveis de ferramentas](https://git-scm.com/docs/git-config); [git-credential](https://git-scm.com/docs/git-credential); [Git Credential Manager, credential stores](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/credstores.md); [Claude Code na web](https://code.claude.com/docs/en/claude-code-on-the-web.md).

### AD-015 · A revisão para quando não sobra achado alto nem médio

**Status:** proposta (30/10/2026). Aceita pelo merge do PR de fechamento do F1. Substitui, na AD-012, o teto fixo de 3 rodadas por fatia e 5 por marco.

**Contexto.** O teto fixo da AD-012 contava igual uma rodada que achava um problema de desenho e uma que só confirmava correções. No PR #4, as duas últimas de cinco rodadas só acharam problemas criados pelas correções anteriores. No PR #5, a Revisão 3 achou uma regressão média criada pela correção da Revisão 2, e a Revisão 4, restrita ao delta, fechou sem achado alto ou médio. Parar pelo número deixaria um achado médio aberto; revisar sem regra de parada repete rodadas que não acham nada novo.

**Decisão.**

- **A revisão para quando a última rodada cobre o `HEAD` e não sobra achado `alta` nem `média` aberto.** Achado `baixa` nunca bloqueia: vira item do próximo plano.
- **Achado `alta` ou `média` vem com reprodução:** o comando, o teste ou a sonda que mostra o comportamento errado. Sem reprodução, entra como `baixa` ou como dúvida para a sessão principal conferir.
- **A correção de um achado bloqueante chega com um teste que falhava antes dela:** o commit `test:` vem antes do `fix:`.
- **Da segunda rodada em diante, a revisão cobre só o delta da correção** e confere se os achados anteriores fecharam.
- **O mantenedor decide** na terceira rodada sobre o mesmo achado, ou quando correções seguidas criam achado médio novo duas vezes (sinal de problema de desenho). As opções são refazer o desenho, aceitar o risco registrado ou tirar a mudança do PR.

**Alternativas consideradas:**
- **O teto fixo da AD-012:** para com achado médio aberto ou gasta rodadas que não acham nada.
- **Revisar até não sobrar achado nenhum:** achado `baixa` sempre aparece, e a revisão não termina.
- **Uma rodada só por PR:** a correção dos achados entraria sem revisão.

**Trade-off.** Sem teto numérico, um PR pode somar mais rodadas; a escalada por regressão e pela terceira rodada sobre o mesmo achado é o limite. Exigir reprodução custa tempo ao revisor e pode rebaixar um achado verdadeiro difícil de reproduzir.

**Rever quando:** uma rodada aprovar e o CI, o `/security-review` ou o dono acharem depois um problema alto ou médio que a rodada deveria ter visto; ou um marco passar de 5 rodadas.

**Referências:** [Google Engineering Practices, the standard of code review](https://google.github.io/eng-practices/review/reviewer/standard.html).

### AD-016 · Segurança em três camadas, com o `/security-review` antes de o PR sair do rascunho

**Status:** proposta (30/10/2026). Aceita pelo merge do PR de fechamento do F1.

**Contexto.** O repositório é público, os agentes agem no GitHub com um token, e o serviço recebe pedidos sem autenticação. O `reviewer` confere segurança em toda rodada, mas lê o delta pelo critério da fatia. Vulnerabilidade conhecida em dependência e segredo vazado não aparecem no diff. Um agente de segurança a cada fatia repetiria a leitura do `reviewer` e gastaria tokens em todo delta.

**Decisão.**

- **Camada 1, ferramentas do GitHub:** CodeQL na configuração padrão, secret scanning com push protection e alertas do Dependabot, ligados pelo dono nas configurações do repositório. O ruleset passa a exigir o resultado do code scanning depois que o CodeQL rodar limpo uma vez.
- **Camada 2, revisão por IA em dois pontos:**
  - o `reviewer` confere segurança em toda rodada, pela lista de verificação dele;
  - o `/security-review` roda na sessão principal, sobre o PR inteiro, antes de o PR sair do rascunho. O hook do `AI-16` impõe isso: sem o registro do `HEAD`, o `github-guard` recusa o `draft: false`. Achado alto ou médio dele bloqueia como um do `reviewer` (AD-015), e o relatório vai ao PR como comentário `## Revisão de segurança`.
- **Camada 3, ameaças por marco:** o plano de cada marco lista as ameaças da parte que ele toca e o critério que cobre cada uma.

**Alternativas consideradas:**
- **Agente de segurança a cada fatia:** repete o `reviewer` e custa tokens em todo delta.
- **Só as ferramentas do GitHub:** não leem a lógica, como o preço vindo do cliente ou um token enviado ao host errado.
- **O `/security-review` como Action no CI:** pede uma chave da API guardada no repositório e cobra por execução; a sessão local já existe.
- **O `/security-review` só por instrução na skill:** uma instrução pode ser esquecida; o hook não esquece.

**Trade-off.** O registro prova que a revisão abriu naquele commit, não que terminou nem que o relatório postado está completo, porque o relatório passa pela sessão principal. Um commit depois do registro exige rodar a revisão de novo. Limites que ficam:
- **O portão protege contra o esquecimento, não contra fraude:** a guarda de caminho nega as pastas dos registros às ferramentas Edit e Write, mas um `touch` ou um `cp` pelo Bash ainda cria um registro ou um relatório falso (R10).
- **O portão não confere o número do PR nem o GitHub ao vivo:** ele olha o `HEAD` local e a referência remota local; um commit publicado no GitHub sem `git fetch` não aparece.
- **Só a ferramenta `Skill` abre o portão:** o `/security-review` digitado no terminal não passa pelo hook e não grava registro.

**Rever quando:** um problema de segurança escapar para a `main`; o serviço ganhar autenticação ou dado pessoal; ou o Action rodar sem chave guardada no repositório.

**Referências:** [Claude Code, comandos](https://code.claude.com/docs/en/commands.md) (`/security-review`); [Claude Code, hooks](https://code.claude.com/docs/en/hooks.md) (`PostToolUse`); [GitHub, code scanning default setup](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning).

## Escolhas de ferramenta

| Tema | Escolha | Descartado | Por quê |
| --- | --- | --- | --- |
| Runtime | Node.js 26.13.0 LTS, fixado no `.nvmrc` e na imagem, com `engines` a partir da 24.12 e o CI nas duas linhas (AD-011). ESM, *type stripping* e `erasableSyntaxOnly`. TypeScript 7.0.2 só com `--noEmit` | Node 24 como alvo; build com `tsc`; `tsx` | Sem build, o que roda é o código do repositório. O Node 26 é o LTS ativo, e a 24.12, onde o *type stripping* ficou estável, é o piso para quem clona com o LTS anterior |
| HTTP | Express 5.3.0 | NestJS; Fastify | O Nest depende de decorators, que o Node não aceita no *type stripping*. A validação pelo contrato em zod (AD-010) é um middleware curto no Express, que já se integra ao pino e aos spans manuais do OpenTelemetry; o Fastify faria o mesmo por plugins, sem ganho aqui, porque o framework não é o gargalo: a vitrine responde do cache, e o checkout é uma transação curta |
| Testes | Vitest 5.0.5, supertest 7.3.1, Testcontainers 12.2.1; unitários ao lado do arquivo testado, integração em `test/integration/<área>/` | Mocks do banco; service container no CI; todos os testes em `test/` (PR #1) | As garantias só se provam com banco real, e o caminho é o mesmo na máquina e no CI. O unitário testa um arquivo isolado e muda, move e some com ele; o de integração atravessa HTTP, banco e worker e não pertence a um arquivo. A guarda separa os papéis pelo nome `*.test.ts`, e o `.dockerignore` deixa os testes fora da imagem |
| Migrações | node-pg-migrate 9.0.0, com arquivos `.sql`, *advisory lock* e conferência de ordem; o CI barra a alteração de uma migração que já está na `main` | Runner próprio; Flyway; dbmate; Postgrator; postgres-migrations; graphile-migrate; `@databases/pg-migrations`; umzug | Mantido, roda em Node com o `pg` e mantém as migrações em `.sql` (AD-001); os outros trazem Java, um binário sem API para Node, outro driver, ou não têm lock, transação por arquivo ou versão recente. Não confere o conteúdo do que já rodou; a regra do CI cobre isso no PR |
| Arranque do ferramental (M1) | O `implementer` cria o `package.json`, o lockfile e as configurações e faz o spike do R8 antes do contrato e dos testes, num commit `build:` sem comportamento | O `test-writer` criar as configurações; a sessão principal fazer o spike | O `test-writer` só edita testes, e o contrato e os testes precisam das dependências; um commit `build:` mantém o teste antes do código |
| Guardas dos agentes | Hooks no `.claude/settings.json`, pelo `agent_type`: `PreToolUse` limita as edições de cada papel e protege o oráculo do `implementer` (AI-04); `SubagentStop` devolve o `implementer` e o `test-writer` enquanto a verificação falhar (AI-03) e grava a mensagem final do `reviewer` em primeiro plano; o `PostToolUse` do `SubagentHandback` grava o relatório do `reviewer` em segundo plano, e nenhuma sessão edita `.claude/reviews/` nem `.claude/state/` pelas ferramentas (AI-15); o `PostToolUse` do `Skill` registra o `HEAD` em que o `/security-review` abriu, que o `github-guard` exige para tirar o PR do rascunho (AI-16); o `PreToolUse` de Bash (`bash-guard`) deixa os subagentes só ler o git, recusa a eles a escrita de arquivo pelo shell (interpretadores, `sed -i`, `tee`, redirecionamento para arquivo) e aceita o `git push` de qualquer sessão só na forma estreita do fluxo (AI-11); o `SubagentStart` tira um retrato do git que a parada compara, e uma mudança vira exceção (AI-12); o `.githooks/pre-push` recusa push fora de `https://github.com/` (AI-08). Permissões: `git commit`, `git push` (credencial do bot) e as nove ferramentas MCP do GitHub liberados; `gh`, `curl`, `wget`, `security` e `.env` negados; `bypassPermissions` desligado (AI-06) | Hook no frontmatter de cada agente; regras de Bash como única barreira; juiz LLM no loop; para o git dos subagentes, só uma lista de verbos negados; para o SSH, só gravar `remote.origin.pushurl` HTTPS | O hook do frontmatter é pulado sem aviso quando a pasta não está marcada como confiável, e não roda em `claude -p`; no `settings.json` vale em toda sessão. Regra de Bash compara texto, então a barreira real para o `main` é o ruleset (AD-013) e, para a máquina, a sandbox (R11). O hook de parada é determinístico; um juiz LLM muda de veredito (AD-012). O agente em segundo plano entrega o relatório pelo `SubagentHandback`, fora da mensagem final que o hook de parada recebe; ler a transcrição dependeria de um formato interno, e o `PostToolUse` dessa ferramenta é o caminho documentado. Uma guarda de texto sempre tem grafia que escapa (variável, alias, script escrito pelo próprio agente), então ela só dá retorno rápido, e a prova é o retrato do git, que não depende da grafia; a lista do que pode passar fecha por padrão, e a de negados deixava passar `pull`, `cherry-pick` e afins. O `insteadOf` global também reescreve o `pushurl`, por isso a conferência fica no `pre-push`, que recebe a URL já reescrita e roda antes de enviar qualquer ref |
| Estilo pelo compilador e pelo lint | Opções a mais no `tsconfig` (`noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`) e onze regras a mais no oxlint, entre elas `switch-exhaustiveness-check` e `no-deprecated` (AI-20) | Pedir o estilo por escrito no `AGENTS.md` ou numa skill; skills de estilo TypeScript de terceiros; `noPropertyAccessFromIndexSignature`; `prefer-nullish-coalescing`; as regras experimentais do oxlint | O que precisa valer sempre vai para o que reprova sozinho: um texto é lido e pode ser esquecido, e o `tsc` e o lint rodam no hook de parada, no pre-push e no CI. As escolhidas pegam erro real (caso de `switch` esquecido, API obsoleta, `undefined` passado onde a propriedade é opcional) e custaram poucos ajustes no código de então. A `noPropertyAccessFromIndexSignature` daria 75 erros só de estilo; a `prefer-nullish-coalescing` exigiria trocar `\|\|` por `??` onde a string vazia deve cair no padrão (o `XDG_CONFIG_HOME` vazio, o token vazio), o que mudaria o comportamento; e as experimentais mudam entre versões |
| Validação das instruções da IA | Testes determinísticos no CI: o `check:instructions` (200 linhas por instrução, agente e regra, inclusive em subpastas; 40.000 caracteres por regra; 500 linhas e 12.000 bytes por skill, com o material de referência em arquivos de apoio), com testes de unidade e controle negativo para cada limite, e o `AI-13`, que abre o frontmatter dos agentes e da skill com o `yaml` do projeto e só aceita os campos da referência do Claude Code. Auditoria do texto dos agentes por um agente independente, com fonte e linha por achado, quando as instruções mudam muito | `/doctor` ou `/doctor prompt-audit` no CI ou num hook do git; `claude doctor`; `claude plugin validate`; um linter de terceiros; validar o `settings.json` contra o schema com o `ajv-cli` | Um agente com YAML quebrado ou campo com erro de digitação é ignorado sem aviso na sessão, e uma skill maior que o que a compactação devolve ao contexto perde o fim do roteiro no meio do marco, então a conferência precisa ser automática e falhar no CI; o limite da skill é em bytes porque o CI não tem contador de tokens sem rede. O `/doctor` é interativo e não tem código de saída, o `claude doctor` e o `plugin validate` não pegaram YAML quebrado na versão em uso, e um linter de terceiros seria dependência nova sem ganho sobre os testes. O schema do `settings.json` fica para quando houver uma decisão sobre o `ajv-cli` |
| Prompts de IA | Sem diário de prompts. Os prompts relevantes são as instruções versionadas dos agentes (`AGENTS.md`, a skill `/marco` com o mapa de tarefa de cada delegação, os três agentes e as regras de `.claude/rules/`), e o `PROMPTS.md` explica isso e aponta para elas | Diário de prompts por marco, como no M0, no M1 e no F1; prompt literal obrigatório em cada entrada | A IA trabalha por um fluxo fixo, e são as instruções dele que a direcionam; elas só mudam por PR revisado e têm histórico no git. O diário repetia o que já fica registrado onde é conferido (critérios, ADs, relatórios de revisão nos PRs e trailers `Assisted-by`), custava tempo a cada marco e envelhecia |
| Perguntas do `setup:local` | `@inquirer/select` 5.2.8 e `@inquirer/input` 5.1.9, só como dependência de desenvolvimento e carregados só quando há terminal interativo: menu com setas para o modo e campo de texto para o login e o item do chaveiro. O token é pedido pelo próprio chaveiro do sistema | `@inquirer/prompts` inteiro; `@clack/prompts`; `node:readline` com lista numerada; campo de senha no Node para o token | O mantenedor quis um setup em que a pessoa seleciona cada opção; os dois pacotes cobrem exatamente o que o setup pergunta e aceitam o piso do Node 24.12, sem os outros oito do pacote completo. Com o chaveiro pedindo o token, ele não passa por este processo nem pela linha de comando |
| Verificação antes do push | `npm run verify` (lint, typecheck, testes unitários, `openapi.yaml`, limites das instruções, migrações e scripts) no `.githooks/pre-push`; `npm run verify:full`, com a integração no Docker, antes do `/security-review` que tira o PR do rascunho; o pre-push confere a árvore de trabalho, então uma mudança ainda sem commit pode esconder um commit vermelho, que o CI pega; `concurrency` no CI, que cancela a execução anterior do mesmo PR (AI-17) | Só o CI; rodar o workflow do CI localmente com `act`; conferências no `pre-commit`; pular o CI em rascunho ou por caminho de arquivo | Cada vermelho no CI custa um ciclo de push, espera, log e correção; o `verify` pega o mesmo erro em cerca de um minuto, antes de o código sair da máquina. O `act` exige Docker e imita o runner só em parte; no `pre-commit`, os testes atrasariam cada commit; pular o CI deixaria um PR sem oráculo. A integração fica fora do pre-push porque pede Docker e leva mais tempo, e o CI continua sendo o oráculo |
| Sessão principal | Opus com `effortLevel: high`, fixos no `.claude/settings.json` do projeto; o `/model` e o `/effort` do mantenedor valem na sessão | `opusplan`; `fable`; `xhigh`; agente orquestrador (`agent` no settings) | O `opusplan` só usa Opus no plan mode, que nenhum passo do fluxo ativa: o planejamento rodou em Sonnet (M1). O padrão vale para quem clona, sem depender da configuração de usuário. O `fable` não é padrão de nenhum plano; o `xhigh` é para tarefas longas, que ficam com os agentes; o agente orquestrador substitui o prompt de sistema |
| Visualização de traces | Jaeger 2.22.0 all-in-one no compose, em memória, recebendo OTLP da API e do worker | Grafana `otel-lgtm`; OpenTelemetry Collector entre a aplicação e o Jaeger; só o exportador de console | Mostra no navegador o trace da requisição ao banco, sem conta em ferramenta, com os mesmos dados que o Datadog receberia (AD-008). O `otel-lgtm` pede 2 GB e pode valer no M5, para os dashboards; o Jaeger recebe OTLP direto, sem Collector |
| Comandos e aprovação | Commit, push e as ferramentas MCP do GitHub sem aprovação; a mensagem do commit num arquivo, com `git commit -F`; a aprovação humana fica no plano e no PR, imposta pelo ruleset (AD-013) | Aprovar cada commit, push e comentário (M1) | Aprovar cada comando não verificava nada: a Anthropic mediu que pedidos constantes levam a aprovar sem ler. A `main` só muda por PR com checks verdes e a aprovação do dono, o que nenhum agente consegue contornar |
| Mensagens de commit | Conventional Commits pelo `@commitlint/config-conventional`, sem regras próprias (cabeçalho até 100 caracteres, descrição em minúscula e sem ponto final); conferido por um hook `commit-msg` local (`.githooks/`, instalado pelo início de sessão) e de novo no CI; trailers `Co-Authored-By` e `Assisted-by: <papel>:<modelo> effort=<nível> step=<degrau>` | Regras próprias (72 caracteres, tipos restritos); conferir só no CI; script próprio | É o padrão da comunidade, e o tipo do commit é o que o CI usa para aceitar uma mudança no bloco `scripts` do `package.json` (só `ci:` ou `build:`, AI-05). Conferir só no CI deixou quatro mensagens erradas chegarem ao PR, e a reescrita custou uma branch nova, porque o push forçado é bloqueado. O `Assisted-by` adapta a convenção do kernel Linux (`Assisted-by: AGENT_NAME:MODEL_VERSION`), acrescentando o esforço e o degrau da escada |
| Registro de decisões | ADs no `STATE.md`, aceitas pelo merge do PR que as propõe; os agentes leem só os blocos `### AD-NNN` citados; o `STATE-ARCHIVE.md` guarda a AD-007 e não recebe mais nada | Um arquivo por decisão | As ADs são curtas e se citam entre si; a leitura por trecho (AD-012) resolve o custo de ler o log inteiro, que era o motivo do arquivo e do limite de tamanho |

## Riscos em aberto

| ID | Risco | Mitigação |
| --- | --- | --- |
| R1 | Fora do `recommendedTypeChecked`, 2 das 61 regras com tipos do `typescript-eslint` não existem no oxlint | Reavaliar quando o `typescript-eslint` aceitar o TypeScript 7 |
| R2 | A validação das requisições é código próprio e pode deixar passar um caso | Testes de contrato por rota (parâmetro desconhecido, tipo errado, cabeçalho ausente, corpo acima do limite); o CI confere o `openapi.yaml` gerado (`FND-07`) |
| R3 | Quem clonar o repositório pode não ter Docker | `npm run test:unit` sem Docker; o CI mostra a suíte completa |
| R4 | O teste de concorrência pode passar sem provar nada | Controle negativo com janela forçada, que precisa vender além do estoque (CHK-02); várias conexões; repetição em laço |
| R5 | Testes intermitentes no CI | Relógio injetável, sem `sleep`, horários semeados no banco, pool fixo |
| R6 | A H1b (deduplicação) ou a H4 (tempo de processamento) podem não valer para um ERP real | Marcador de envio gravado antes da chamada; consulta pela referência depois do primeiro envio, sempre após o atraso mínimo; provada com o fake sem a H1b e com o modo "fatura depois do timeout". **Resíduo:** se a H1b e a H4 falharem juntas, um pedido pode terminar com duas faturas no ERP, ou falho com uma fatura que aparece depois, e a loja não detecta esses casos; um teste acima da H4 os demonstra (ORD-06), e o README os declara. Se nem a H1a valer, a consulta por referência lê o MySQL do ERP, isolada atrás da porta `ErpClient`: é a única exceção à regra de falar com o ERP só pela API |
| R7 | A IA que escreve o código também o revisa | O `reviewer` revisa em contexto limpo, num modelo mais forte; o `test-writer` escreve os testes antes, sem ler a implementação, e a guarda impede o `implementer` de alterá-los e de alterar o CI; o PR sai da identidade configurada no clone, que no modo `bot` é uma conta separada de quem aprova (AD-014), e só entra na `main` com a aprovação do dono, imposta pelo ruleset (AD-013). Resta: o dono pede e aprova, e o relatório do `reviewer` chega ao PR pela sessão principal, então é informação, nunca aprovação |
| R8 | Ferramental recente pode não se integrar (Node 26, OpenTelemetry 3, TypeScript 7, Vitest 5, zod 4 com o gerador de OpenAPI 3.1, Testcontainers no macOS, exporters do OpenTelemetry na linha experimental 0.x) | Versões conferidas pelos peer dependencies e pelo status no npm. Spike no início do M1, pelo `implementer`, com comandos descartáveis: *type stripping* no Node 26 e na 24.12, `tsc`, lint com tipos, Vitest, Testcontainers, node-pg-migrate com `.sql`, um schema zod gerando OpenAPI 3.1 que passa no lint, um span filho e uma métrica. Planos B: `zod-openapi` no lugar do gerador (AD-010), OpenTelemetry 2.12 (AD-011) e o PostgreSQL do compose no lugar do Testcontainers. **Resultado (29/10/2026):** os dez pontos passaram no Node 26.13.0 e na 24.12.0, sem plano B |
| R9 | A H2 pode não valer: o ERP fatura sem estoque e fica negativo | A sincronização grava zero, registra o caso em log, e a loja para de vender o SKU |
| R10 | A guarda de caminho só cobre `Edit`, `Write` e `NotebookEdit`; um agente pode escrever pelo Bash. Visto no F1: o `test-writer` editou testes com scripts `python3` pelo Bash, só dentro do papel dele | O hook de parada roda a verificação a cada fim de agente; a sessão principal confere o `git status` contra o papel antes de cada commit; o CI confere migrações e instruções. A sandbox (R11) restringiria a escrita ao repositório. Commit, push e qualquer mudança de estado do git pelos subagentes são negados pelo `bash-guard` (AI-11) e, se escaparem dele, aparecem no retrato do git comparado na parada (AI-12). A escrita de arquivo pelo shell (interpretadores, `sed -i`, `tee`, redirecionamento para arquivo) também é negada aos subagentes desde o F1; continuam possíveis `node -e`, `cp`, `mv` e `awk`, que só a sandbox fecharia, e o `git status` da parada pega o que cair fora do papel. Fica o push feito por um script que o próprio agente escreva, para uma URL sem `refs/remotes`: o retrato não o vê, mas os rulesets barram push forçado em toda branch e qualquer mudança na `main` sem PR aprovado. Ficam também `.claude/reviews/` e `.claude/state/`: a guarda de caminho as nega às ferramentas de qualquer sessão (AI-15), mas um `touch` ou um `cp` pelo Bash ainda grava nelas, e o `.gitignore` as tira do `git status` da parada; a revisão do diff e o relatório postado no PR são o que resta |
| R11 | Um agente com Bash roda com o usuário do macOS: lê o que o dono lê (`~/.ssh`, o token do `gh` do dono, o chaveiro com o token do bot), e as regras `deny` comparam texto (`/usr/bin/security` passa por `Bash(security *)`) | Sandbox do Bash do Claude Code com leitura de `~/` negada e rede restrita, a validar com o Testcontainers no F1; até lá, as negações de texto e o ruleset, que protege a `main` mesmo com o token do bot vazado. Os hooks também rodam fora da sandbox: o hook de parada executa os testes do código que o `implementer` acabou de escrever, e um módulo que leia o chaveiro ao ser importado leria o token do bot. Contenção: a revisão do diff de `src/` e o escopo do token (só este repositório, com o ruleset); dar validade ao token reduz o dano de um vazamento |

## Lições

### L-001 · Coluna única de estoque apaga reservas

**Contexto.** A primeira proposta de modelo usava uma coluna `available`, decrementada no checkout.
**Problema.** Qualquer carga vinda do ERP sobrescreve essa coluna e apaga as reservas ainda não faturadas.
**Solução.** Separar `on_hand` de `reserved` (AD-002).
**Previne.** Overselling depois de cada carga do ERP.

### L-002 · Carga única congela preço e estoque

**Contexto.** Uma versão do plano trocava a sincronização por uma carga na subida mais a baixa local no faturamento.
**Problema.** Uma mudança de preço ou uma reposição no ERP nunca chegaria à vitrine, e o checkout cobraria o preço da carga.
**Solução.** Sincronização periódica (AD-009).
**Previne.** Preço e disponibilidade incorretos por tempo indeterminado.

### L-003 · Estado do ERP simulado em memória some no reinício

**Contexto.** Uma versão do plano guardava as faturas do ERP simulado na memória do worker.
**Problema.** Um reinício do worker no compose apagaria as faturas que a consulta pela referência precisa encontrar.
**Solução.** Estado do fake no schema `erp_sim` (AD-004).
**Previne.** Fatura duplicada que nenhuma consulta detecta.

### L-004 · Pular a linha na sincronização deixa SKUs sem atualização

**Contexto.** Uma versão da AD-009 pulava o SKU que tivesse baixa local depois da leitura do ERP.
**Problema.** Um SKU com vendas contínuas seria pulado em toda rodada e nunca receberia reposição nem a baixa de outros canais.
**Solução.** Descontar do valor lido as baixas locais posteriores, pelo contador `sold_total`.
**Previne.** Os SKUs mais vendidos ficarem com o estoque mais desatualizado.

### L-005 · O marcador de envio precisa existir antes da chamada

**Contexto.** Versões anteriores da AD-003 consultavam o ERP antes de criar "a partir da segunda tentativa" e, depois, gravavam o marcador de envio sem dizer quando.
**Problema.** O reprocessamento zera o contador de tentativas, e um marcador gravado depois da chamada some quando o worker morre no meio dela. Nos dois casos, a tentativa seguinte criaria sem consultar.
**Solução.** `first_sent_at` gravado na reivindicação, com commit antes da chamada, e nunca apagado.
**Previne.** Fatura duplicada depois de um reprocessamento ou de uma queda do worker.

### L-006 · Sonda com `Edit` inválido não chega à guarda

**Contexto.** O plano do M1 sondava a guarda de caminho com um `Edit` de texto inexistente, para nada mudar se ela falhasse.
**Problema.** O `Edit` inválido para na validação da ferramenta e não chega ao hook: nenhuma sonda foi barrada, e a guarda pareceu quebrada.
**Solução.** Sondar com `Write` de um arquivo novo, que chega ao hook; o arquivo do controle positivo é apagado depois.
**Previne.** Concluir algo sobre uma guarda a partir de uma sonda que nunca a exercitou.

### L-007 · Revisar a correção da correção vira loop, e processo antes do produto custa o prazo

**Contexto.** No M1, três commits entraram depois da última revisão, e cada correção deles ganhou uma rodada nova do `reviewer`.
**Problema.** As Revisões 4 e 5 só acharam problemas criados pela correção anterior; o M1 levou cerca de 19,5 h sem nenhuma regra de negócio, e a primeira proposta de melhoria repetiu o padrão, com 45 itens antes do M2.
**Solução.** Regra de parada (uma rodada por fatia, `baixa` vai para o próximo plano, teto de rodadas) e PR de processo com teto de tempo (AD-012).
**Previne.** Gastar o prazo do produto com o fluxo, e um revisor "que sempre acha alguma coisa" segurar o merge.

## Ideias adiadas

Além da lista "Adicionais" do roadmap:

- redrive automático da DLQ;
- nova conferência dos pedidos falhos, para a fatura tardia do R6;
- confirmação da rejeição antes de marcar o pedido como falho;
- várias réplicas do worker, com a sincronização coordenada e o limite e os pools divididos entre elas;
- cabeçalhos de cache HTTP, quando houver uma CDN;
- faixa "consultar" na vitrine depois de um teto sem sincronização;
- sincronização de um SKU logo depois de uma rejeição por falta de estoque;
- circuit breaker na reivindicação;
- cancelamento automático com consulta prévia;
- invalidação de cache entre processos;
- estoque de um SKU dividido em buckets;
- testes de mutação.
