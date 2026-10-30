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

## Escolhas de ferramenta

| Tema | Escolha | Descartado | Por quê |
| --- | --- | --- | --- |
| Runtime | Node.js 26.13.0 LTS, fixado no `.nvmrc` e na imagem, com `engines` a partir da 24.12 e o CI nas duas linhas (AD-011). ESM, *type stripping* e `erasableSyntaxOnly`. TypeScript 7.0.2 só com `--noEmit` | Node 24 como alvo; build com `tsc`; `tsx` | Sem build, o que roda é o código do repositório. O Node 26 é o LTS ativo, e a 24.12, onde o *type stripping* ficou estável, é o piso para quem clona com o LTS anterior |
| HTTP | Express 5.3.0 | NestJS; Fastify | O Nest depende de decorators, que o Node não aceita no *type stripping*. A validação pelo contrato em zod (AD-010) é um middleware curto no Express, que já se integra ao pino e aos spans manuais do OpenTelemetry; o Fastify faria o mesmo por plugins, sem ganho aqui, porque o framework não é o gargalo: a vitrine responde do cache, e o checkout é uma transação curta |
| Testes | Vitest 5.0.5, supertest 7.3.1, Testcontainers 12.2.1; unitários ao lado do arquivo testado, integração em `test/integration/<área>/` | Mocks do banco; service container no CI; todos os testes em `test/` (PR #1) | As garantias só se provam com banco real, e o caminho é o mesmo na máquina e no CI. O unitário testa um arquivo isolado e muda, move e some com ele; o de integração atravessa HTTP, banco e worker e não pertence a um arquivo. A guarda separa os papéis pelo nome `*.test.ts`, e o `.dockerignore` deixa os testes fora da imagem |
| Migrações | node-pg-migrate 9.0.0, com arquivos `.sql`, *advisory lock* e conferência de ordem; o CI barra a alteração de uma migração que já está na `main` | Runner próprio; Flyway; dbmate; Postgrator; postgres-migrations; graphile-migrate; `@databases/pg-migrations`; umzug | Mantido, roda em Node com o `pg` e mantém as migrações em `.sql` (AD-001); os outros trazem Java, um binário sem API para Node, outro driver, ou não têm lock, transação por arquivo ou versão recente. Não confere o conteúdo do que já rodou; a regra do CI cobre isso no PR |
| Arranque do ferramental (M1) | O `implementer` cria o `package.json`, o lockfile e as configurações e faz o spike do R8 antes do contrato e dos testes, num commit `build:` sem comportamento | O `test-writer` criar as configurações; a sessão principal fazer o spike | O `test-writer` só edita testes, e o contrato e os testes precisam das dependências; um commit `build:` mantém o teste antes do código |
| Guardas dos agentes | Hook `PreToolUse` no `.claude/settings.json`, que identifica o agente pelo `agent_type` e limita as edições de cada papel; regras `ask` para commit, push e escrita no PR, e `deny` para merge, revisão de PR, issue, push forçado e `.env` | Hook no frontmatter de cada agente; regras de Bash como barreira; sandbox | O hook do frontmatter é pulado sem aviso quando a pasta exata não está marcada como confiável, e não roda em `claude -p`; no `settings.json` vale em toda sessão do projeto. Uma regra de Bash compara o texto do comando e não é barreira, então só cobre a forma comum (commit, push, merge). O sandbox isolaria o socket do Docker que o Testcontainers usa |
| Sessão principal | Opus com `effortLevel: high`, fixos no `.claude/settings.json` do projeto; o `/model` e o `/effort` do mantenedor valem na sessão | `opusplan`; `fable`; `xhigh`; agente orquestrador (`agent` no settings) | O `opusplan` só usa Opus no plan mode, que nenhum passo do fluxo ativa: o planejamento rodou em Sonnet (M1). O padrão vale para quem clona, sem depender da configuração de usuário. O `fable` não é padrão de nenhum plano; o `xhigh` é para tarefas longas, que ficam com os agentes; o agente orquestrador substitui o prompt de sistema |
| Visualização de traces | Jaeger 2.22.0 all-in-one no compose, em memória, recebendo OTLP da API e do worker | Grafana `otel-lgtm`; OpenTelemetry Collector entre a aplicação e o Jaeger; só o exportador de console | Mostra no navegador o trace da requisição ao banco, sem conta em ferramenta, com os mesmos dados que o Datadog receberia (AD-008). O `otel-lgtm` pede 2 GB e pode valer no M5, para os dashboards; o Jaeger recebe OTLP direto, sem Collector |
| Comandos que pedem aprovação | Um por chamada, numa linha, sem encadear nem *heredoc*; a mensagem do commit num arquivo, com `git commit -F` | Comandos encadeados; o MCP do GitHub para as escritas no PR | O mantenedor lê o comando inteiro antes de aprovar, e o bloco encadeado era difícil de ler. O commit com `$(cat <<'EOF' …)` ainda pede aprovação mesmo com regra `allow` ([anthropics/claude-code#31373](https://github.com/anthropics/claude-code/issues/31373), ainda aberta em 30/10/2026; a #25441, sobre *heredoc* nas regras, foi fechada em 06/03/2026). O MCP só cobriria o PR, e o commit e o push seguiriam como comandos |
| Mensagens de commit | commitlint 21.2.4 com o `config-conventional` e as regras do `CONVENTIONS.md`, no CI; três cabeçalhos do M1 ficam como exceção no `commitlint.config.mjs` | Script próprio; só a revisão | O limite de 72 caracteres foi violado quatro vezes no M1 sem aviso. O commitlint confere também o tipo e deixa a regra num arquivo, sem script próprio para manter |
| Registro de decisões | ADs no `STATE.md`, com o filtro, a estrutura e o ciclo no `.specs/README.md`; as substituídas vão para `STATE-ARCHIVE.md` perto do limite | Um arquivo por decisão | As ADs são curtas e se citam entre si; num arquivo só, o `planner` lê o log inteiro no início de cada marco, e o limite de tamanho força a consolidação |

## Riscos em aberto

| ID | Risco | Mitigação |
| --- | --- | --- |
| R1 | Fora do `recommendedTypeChecked`, 2 das 61 regras com tipos do `typescript-eslint` não existem no oxlint | Reavaliar quando o `typescript-eslint` aceitar o TypeScript 7 |
| R2 | A validação das requisições é código próprio e pode deixar passar um caso | Testes de contrato por rota (parâmetro desconhecido, tipo errado, cabeçalho ausente, corpo acima do limite); o CI confere o `openapi.yaml` gerado (`FND-07`) |
| R3 | Quem clonar o repositório pode não ter Docker | `npm run test:unit` sem Docker; o CI mostra a suíte completa |
| R4 | O teste de concorrência pode passar sem provar nada | Controle negativo com janela forçada, que precisa vender além do estoque (CHK-02); várias conexões; repetição em laço |
| R5 | Testes intermitentes no CI | Relógio injetável, sem `sleep`, horários semeados no banco, pool fixo |
| R6 | A H1b (deduplicação) ou a H4 (tempo de processamento) podem não valer para um ERP real | Marcador de envio gravado antes da chamada; consulta pela referência depois do primeiro envio, sempre após o atraso mínimo; provada com o fake sem a H1b e com o modo "fatura depois do timeout". **Resíduo:** se a H1b e a H4 falharem juntas, um pedido pode terminar com duas faturas no ERP, ou falho com uma fatura que aparece depois, e a loja não detecta esses casos; um teste acima da H4 os demonstra (ORD-06), e o README os declara. Se nem a H1a valer, a consulta por referência lê o MySQL do ERP, isolada atrás da porta `ErpClient`: é a única exceção à regra de falar com o ERP só pela API |
| R7 | A IA que escreve o código também o revisa | O `reviewer` revisa em contexto limpo, sem ter visto a escrita, num modelo mais forte; o `test-writer` escreve os testes a partir dos critérios, sem ler a implementação, e um hook impede o `implementer` de alterá-los; cada PR é aprovado por uma pessoa |
| R8 | Ferramental recente pode não se integrar (Node 26, OpenTelemetry 3, TS 6, Vitest 5, zod 4 com o gerador de OpenAPI 3.1, Testcontainers no macOS, exporters do OpenTelemetry na linha experimental 0.x) | Versões conferidas pelos peer dependencies e pelo status no npm. Spike no início do M1, pelo `implementer`, com comandos descartáveis: *type stripping* no Node 26 e na 24.12, `tsc`, lint com tipos, Vitest, Testcontainers, node-pg-migrate com `.sql`, um schema zod gerando OpenAPI 3.1 que passa no lint, um span filho e uma métrica. Planos B: `zod-openapi` no lugar do gerador (AD-010), OpenTelemetry 2.12 (AD-011) e o PostgreSQL do compose no lugar do Testcontainers. **Resultado (29/10/2026):** os dez pontos passaram no Node 26.13.0 e na 24.12.0, sem plano B |
| R9 | A H2 pode não valer: o ERP fatura sem estoque e fica negativo | A sincronização grava zero, registra o caso em log, e a loja para de vender o SKU |
| R10 | A guarda de caminho só cobre `Edit`, `Write` e `NotebookEdit`; um agente pode escrever pelo Bash | A sessão principal confere o `git status` contra o papel de cada agente depois de cada chamada, e o `reviewer` confere o histórico de `test/` |

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
