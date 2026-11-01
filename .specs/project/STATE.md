# Estado do projeto

**Atualizado em:** 31/10/2026
**Trabalho atual:** M3 — Processamento assíncrono (M2 concluído)

Este arquivo guarda as decisões de projeto no formato ADR (contexto, decisão, alternativas consideradas, trade-off e quando rever), as escolhas de ferramenta, os riscos, as lições e as ideias adiadas. O "como" de cada decisão está no [`design.md`](../features/casecellshop/design.md). Uma decisão aceita só recebe errata de redação que não muda a decisão, registrada abaixo do status (`.specs/README.md`, "Ciclo"); se a decisão mudar, uma nova `AD` a substitui, e a antiga passa a "substituída por AD-NNN". As versões citadas foram conferidas em 28 e 29/10/2026.

---

## Decisões de arquitetura

### AD-001 · PostgreSQL como banco próprio da loja

**Status:** aceita (29/10/2026). O acesso ao banco por SQL em texto, com ORM e query builder recusados, e as migrações em `.sql` são substituídos pela AD-017.

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

**Status:** aceita (29/10/2026); "a tabela da outbox é a fila" e o motivo para não rodar SQS local são substituídos pela AD-021

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

**Status:** aceita (29/10/2026). A ordem do pedido e da chave na transação é alterada pela AD-020.

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

**Status:** aceita (30/10/2026, PR #4). O teto fixo de rodadas da revisão é substituído pela AD-015, o destino dos achados `baixa` de texto, pela AD-022, e a leitura de uns 10 minutos do mantenedor, pela AD-023.

**Errata (31/10/2026, PR #17):** a última frase do contexto trocou a lista de autores e empresas pelo princípio que ela resumia, sem acrescentar afirmação; a decisão não mudou.

**Contexto.** O M1 entregou o que prometia, mas o processo custou mais que o produto:
- **Documentos:** cerca de 162 KB de documentação de processo para 1.105 linhas de código.
- **Leitura por chamada:** cada agente relia de 65 KB a 147 KB, e o `AGENTS.md` entrava duas vezes, pelo `CLAUDE.md` e pela instrução de lê-lo.
- **Aprovações:** cada commit, push e comentário pedia aprovação humana.
- **Revisão:** o PR teve cinco rodadas. As duas últimas só acharam problemas criados pelas correções anteriores.
- **Limites de palavras:** herdados da skill `tlc-spec-driven`, forçaram commits de compressão.
- **Oráculo exposto:** o `implementer` podia editar o CI e as configurações que decidem se o trabalho dele está certo.

O princípio adotado é a verificação determinística e independente de quem implementa, com o humano na intenção e no merge.

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

**Status:** aceita (30/10/2026, PR #4). A conta fixa do bot é substituída pela AD-014, e os checks obrigatórios, pelo check único `ci-ok` (AI-42, linha "CI em jobs" da tabela de ferramentas).

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

**Status:** aceita (30/10/2026, PR #6). Substitui, na AD-012, o teto fixo de 3 rodadas por fatia e 5 por marco. O destino dos achados `baixa` de texto é substituído pela AD-022.

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

**Status:** aceita (30/10/2026, PR #6). Na camada 1, o CodeQL na configuração padrão é substituído pela configuração avançada versionada do AI-44 (linha "Análise estática de segurança" da tabela de ferramentas).

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

### AD-017 · Consultas e migrações pelo Kysely, com tipos gerados do banco migrado

**Status:** aceita (30/10/2026, PR #7). Substitui, na AD-001, o SQL em texto com tipos escritos à mão, a recusa de query builder e as migrações em `.sql`; e, na tabela de ferramentas, o node-pg-migrate.

**Contexto.** Com SQL em texto e o tipo de cada linha escrito à mão (`pool.query<{ sku: string; available: number }>(…)`), a tabela fica definida duas vezes, e nada liga as duas: uma migração que apaga ou renomeia uma coluna passa no `tsc`, e a consulta só quebra quando roda. Os testes contra o PostgreSQL real pegam a quebra só nas consultas que algum teste executa. Com várias pessoas, um PR que apaga uma coluna e outro que passa a usá-la ficam verdes separados. O desafio é avaliado justamente no SQL de concorrência (atualização condicional, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT`, o relógio do banco), que precisa continuar legível na revisão e não pode ficar fora da conferência de tipos.

**Decisão.**

- **Fonte única:** as migrações definem as tabelas, imutáveis depois da `main` (AI-01). Os tipos do banco são gerados do banco migrado pelo kysely-codegen num arquivo versionado, nunca editado à mão, e o CI falha se esse arquivo divergir do banco (`--verify`).
- **Migrações pelo migrador do próprio Kysely (`Migrator`, de `kysely/migration`), no lugar do node-pg-migrate:**
  - cada migração é um arquivo TypeScript em `migrations/store/` ou `migrations/erp_sim/`, com nome que começa pela data e hora, e exporta `up` e `down`, que recebem `Kysely<any>`;
  - a estrutura é escrita pelo construtor de esquema (`db.schema`), e o `` sql`…` `` fica para o que ele não expressa, como a condição de um CHECK e o `now()` de um valor padrão; por isso a conferência das formas do Kysely (AI-19) não olha as migrações;
  - o `Migrator` lê a pasta pelo `FileMigrationProvider`, com um migrador por schema e a tabela de controle dentro do schema (`migrationTableSchema`); ele reprova migração fora de ordem (o padrão, sem `allowUnorderedMigrations`), espera pelo *advisory lock* e aplica as pendentes de cada schema numa transação só;
  - o `migrate` lança o erro que o resultado do `migrateToLatest()` traz, porque o `Migrator` não lança sozinho; e, pelos ganchos `onFileIgnored` e `import` do provider, recusa o arquivo que o migrador pularia em silêncio, o que não termina em `.ts` e a migração sem `down`;
  - as pastas de migração entram no `include` do `tsconfig.json`, e o lint vale para elas, só sem a regra que proíbe `any`, porque o `Kysely<any>` é o tipo que a migração recebe.
- **Por que a migração também passa ao Kysely:**
  - uma ferramenta só para as consultas e para o esquema;
  - a migração em TypeScript passa pelo `tsc` e pelo lint como o resto do código, e um erro no uso do construtor reprova antes de rodar; os nomes de coluna dentro dela não são conferidos, porque o `Kysely<any>` é o que a documentação do Kysely pede, para a migração continuar valendo quando o esquema mudar depois;
  - sai o node-pg-migrate, uma dependência de produção, e com ele os pacotes que só ele trazia para a imagem (`yargs`, `jiti`, `glob` e as dependências deles): a árvore de produção cai de 128 para 106 pacotes;
  - a subida de cada schema volta inteira quando uma migração falha, e o schema nunca fica entre duas versões; os dois schemas são independentes, então um pode subir e o outro não.
- **Conversão única:** a única migração que já está na `main` (`20260101000000_create_erp_sim.sql`) é reescrita em TypeScript na primeira fatia do M2, com o mesmo esquema, antes de qualquer banco de produção existir. É a única exceção ao AI-01, feita no mesmo PR que passa a conferência a olhar os arquivos `.ts`. O histórico fica na tabela de controle do Kysely, e não na `pgmigrations`; por isso um banco local criado antes precisa ser recriado uma vez (`docker compose down -v`).
- **Consultas pelo Kysely,** um query builder tipado sobre o mesmo driver `pg`: o SQL emitido corresponde quase linha a linha ao código, e o `tsc` acusa todo uso de coluna apagada ou renomeada, inclusive na reserva condicional, na reivindicação com `SKIP LOCKED` e no `ON CONFLICT … RETURNING`. Nenhum comando inteiro fica em SQL cru no código da aplicação; os comandos do runbook, que um operador roda no `psql`, e a limpeza de retenção documentada continuam em SQL.
- **Regras que fecham o que o `tsc` não pega, com conferência determinística no CI:**
  - `set`, `values` e `doUpdateSet` na forma de objeto (`set({ coluna: (eb) => … })`); a forma de callback (`set((eb) => ({ … }))`) deixa passar uma coluna desconhecida;
  - coluna nunca escrita dentro de um fragmento `` sql`…` ``: ela é citada com `eb.ref('coluna')`, e o fragmento cru fica restrito a funções como `now()` e `make_interval(...)`.
- **Transação:** o invólucro faz uma consulta de guarda antes do `COMMIT`, ou usa savepoint, porque um erro capturado dentro da transação faz o PostgreSQL trocar o `COMMIT` por um `ROLLBACK` sem erro.
- **O banco continua guardando a regra:** CHECKs como `reserved >= 0` e `on_hand >= 0` ficam como defesa em profundidade, e os prazos usam o relógio do banco (`now()` no SQL).
- **Erros e traces sem mudança de natureza:** o SQLSTATE chega direto em `err.code` do `pg`, sem embrulho do Kysely, e os spans do repositório continuam manuais (AD-008).

**Alternativas consideradas:**
- **Manter SQL em texto com tipos à mão:** a quebra de esquema só aparece em execução.
- **SQL em texto com tipos de tabela gerados (Kanel):** tipa as tabelas, mas não confere o texto de cada consulta.
- **Script próprio que valida cada SQL no PostgreSQL (`PREPARE`) e gera os tipos:** dá a mesma garantia sem dependência nova, mas usa uma API interna do `pg` e passa a ser ferramenta nossa para manter.
- **PgTyped e sqlx-ts:** o PgTyped sai com sucesso mesmo com consulta inválida, e o sqlx-ts não gera tipos para a reivindicação que usa o `now()` do banco.
- **Prisma 7:** a reivindicação com `SKIP LOCKED`, os prazos no relógio do banco, e os timeouts por transação ficam em SQL cru, conferido só pelo TypedSQL, ainda experimental. No teste, o `updateMany` com `limit` reivindicou a mesma linha mais de uma vez, o `@default(now())` gravou o relógio da aplicação, e o código de erro do PostgreSQL só aparece num campo não documentado.
- **ZenStack 3:** o SQL de concorrência cai no próprio Kysely embutido, com uma camada a mais; no teste, o `updateMany` com `limit` vendeu além do estoque, um campo com `@map` quebrou em execução dentro do `ON CONFLICT`, e a migração depende do Prisma 6.
- **Drizzle (linha estável):** no teste, o migrador pulou em silêncio a migração de um ramo paralelo, e gerar uma migração com renomeação exige terminal interativo; a correção só existe na versão candidata.
- **MikroORM, TypeORM, Objection, Slonik e Effect SQL:** a unidade de trabalho esconde o SQL, os decorators não rodam no Node sem build, os tipos são fracos, ou os tipos são escritos à mão e conferidos só em execução.
- **Manter o node-pg-migrate com as migrações em `.sql`:** o esquema fica em SQL puro e cada arquivo roda na sua transação, mas são duas ferramentas para o mesmo banco, a migração fica fora do `tsc` e do lint, e a imagem leva 22 pacotes a mais.
- **O migrador do Kysely lendo os `.sql` por um `MigrationProvider` nosso:** guarda o SQL puro sem o node-pg-migrate, mas o leitor passa a ser código nosso para manter e testar, e a migração continua fora do `tsc`.
- **O `kysely-ctl`, a linha de comando oficial do Kysely, para aplicar as migrações:** seria dependência nova só para chamar o mesmo `Migrator` que o serviço `migrate` do compose já chama pelo `migrate(pool)`.

**Trade-off.** O Kysely ainda é 0.x, com quebra possível entre versões menores, e por isso fica fixado e é atualizado de propósito; isso agora vale também para o migrador. A geração dos tipos precisa de um banco migrado no CI. As relações viram `join` escritos no código, sem a camada de alto nível de um ORM. Os erros de tipo do builder podem ser longos. A estrutura das tabelas passa a ser lida no construtor de esquema, e não em SQL puro. Como as pendentes rodam numa transação só, uma migração que não roda em transação (um `CREATE INDEX CONCURRENTLY`) obriga a desligar a transação da subida inteira (`disableTransactions`); nenhuma migração planejada precisa disso.

**Rever quando:** o kysely-codegen parar de ser mantido (aí troca-se só o gerador); o Drizzle 1.0 ou o Prisma 8 saírem estáveis com bloqueio de linha e SQL tipado; uma consulta precisar de algo que o builder não expresse sem coluna em fragmento cru; ou uma migração precisar rodar fora de transação.

**Referências:** [Kysely](https://kysely.dev/docs/intro); [Kysely, migrações](https://kysely.dev/docs/migrations); [kysely-codegen](https://github.com/RobinBlomberg/kysely-codegen); [node-pg-migrate](https://salsita.github.io/node-pg-migrate/); [PostgreSQL 18, isolamento de transações](https://www.postgresql.org/docs/18/transaction-iso.html); [Prisma, TypedSQL](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql); [Prisma, issue de `FOR UPDATE`](https://github.com/prisma/prisma/issues/5983); [Prisma, issue do commit silencioso](https://github.com/prisma/orm/issues/20496); [Drizzle, issue do migrador](https://github.com/drizzle-team/drizzle-orm/issues/5769); [ZenStack, migrações](https://zenstack.dev/docs/orm/migration).

### AD-018 · O preço que o cliente viu é obrigatório no checkout

**Status:** aceita (30/10/2026, PR #7).

**Contexto.** A vitrine pode ficar até cerca de 65 s defasada (AD-005, AD-009). Com o preço que o cliente viu opcional no `POST /checkout`, um pedido feito nessa janela seria cobrado pelo preço atual do banco, que pode ser diferente do que o cliente viu, sem que ele saiba.

**Decisão.**

- Cada item do `POST /checkout` leva o `expectedUnitPrice`, o preço que o cliente viu; sem ele, `400`.
- O preço cobrado continua sendo o do banco, nunca o da requisição: o `expectedUnitPrice` só confirma que o cliente concordou com ele.
- Se o preço do banco mudou, `409` (`price-changed`) com o preço atual, nada reservado, e o cliente confirma de novo.

**Alternativas consideradas:**
- **Campo opcional:** sem ele, o cliente pode ser cobrado por um preço que não viu.
- **Cobrar o preço da requisição:** abriria a porta para o cliente escolher o preço.
- **Conferir só a idade da vitrine:** não diz se o preço mudou nesse intervalo.

**Trade-off.** Um cliente que viu um preço que mudou precisa repetir a confirmação, e o cliente da API precisa mandar um campo a mais.

**Rever quando:** o preço passar a ter reserva por tempo (preço garantido por alguns minutos), que dispensaria a confirmação.

**Referências:** [RFC 9110, 409 Conflict](https://www.rfc-editor.org/rfc/rfc9110#name-409-conflict).

### AD-019 · Tipos do banco conferidos por comparação, sem o `--verify` do gerador

**Status:** aceita (31/10/2026, PR #11). Substitui, na AD-017, a conferência dos tipos "com `--verify`".

**Contexto.** A AD-017 manda o CI conferir os tipos gerados com o `--verify` do kysely-codegen. Na versão 0.20.0, quando o `--verify` acha divergência, ele lança antes de fechar a própria conexão com o banco. Nos testes do `FND-09`, essa conexão aberta caía quando o PostgreSQL parava, e o processo recebia 15 erros não capturados.

**Decisão.** O `scripts/check-db-types.ts` roda o gerador sem `--verify`, gravando cada arquivo numa pasta temporária, e compara o conteúdo com o arquivo versionado; com `--write`, copia o gerado para `src/db/types/`. O gerador roda no mesmo processo, pelo `Cli` dele com `config: {}`, que não procura arquivo de configuração. A garantia continua a da AD-017: o CI falha quando um arquivo de tipos diverge do banco migrado.

**Alternativas consideradas:**
- **Manter o `--verify` num processo separado:** a conexão aberta morreria com o processo, mas a URL do banco, com a senha, iria pela linha de comando de outro processo.
- **Manter o `--verify` no mesmo processo e ignorar os erros não capturados:** esconderia uma falha de conexão de verdade.

**Trade-off.** A comparação é nossa, de conteúdo exato, e não a do gerador; uma mudança só de formatação numa versão nova do kysely-codegen também reprova, o que é desejável, porque o arquivo é gerado de novo.

**Rever quando:** o kysely-codegen fechar a conexão antes de lançar no `--verify`.

**Referências:** [kysely-codegen](https://github.com/RobinBlomberg/kysely-codegen).

### AD-020 · A linha do pedido nasce antes da chave de idempotência

**Status:** aceita (31/10/2026, PR #12). Altera, na AD-006, "a chave e o hash do payload normalizado são o primeiro passo da transação".

**Contexto.** A AD-006 põe a chave como primeiro passo do checkout, para uma requisição repetida esperar no índice único antes de qualquer reserva. O esquema da loja (PR #11) liga a chave ao pedido por uma FK obrigatória (`idempotency_keys.order_id NOT NULL`), com o `id` do pedido gerado pelo banco. Com isso, a chave não pode existir antes da linha do pedido.

**Decisão.** A transação do checkout grava primeiro só a linha do pedido, sem itens, e logo depois a chave, com `ON CONFLICT (key) DO NOTHING`. Os itens, a mensagem da outbox e a reserva vêm depois da chave. Numa repetição, ou quando a chave chega com outro corpo, a transação é desfeita, e a linha do pedido some no `ROLLBACK`. O que a AD-006 protege continua valendo: nada é reservado antes da chave, e a requisição concorrente com a mesma chave espera no índice dela.

**Alternativas consideradas:**
- **FK conferida no `COMMIT` (`DEFERRABLE INITIALLY DEFERRED`), com o `id` gerado na aplicação:** a chave fica literalmente em primeiro, mas pede uma migração e muda quem gera o identificador, sem efeito observável de fora.
- **O pedido apontando para a chave, com a referência opcional:** inverte a relação do esquema que já está na `main` e exige migração.

**Trade-off.** Uma requisição repetida grava e desfaz uma linha de pedido a mais.

**Rever quando:** o checkout ganhar passos antes da reserva que custem caro, ou a chave passar a ter vida própria antes do pedido.

**Referências:** [IETF, The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header); [Brandur Leach, Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys); [PostgreSQL 18, Explicit Locking](https://www.postgresql.org/docs/18/explicit-locking.html).

### AD-021 · O SQS é a fila do faturamento; a outbox é a caixa de saída

**Status:** aceita (31/10/2026, PR #13; implementação no PR 2 do M3). Substitui, na AD-003, "a tabela da outbox é a fila" e o motivo dado para não rodar SQS local.

**Contexto.** A AD-003 fez da tabela da outbox a própria fila e descartou o SQS local porque o LocalStack exige token de conta desde a versão 2026.03.0. Esse motivo não fecha a questão: o ElasticMQ roda a API do SQS localmente, sem conta nem token, e as bibliotecas de SQS mais usadas em Node (o `sqs-consumer` da BBC, o `nestjs-sqs`) o usam nos próprios testes com o `@aws-sdk/client-sqs` da versão 3. O PDF avalia retry, DLQ e reconciliação no fluxo do checkout e cita o LocalStack entre os serviços de apoio, e a vaga pede SQS: a fila do faturamento é o lugar onde o SQS mostra o que o desafio avalia.

**Decisão.**

- **Transactional Outbox, só como caixa de saída:** o checkout grava o pedido e a linha da outbox na mesma transação, como hoje. A outbox deixa de ser consumida pelo worker.
- **Message Relay (Polling Publisher):** um processo lê as linhas ainda não publicadas com `FOR UPDATE SKIP LOCKED`, publica em lote no SQS e marca a linha como publicada. Uma queda entre a publicação e a marcação publica de novo: a entrega é pelo menos uma vez.
- **O SQS é a fila:** o worker consome com *long polling*, até as permissões livres do semáforo; o *visibility timeout* faz o papel do lease; o retry muda a visibilidade da mensagem (`ChangeMessageVisibility`) para o atraso mínimo mais o *full jitter*; a mensagem só é apagada depois de gravado o desfecho; a DLQ do SQS recebe a mensagem depois de `maxReceiveCount` = 12 recebimentos, e a reconciliação e o runbook trabalham sobre ela, com o *redrive* (`StartMessageMoveTask`).
- **Idempotent Consumer:** o estado que o SQS não guarda continua no banco, na linha do pedido: o `first_sent_at`, o início da última chamada (para o atraso mínimo da H4) e a consulta ao ERP antes de criar. A conclusão continua por compare-and-set do pedido, e o estoque só muda se o pedido mudou.
- **Emulador local:** o ElasticMQ (`softwaremill/elasticmq-native`, com a versão fixada) no compose e nos testes de integração, sem conta nem segredo. O código só usa o SDK oficial da AWS, então a AWS real é outro endereço. O `@aws-sdk/client-sqs` entra como dependência nova no PR 2 do M3, registrado na tabela de ferramentas.
- **SNS e EventBridge:** ficam na arquitetura alvo, para um segundo consumidor dos eventos de pedido, cada um com a sua fila SQS e a sua DLQ (`ARCHITECTURE.md`, "Mensageria e resiliência"). O desafio tem um consumidor só.

**Alternativas consideradas:**

- **Manter a tabela da outbox como fila (AD-003):** correto e mais simples, mas deixa fora o SQS que a vaga pede e o emulador que o PDF sugere.
- **O SQS só para eventos de outros consumidores, com o worker na outbox:** mostra o SQS rodando num caminho lateral, fora do retry, da DLQ e da reconciliação que o desafio avalia.
- **Floci:** cobre também SNS e EventBridge, mas tem oito meses de vida e falhas de compatibilidade com o SQS corrigidas até outubro de 2026. Fica como troca de imagem se o EventBridge precisar rodar.
- **LocalStack:** exige token desde a 2026.03.0, e a imagem antiga sem token está congelada, sem correções de segurança.
- **Moto e MiniStack:** não implementam o `StartMessageMoveTask` de que o *redrive* precisa.
- **Mock do SDK:** não há fila de verdade, então não prova retry, DLQ nem *redrive* (linha "Testes" da tabela de ferramentas).

**Trade-off.** Um contêiner e uma dependência a mais, e o *visibility timeout* corre no relógio real do emulador, fora do relógio injetável. Os testes não esperam esse relógio: provocam a volta da mensagem com `ChangeMessageVisibility` e `VisibilityTimeout = 0`, como hoje semeiam o `lease_until`, e o atraso mínimo da H4 continua vindo do início da última chamada semeado no banco. Em troca, a fila do faturamento é a mesma que iria para a AWS.

**Rever quando:** surgir um segundo consumidor dos eventos de pedido (entram o EventBridge e um emulador que o cubra), ou o ElasticMQ deixar de acompanhar a API do SQS que o projeto usa.

**Referências:** [AWS Prescriptive Guidance, Transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html); [microservices.io, Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) e [Polling publisher](https://microservices.io/patterns/data/polling-publisher.html); [Amazon SQS, visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [filas de mensagens mortas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) e [redrive](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html); [ElasticMQ](https://github.com/softwaremill/elasticmq); [bbc/sqs-consumer, testes com ElasticMQ](https://github.com/bbc/sqs-consumer); [LocalStack 2026.03.0](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/).

### AD-022 · Erro de texto do próprio PR se corrige no PR, numa rodada só

**Status:** aceita (31/10/2026, PR #13). Substitui, na AD-015, "achado `baixa` nunca bloqueia: vira item do próximo plano" para os erros de texto que o PR introduz.

**Contexto.** Pela AD-015, todo achado `baixa` vai para o plano seguinte, e um erro de texto que o PR introduziu (uma frase da spec que contradiz o design, uma marca errada no `ARCHITECTURE.md`, uma regra com duas leituras) fica publicado até o PR seguinte, lido pelos agentes e por quem avalia o desafio. Quando o M3 passou a corrigir esses erros no mesmo PR, cada correção abriu uma rodada nova, com revisão aberta e um comentário no PR: as Revisões 6 a 9 foram só de texto, e da 6 à 8 cada uma achou mais um ajuste, às vezes criado pela correção anterior. A causa do laço era a revisão aberta a cada correção, não a correção em si.

**Decisão.**

- **Pela origem:** um erro de texto em linha que o PR alterou é corrigido no mesmo PR, nunca mandado para o próximo plano. Uma melhoria em texto que o PR não tocou, e qualquer `baixa` de código ou de teste, vai para o próximo plano. Erro de texto é fato errado, contradição com a spec, o design ou uma AD, referência ou ID quebrado, ou termo divergente; preferência de redação não é achado.
- **Conferência só do delta, na mesma rodada:** o `reviewer` recebe o diff do commit de ajuste e diz se cada achado fechou e se as linhas novas criam erro. Achado em linha que o ajuste não tocou fica fora da conferência e segue a regra acima, então o escopo encolhe a cada conferência e converge. A mesma linha numa terceira conferência vai ao mantenedor, não ao próximo plano, como a terceira rodada sobre o mesmo achado na AD-015.
- **Uma rodada, um relatório:** o PR recebe um só comentário por rodada, o último relatório, com todos os achados da rodada numa tabela (origem, commit da correção, status: corrigido, sem mudança necessária ou adiado) e o resultado de cada conferência. Os commits de ajuste ficam separados, e o histórico guarda a prova de que a IA errou e foi corrigida.
- Decidido pelo mantenedor no M3, depois de pesquisa.

**Alternativas consideradas:**

- **Manter tudo no próximo plano (AD-015):** o erro de texto do próprio PR fica publicado até o PR seguinte, e o que se deixa para depois tende a não ser feito.
- **Uma rodada nova por correção, com revisão aberta:** foi o que gerou o laço das Revisões 6 a 9; um revisor que procura problemas sempre acha algum.
- **Teto de duas conferências, com o resto para o próximo plano:** deixaria publicado um erro do próprio PR.
- **Corrigir sem nova conferência ("aprova com nits"):** a norma entre pessoas pressupõe confiança no autor, e aqui o autor é o mesmo agente que errou; uma correção também erra, como a do A34 mostrou (A36).

**Trade-off.** Conferências curtas a mais no fim da rodada, e o relatório final fica mais longo. Em troca, o erro não sai publicado e o PR mostra uma rodada, não quatro.

**Rever quando:** a soma das conferências de texto de uma rodada passar do tempo de uma rodada de código.

**Referências:** AD-015; L-007; [Google, Code Review Developer Guide: "Cleaning It Up Later"](https://google.github.io/eng-practices/review/reviewer/pushback.html) e ["LGTM with comments"](https://google.github.io/eng-practices/review/reviewer/speed.html); [Claude Code, Code Review](https://code.claude.com/docs/en/code-review-pull-requests) (achados *nit* e *pre-existing*, re-revisão do que mudou); [Claude Code, boas práticas](https://code.claude.com/docs/en/best-practices) ("skip style").

### AD-023 · Relatório curto e resumo de decisão: o mantenedor lê em 2 a 5 minutos

**Status:** aceita (31/10/2026, PR #14). Substitui, na AD-012, a leitura de "uns 10 minutos por marco" da matriz critério × teste e do texto das respostas.

**Contexto.** No M3, os relatórios do `reviewer` tinham de 60 a 110 linhas, com o veredito e os achados misturados ao que foi conferido sem problema e os mesmos achados repetidos em mais de uma seção. A leitura reservada ao mantenedor era de uns 10 minutos por PR, sobre a tabela critério × teste e as seções inteiras do `ARCHITECTURE.md`, e o mantenedor achou isso muito. A sessão principal e o próprio `reviewer` também releem o relatório anterior a cada rodada.

**Decisão.**

- **Relatório do `reviewer`:** veredito e contagens no topo, uma linha por achado aberto numa tabela, o bloco completo (falha, reprodução, correção) só para `alta` e `média`, a rodada anterior numa linha de ID e status, "Conferido sem achado" e "CI e comandos" recolhidos em `<details>`, e um comentário HTML final com as contagens em JSON. Nada que o processo exige sai: a reprodução, o `path:line`, o critério, a numeração estável, o que ficou "a confirmar" e os critérios sem teste, mesmo quando "nenhum". O esqueleto vai como exemplo nas instruções do `reviewer`, junto com a instrução de ajustar o tamanho ao que a tarefa pede.
- **Resumo de decisão no topo do PR,** até ~300 palavras: o que o PR entrega; o que precisa do julgamento do mantenedor (ADs, exceções, `SPEC_DEVIATION`, o trecho alterado de uma resposta `DOC-*`, riscos residuais) ou "nada"; a evidência de máquina, uma linha cada, nesta lista fechada: CI, critérios com teste (N de N, com cada critério sem teste ou teste alterado listado), última revisão, `/security-review`, `app-check` e testes apagados, pulados ou afrouxados; e as áreas de risco tocadas (migração, concorrência, contrato, CI e permissões), com link para o trecho.
- **Leitura do mantenedor:** só o resumo. Uns 2 minutos quando nada pede decisão, mais ~1 minuto por item que pede; alvo de até 5 minutos. Acima disso, o PR deveria ter sido dividido. A tabela critério × teste deixa de ser leitura obrigatória: a máquina a confere, e o resumo mostra só as exceções.
- Decidido pelo mantenedor depois de pesquisa.

**Alternativas consideradas:**

- **Manter o relatório e a leitura de 10 minutos (AD-012):** o veredito fica no meio do texto, e o mantenedor relê o que a máquina já conferiu.
- **Só encurtar o relatório:** reduz tokens, mas a leitura do mantenedor continua sendo a das seções inteiras.
- **Recolher também os achados `alta` e `média`:** esconde justamente o que pede ação.

**Trade-off.** O resumo depende de a sessão principal listar com honestidade o que pede julgamento; se algo que pede decisão ficar fora dele, o mantenedor não o vê. Por isso a evidência de máquina e as áreas de risco são listas fechadas, com "sim" ou "não" para cada item.

**Rever quando:** a leitura passar de 5 minutos em dois PRs seguidos, ou um problema chegar à `main` por um item que o resumo deixou de fora.

**Referências:** [Claude Code, Code Review](https://code.claude.com/docs/en/code-review-pull-requests) (severidades, tabela no check run, raciocínio recolhido, contagens em comentário HTML); [Claude Code, boas práticas](https://code.claude.com/docs/en/best-practices) (o humano aprova o merge com a evidência); [Anthropic, contexto para agentes](https://www.anthropic.com/engineering/effective-context-engineering-for-AI-agents) ("smallest possible set of high-signal tokens"); [GitHub, seções recolhidas](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections); [Google, Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html); [Nielsen Norman Group, pirâmide invertida](https://www.nngroup.com/articles/inverted-pyramid/).

### AD-024 · Uma chamada ao ERP por pedido a cada atraso mínimo, pela permissão de chamada no banco

**Status:** aceita (31/10/2026, PR #15). Detalha a AD-021 no ponto que ela deixou aberto: como o *Idempotent Consumer* impede duas chamadas simultâneas do mesmo pedido.

**Contexto.** Com a fila na tabela da outbox, o lease e o token gravados na linha garantiam uma tentativa por pedido de cada vez. Com o SQS, essa garantia some: o relay publica pelo menos uma vez (AD-021), então duas mensagens do mesmo pedido podem ser recebidas juntas por workers diferentes, e o *visibility timeout* vale por mensagem, não por pedido. Sem a H1b, duas tentativas simultâneas do mesmo pedido (uma consultando enquanto a outra cria) fazem duas faturas.

**Decisão.**

- Antes da primeira chamada ao ERP de cada tentativa, o worker (e a reconciliação) toma a **permissão de chamada** num `UPDATE` só, pelo relógio do banco: grava `last_call_at = now()` e um `call_token` novo, e preenche `first_sent_at` se vazio, só se `last_call_at` está vazio ou mais velho que o atraso mínimo; o `RETURNING` devolve o `first_sent_at` anterior, que decide se consulta antes de criar. A segunda chamada da mesma tentativa (criar depois de consultar) regrava `last_call_at` condicionada ao `call_token`.
- Sem a permissão, a mensagem volta ao SQS pelo tempo que falta. Como o atraso mínimo (45 s) passa de uma chamada (10 s de timeout), a mesma regra cumpre a H4 e impede duas chamadas simultâneas do mesmo pedido.
- O *visibility timeout* fica em 60 s (timeout mais atraso mínimo mais folga), para a mensagem de um worker que morreu quase sempre voltar já depois do atraso mínimo, sem gastar um recebimento só para ser adiada; o prazo que o worker confere antes de cada chamada corre no relógio injetável, a partir do recebimento.
- O desfecho continua por compare-and-set do pedido, e o estoque só muda se o pedido mudou; o *receipt handle* protege só a mensagem no SQS.

**Alternativas consideradas:**

- **Manter lease e token na outbox, junto do SQS:** dois leases para manter coerentes (o do banco e a visibilidade), e o do banco repetiria o que o SQS já faz para a mensagem.
- **Fila FIFO com `MessageGroupId = orderId`:** serializa por pedido no próprio SQS, mas a deduplicação cobre só 5 minutos, e um relay que cai e volta depois disso publica de novo; o banco continuaria precisando do atraso mínimo da H4.
- **Conferir só o `last_call_at` antes de chamar, sem o compare-and-set:** deixa uma janela em que duas tentativas leem o valor antigo e chamam juntas.

**Trade-off.** Uma escrita no banco antes de cada chamada ao ERP, que já existia na primeira parte (gravar o início da chamada), e uma mensagem adiada gasta um recebimento do SQS. Um worker que morre logo depois de tomar a permissão bloqueia o pedido pelo atraso mínimo, que é o mesmo tempo que a H4 já exigia.

**Rever quando:** o ERP passar a garantir a H1b, que torna a exclusão por pedido desnecessária para a fatura, ou a vazão por pedido importar (nunca mais que uma chamada a cada 45 s por pedido).

**Referências:** AD-003; AD-021; [microservices.io, Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html); [Amazon SQS, visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) e [FIFO, deduplicação](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html).

### AD-025 · Pastas por capacidade do negócio e por tecnologia de fronteira

**Status:** aceita (31/10/2026, PR #17)

**Contexto.** Até o M3, o checkout, os pedidos e a saúde tinham pasta própria, mas o faturamento ficou espalhado: `worker.ts`, `reconciliation.ts` e `runbook.ts` na raiz de `src/`, e o relay e a conclusão em `outbox/`. Os módulos usados por todo o código (relógio, configuração, logs, telemetria) também ficavam na raiz, ao lado da fábrica do app. Uma mudança no faturamento atravessava três lugares, e não havia regra de onde entram as capacidades do M4 (vitrine e sincronização). Nos testes, `test/integration/erp/` não correspondia a nenhuma área do `spec.md`, e as migrações de exemplo tinham nomes em português, contra a convenção de idioma.

**Decisão.** A tabela está em [`CONVENTIONS.md`](../codebase/CONVENTIONS.md), "Pastas do código".

- **Uma pasta por capacidade do negócio:** `checkout/`, `orders/`, `health/`, `billing/` e, no M4, `catalog/`. Cada uma guarda as rotas, as consultas e os laços e comandos que rodam fora da requisição. O relay, o worker, a reconciliação, o runbook, a permissão de chamada e a conclusão mudam juntos quando o faturamento muda (AD-021, AD-024), então ficam juntos em `src/billing/`.
- **Uma pasta por sistema externo:** `erp/`, `db/`, `queue/`, `http/` e, no M4, `cache/`. Cada uma tem a porta, definida pela conversa de que o negócio precisa (`ErpClient`, `Queue`), e o adaptador da tecnologia que a atende. O ERP simulado é um adaptador da porta `ErpClient`, e o ERP real entra no lugar dele sem mudar a regra de negócio (AD-004).
- **`src/shared/`** guarda o que todo o código usa e que não conhece o negócio: relógio, configuração, encerramento, logs, telemetria, identidade do serviço e semáforo.
- **`src/main/`** tem uma entrada por processo e monta as dependências de cada processo. **`src/app.ts`** monta o app HTTP (rotas e repositórios) sem abrir porta, para os testes subirem o app pelo supertest.
- As dependências seguem um sentido só: de `main/` para o negócio, e do negócio para a fronteira, o contrato e o `shared/`. A fronteira não importa pastas de negócio, o `shared/` não importa nenhuma outra pasta de `src/`, e uma pasta de negócio não importa outra. O lint confere esse sentido (AD-026).
- Nos testes, a pasta de integração é a área do `spec.md`, como desde o M1. Os testes do ERP simulado vão para a área do critério que provam, e as migrações de exemplo ganham nomes em inglês.

**Alternativas consideradas:**

- **Pastas por camada** (`controllers/`, `services/`, `repositories/`): uma mudança numa capacidade passa por várias pastas, e nada indica o que pertence ao faturamento.
- **Uma pasta `workers/` para tudo que roda fora da requisição:** separa o relay e a reconciliação do pedido e das regras que eles tratam, e obriga `workers/` a importar o interior de `billing/`.
- **Manter os módulos transversais na raiz de `src/`:** a raiz misturaria fábrica, regra de negócio e utilitário, sem critério para o próximo arquivo.
- **Espelhar `src/` em `test/integration/`:** um critério que atravessa pastas (o `FND-05` liga a telemetria ao repositório da saúde) teria os testes espalhados, e a regra por área, em vigor desde o M1, mudaria sem ganho.

**Trade-off.** Uma mudança só de lugar, sem comportamento novo, que mexe em muitos imports e nos caminhos citados na spec e na documentação.

**Rever quando:** uma capacidade nova não couber numa pasta só, ou uma pasta de negócio precisar de outra.

**Referências:**

- Robert C. Martin, *Clean Architecture*, 1.ª ed., cap. 13 ("Component Cohesion", princípio do fechamento comum) e cap. 14 ("Component Coupling", princípio das dependências acíclicas): agrupar o que muda junto e manter as dependências sem ciclo.
- [Alistair Cockburn, *Hexagonal Architecture*](https://alistair.cockburn.us/hexagonal-architecture/), consultado em 31/10/2026: a porta é definida pelo propósito da conversa, e o adaptador é a parte específica da tecnologia; uma porta pode ter vários adaptadores.
- [Mark Seemann, *Composition Root*](https://blog.ploeh.dk/2011/07/28/CompositionRoot/), consultado em 31/10/2026: a montagem das dependências fica junto da entrada de cada processo.
- [Yoni Goldberg et al., *Node.js Best Practices*, "Structure your solution by components"](https://github.com/goldbergyoni/nodebestpractices/blob/194a827cec4006d11df028a6a88397d57a851d59/sections/projectstructre/breakintcomponents.md): estrutura por componentes de negócio em serviços Node.js.

### AD-026 · Limites de tamanho, complexidade e dependências conferidos pelo lint

**Status:** aceita (31/10/2026, PR #17)

**Contexto.** O `.oxlintrc.json` ligava só a categoria `correctness`. Uma auditoria do código em 31/10/2026 achou, em `src/`, uma função de 257 linhas (`createWorker`), cinco funções com complexidade ciclomática entre 11 e 15, o mesmo laço de início e parada escrito três vezes, com diferenças entre as cópias, e variáveis de ambiente lidas fora do módulo de configuração. O código é escrito por agentes, e uma regra só escrita em texto não é cumprida de forma consistente: o que precisa valer sempre tem de ser conferido pela máquina (AD-012). O sentido das dependências da AD-025 também precisava de uma conferência.

**Decisão.** Os limites e as regras estão em [`CONVENTIONS.md`](../codebase/CONVENTIONS.md), "Tamanho e forma do código", e são conferidos pelo `npm run lint` em `src/`, no hook de parada dos agentes, no pre-push e no CI.

- **Tamanho:** 300 linhas por arquivo e 50 por função, contando só linhas com código. Os comentários explicam o porquê (`AGENTS.md`) e não podem empurrar uma função para fora do limite.
- **Complexidade:** 10 de complexidade ciclomática por função, na variante em que um `switch` conta como uma decisão só, porque um `switch` sobre os valores de uma lista fechada (os desfechos do ERP, os códigos do zod) é lido como uma tabela; 4 níveis de aninhamento; e 4 parâmetros (acima disso, um objeto de opções, como as fábricas `createX` já usam).
- **Dependências:** `no-restricted-imports` por pasta confere o sentido da AD-025 e deixa só o `src/main/` importar o ERP simulado; `import/no-cycle` impede ciclos.
- **Configuração:** `node/no-process-env` deixa só o `src/shared/config.ts` ler o ambiente, para os padrões, a validação e as mensagens de erro de cada variável ficarem num lugar só.
- **Testes:** em `*.test.ts`, os limites de linhas por arquivo e por função não valem, porque `describe` e `it` são funções e uma tabela de casos é longa por natureza.
- **Exceção:** um limite não sobe e uma regra não é desligada num arquivo sem uma AD. O `.oxlintrc.json` fica fora do alcance do `implementer` (AI-04).

**Alternativas consideradas:**

- **Os padrões das regras** (complexidade 20, 3 parâmetros): complexidade 20 deixa passar as cinco funções achadas; 3 parâmetros acusaria o middleware de erro do Express, que exige 4. Os outros números (300 linhas por arquivo, 50 por função, aninhamento 4) são os padrões das próprias regras.
- **Complexidade cognitiva** (limite 15) em vez da ciclomática: mede melhor a dificuldade de leitura, mas o oxlint não tem a regra nativa, e as opções (o plugin `sonarjs` pelos plugins em JavaScript, ainda em alfa, ou um pacote de terceiros) trazem uma dependência para uma medida que a ciclomática com aninhamento limitado já aproxima.
- **dependency-cruiser** para o sentido das dependências: cobre camadas e arquivos órfãos, mas é uma dependência a mais para uma regra que o `no-restricted-imports` nativo expressa em poucas linhas.
- **Só a revisão:** o revisor acha o problema depois do código escrito; o lint devolve o agente no próprio hook de parada.

**Trade-off.** As fábricas `createX`, que devolvem um objeto de funções internas, contam as funções internas no tamanho da de fora; elas passam a ter as funções internas no nível do módulo, com as dependências passadas por parâmetro. Uma regra nova acusa o código existente, e o PR que a liga também ajusta o código.

**Rever quando:** um limite exigir dividir uma função em partes que não fazem sentido sozinhas em mais de um caso, ou o oxlint ganhar a regra de complexidade cognitiva nativa.

**Referências:**

- [ESLint, *max-lines*](https://eslint.org/docs/latest/rules/max-lines), consultado em 31/10/2026: "não há um número máximo objetivo" de linhas por arquivo, e as recomendações vão de 100 a 500; o padrão da regra é 300. Os limites desta AD são, portanto, escolha do projeto dentro da faixa usual, e não um número de consenso.
- [ESLint, *complexity*](https://eslint.org/docs/latest/rules/complexity), consultado em 31/10/2026: as variantes `classic` e `modified`.
- Thomas J. McCabe, *A Complexity Measure*, IEEE Transactions on Software Engineering, SE-2(4), 1976: o limite de 10 de complexidade ciclomática por módulo.
- [Google, *TypeScript Style Guide*, "Function Length"](https://google.github.io/styleguide/tsguide.html), consultado em 31/10/2026: sem limite rígido, uma função acima de umas 40 linhas pede que se pense em dividi-la.
- [oxc, regras do oxlint](https://oxc.rs/docs/guide/usage/linter/rules.html), consultado em 31/10/2026: as regras nativas e as que exigem plugin.
- [Anthropic, *Claude Code: Best practices*](https://code.claude.com/docs/en/best-practices), consultado em 31/10/2026: o que precisa acontecer toda vez vai para um hook ou para o CI, não para as instruções.

### AD-027 · Agentes em worktree própria, conferidos pelo que mudou durante a execução

**Status:** aceita (31/10/2026, PR #19)

**Contexto.** A guarda do Bash lê o texto dos comandos e sempre tem uma grafia que escapa: 12 dos cerca de 50 achados de guarda dos PRs #4 a #16 foram brechas na leitura do shell. O hook de parada comparava o `git status` inteiro com o papel, então atribuía ao agente o que a sessão principal tinha deixado sem commit, e o `reviewer` não tinha conferência de escrita. Os agentes também não conseguiam mover nem apagar arquivos, e uma refatoração só de lugar precisava da sessão principal.

**Decisão.**

- O `implementer` e o `test-writer` rodam cada um numa worktree própria (`isolation: worktree`), criada a partir do `HEAD` da branch da sessão principal (`worktree.baseRef: "head"`), com o `node_modules` ligado por link simbólico (`worktree.symlinkDirectories`). Na worktree, o agente move e apaga arquivos do papel; a sessão principal traz a mudança para a branch com um diff aplicado e apaga a worktree.
- A conferência fica no resultado, e não no texto dos comandos: o hook de parada confere a worktree inteira contra o papel, e o que mudou na pasta principal durante a execução (pelo status com o hash de cada arquivo, gravado no início) vira exceção. Sem worktree, só conta o que mudou durante a execução. O `reviewer` não pode mudar arquivo nenhum.
- As guardas de ferramenta bloqueiam quando quebram (`onFailure: "block"`); o hook de parada, em que esse campo não vale, devolve o agente num erro interno.
- O retrato do git deixa de atribuir ao agente o que outra sessão faz no mesmo repositório (AI-33).

**Alternativas consideradas:**

- **Ampliar a lista de comandos que a guarda do Bash recusa** (`mv`, `rm`, `cp`, `node -e`): cada forma nova pede uma regra nova, e os agentes passariam a não conseguir mover arquivos.
- **Ligar a sandbox do Claude Code:** limita a escrita do shell no nível do sistema operacional, mas vale para a sessão inteira, e os testes com Docker e Testcontainers dependem de rede e do socket do Docker; fica no risco R11.
- **Manter os agentes na pasta principal e comparar só o que mudou durante a execução:** corrige a atribuição, mas a sessão principal continua sem poder mexer em nada enquanto o agente roda, e o agente continua sem mover nem apagar arquivos.

**Trade-off.** A sessão principal commita antes de cada delegação e traz a mudança da worktree depois dela. Uma mudança na pasta principal durante a execução de um agente vira exceção, mesmo quando foi feita pela própria sessão principal. Uma worktree nova criada por outra sessão durante a execução também aparece como exceção.

**Rever quando:** o Claude Code oferecer isolamento de escrita por agente no nível do sistema operacional, ou a cópia da worktree passar a custar mais que o ganho.

**Referências:**

- [Anthropic, *Run parallel sessions with worktrees*](https://code.claude.com/docs/en/worktrees), consultado em 31/10/2026: `worktree.baseRef`, as checagens de isolamento e o `cwd` nos hooks.
- [Anthropic, *Create custom subagents*](https://code.claude.com/docs/en/sub-agents), consultado em 31/10/2026: o campo `isolation`.
- [Anthropic, *Hooks reference*](https://code.claude.com/docs/en/hooks), consultado em 31/10/2026: o `onFailure`, que não vale para `Stop` e `SubagentStop`.
- [Anthropic, *Settings reference*](https://code.claude.com/docs/en/settings-reference), consultado em 31/10/2026: `worktree.symlinkDirectories`.

## Escolhas de ferramenta

| Tema | Escolha | Descartado | Por quê |
| --- | --- | --- | --- |
| Runtime | Node.js 26.13.0 LTS, fixado no `.nvmrc` e na imagem, com `engines` a partir da 24.12 e o CI nas duas linhas (AD-011). O piso é imposto pelo `devEngines.runtime` do npm, com `onFail: error`: abaixo dele, `npm install`, `npm ci` e `npm run` param com uma mensagem que diz a versão exigida (`FND-12`); o npm lê esse campo a partir da 10.9.0, e um npm mais antigo só mostra o aviso do `engines`. Na perna do piso, o CI não roda os testes que sobem o `docker compose`, porque a imagem tem o Node do `Dockerfile` nas duas pernas. ESM, *type stripping* e `erasableSyntaxOnly`. TypeScript 7.0.2 só com `--noEmit` | Node 24 como alvo; build com `tsc`; `tsx`; só o Node 26, com uma perna no CI; `engine-strict` no `.npmrc`; checagem própria da versão num script | Sem build, o que roda é o código do repositório. O Node 26 é o LTS ativo desde 28/10/2026, e a 24.12, onde o *type stripping* ficou estável, é o piso para quem clona com o LTS anterior, que segue com suporte até 04/2028. Só o 26 obrigaria quem tem o Node 24 a trocar de versão antes de rodar os testes. O `engines` sozinho é só aviso; o `engine-strict` vale para as dependências instaladas, e o `devEngines` é o campo que o npm documenta para quem trabalha no código do projeto. Rever quando o Node 24 sair de suporte, e aí tirar a perna do piso |
| HTTP | Express 5.3.0 | NestJS; Fastify | O Nest depende de decorators, que o Node não aceita no *type stripping*. A validação pelo contrato em zod (AD-010) é um middleware curto no Express, que já se integra ao pino e aos spans manuais do OpenTelemetry; o Fastify faria o mesmo por plugins, sem ganho aqui, porque o framework não é o gargalo: a vitrine responde do cache, e o checkout é uma transação curta |
| Testes | Vitest 5.0.5, supertest 7.3.1, Testcontainers 12.2.1; unitários ao lado do arquivo testado, integração em `test/integration/<área>/`. Dublês de teste nesta ordem: a implementação real (o PostgreSQL, o ERP simulado e, para fila, o emulador); a falha injetada na fronteira ou uma implementação falsa da nossa porta, para o caso que a real não produz sob demanda, conferindo que a falha aconteceu; o mock que conta chamadas só quando o critério é sobre o número de chamadas; nunca o mock de um SDK de terceiros nem de consultas ao banco | Mocks do banco; mock do SDK da AWS; service container no CI; todos os testes em `test/` (PR #1) | As garantias só se provam com banco real, e o caminho é o mesmo na máquina e no CI. A ordem dos dublês é a do capítulo "Test Doubles" do livro de engenharia do Google ("prefer realism over isolation"): mock em excesso exige manutenção e acha pouco defeito. A redação anterior ("sem mock de banco") proibia a injeção de falha que dois testes do M3 usam com razão (o defeito no status do pedido e a transação abortada no worker). O unitário testa um arquivo isolado e muda, move e some com ele; o de integração atravessa HTTP, banco e worker e não pertence a um arquivo. A guarda separa os papéis pelo nome `*.test.ts`, e o `.dockerignore` deixa os testes fora da imagem |
| Acesso ao banco | Kysely 0.29.7 sobre o `pg`, para as consultas e as migrações, com os tipos gerados do banco migrado pelo kysely-codegen 0.20.0 e conferidos no CI por comparação com o banco migrado (AD-019); `set`/`values` só na forma de objeto e coluna nunca dentro de `` sql`…` `` (AD-017) | SQL em texto com tipos à mão; Kanel; script próprio com `PREPARE`; PgTyped; sqlx-ts; Prisma 7; ZenStack 3; Drizzle 0.45; MikroORM; TypeORM; Slonik | Uma coluna apagada ou renomeada quebra o `tsc` em todo uso, inclusive no SQL de concorrência, que continua legível e sem comando inteiro em SQL cru no código da aplicação; o SQLSTATE segue em `err.code` e os spans do repositório seguem manuais (AD-008); os motivos de cada descarte estão na AD-017 |
| Migrações | O `Migrator` do Kysely, a partir da primeira fatia do M2 (AD-017): arquivos TypeScript com `up` e `down` sobre `Kysely<any>`, um migrador por schema, *advisory lock*, ordem conferida e as pendentes numa transação só; o CI barra a alteração de uma migração que já está na `main`. Até ali, node-pg-migrate 9.0.0 com arquivos `.sql` | node-pg-migrate com `.sql` (o do M1 e do F1); o `Migrator` lendo `.sql` por um leitor nosso; `kysely-ctl`; runner próprio; Flyway; dbmate; Postgrator; postgres-migrations; graphile-migrate; `@databases/pg-migrations`; umzug | A mesma ferramenta das consultas, sem dependência a mais, e a migração passa pelo `tsc` e pelo lint; os motivos de cada descarte do Kysely estão na AD-017. Os outros trazem Java, um binário sem API para Node, outro driver, ou não têm lock ou versão recente. Não confere o conteúdo do que já rodou; a regra do CI cobre isso no PR |
| Arranque do ferramental (M1) | O `implementer` cria o `package.json`, o lockfile e as configurações e faz o spike do R8 antes do contrato e dos testes, num commit `build:` sem comportamento | O `test-writer` criar as configurações; a sessão principal fazer o spike | O `test-writer` só edita testes, e o contrato e os testes precisam das dependências; um commit `build:` mantém o teste antes do código |
| Formatação | Prettier 3.9.10, com a largura padrão de 80 colunas e aspas simples, o estilo que o código já usa; formata o arquivo que um agente edita (hook depois do `Edit` e do `Write`) e reprova no `pre-push` e no CI com `--check`. Ficam de fora o que é gerado e conferido por outra checagem (`openapi.yaml`, `src/db/types/`, `package-lock.json`), as migrações já aplicadas (`migrations/`, AI-01) e o Markdown, que fica com o markdownlint no PR E do F2. A reformatação entrou em dois commits só de formato, listados no `.git-blame-ignore-revs` | oxfmt; Biome; dprint; regra de largura no lint | O lint deixou de cuidar de formatação (o ESLint descontinuou essas regras em 2023, e o oxlint não tem `max-len`); um formatador encerra a discussão de estilo e devolve o mesmo resultado em qualquer máquina. O Prettier é o mais adotado e estável; o oxfmt ainda é 0.x e diverge do Prettier em parte das opções; o formatador do Biome viria com um segundo linter; o dprint tem pouca adoção. As aspas simples evitam reescrever todas as strings do código por uma preferência |
| Código sem uso | knip 6.43.0 (`knip.json`), no `verify` e no CI (AI-35): arquivo inalcançável, dependência sem uso ou não declarada, export que nenhum outro arquivo importa (`ignoreExportsUsedInFile`) | `ts-prune` (descontinuado, aponta para o knip); `noUnusedLocals` do `tsc`, que não vê export nem dependência; `depcheck`, só dependências | Código e dependência sem uso são o que a IA mais deixa para trás ao refatorar, e nenhum outro passo os vê: o `tsc` só acusa variável local. O knip cobre arquivos, exports e dependências numa só passada, lê o `vitest.config.ts` e o `package.json` sozinho e leva cerca de 1 s no repositório |
| Código repetido | jscpd 5.4.2 (`.jscpd.json`), no `verify` e no CI, contra a linha de base `.jscpd-baseline.json` (AI-36) | PMD CPD (exige Java); SonarQube (serviço à parte); limiar de porcentagem sem base | A regra de não repetir ajudante (`.claude/rules/architecture.md`) era só texto. A linha de base congela as repetições que já existiam e reprova só as novas, então a checagem entra sem um PR de limpeza antes; o limiar por porcentagem deixaria uma cópia nova passar enquanto o total ficasse abaixo dele |
| Cobertura | `@vitest/coverage-v8` 5.0.5, na versão do Vitest, só no CI e sobre `src/`, com piso por métrica no `vitest.config.ts` que só sobe (AI-37) | `istanbul` (instrumenta o código e é mais lento); meta fixa de 80 % | A cobertura não prova que o teste confere o resultado, mas a queda dela mostra código novo sem teste. O piso parte do valor medido, para não pedir testes de enfeite agora, e só sobe; o provedor v8 usa a cobertura nativa do Node, sem transformar o código |
| Dependências vulneráveis | `npm audit --omit=dev` no CI (AI-39) | auditar também as de desenvolvimento no PR | Uma vulnerabilidade em dependência de produção vai para a imagem; as de desenvolvimento não rodam em produção e chegam por PR do Dependabot (B3), sem travar o PR de outra mudança |
| Conferência do Kysely | Parte do lint: `no-restricted-properties` do oxlint e a regra local `scripts/lint-rules/kysely.ts`, no formato de regra do ESLint, pelo `jsPlugins` do oxlint e testada com o `RuleTester` dele (AI-19) | o script de expressões regulares (`check-kysely-usage.ts`), que este PR substitui; ast-grep; script com a API do TypeScript; ESLint ao lado do oxlint | Regra de lint própria no formato do ESLint, com o `RuleTester`, é a forma usual de impor um padrão de biblioteca, e roda onde o lint já roda: no hook de parada, no editor, no pre-push e no CI. A árvore de sintaxe fecha as brechas que a leitura por texto deixava (A5 do #12). O ast-grep não lê a lista de colunas dos tipos gerados sem gerar regra a cada migração; um script à parte não roda no editor nem no hook de parada; o ESLint seria um segundo linter. O `jsPlugins` do oxlint ainda é alfa: a versão do oxlint é exata, os testes da regra reprovam se uma atualização a quebrar, e a regra roda no ESLint sem mudança |
| Momento de cada checagem | Cada checagem roda no primeiro momento em que já pega o erro, com custo pequeno perto do ciclo daquele momento, e uma vez só quando o resultado não muda: na edição do agente, o Prettier no arquivo; no fim do agente, lint (com as regras do Kysely e do nome dos testes), tipos, testes ligados à mudança, código sem uso e código repetido; no pre-push, o `verify` (tudo o que não pede Docker); no CI, tudo, com o que não depende da versão do Node uma vez, no job `checks`, inclusive o `npm audit`, e a cobertura uma vez, nos testes do `.nvmrc`; agendado (B3 e PR C), o que muda sem commit, como aviso novo de vulnerabilidade e teste de mutação. Os hooks valem igual no terminal, no VS Code e na sessão remota; quem trabalha sem o Claude tem o editor (AI-41) e o pre-push | tudo só no CI; tudo no pre-push; repetir as checagens nas duas pernas do CI | Um erro custa menos quanto mais cedo aparece, mas uma checagem lenta num momento frequente atrasa todo ciclo: o knip e o jscpd somam cerca de 1 s e cabem no fim do agente, a suíte com Docker leva minutos e fica no CI. Rodar duas vezes o que não depende da versão do Node só gasta o runner. O CI continua a palavra final em qualquer ambiente |
| CI em jobs | `checks` uma vez no Node do `.nvmrc`, `test` na matriz de versões e `ci-ok` como único check obrigatório, com `if: always()` (AI-42); substitui os checks obrigatórios da AD-013 | Um job só com todos os passos nas duas versões; separar os testes unitários dos de integração; `paths-ignore` no workflow; um gate com `needs:` sem `always()`; repetir teste que falhou | As checagens estáticas levam uns 10 s e davam o mesmo resultado nas duas versões, e um lint vermelho interrompia o job antes dos testes; separadas, os dois resultados chegam juntos. A integração domina o tempo, então separá-la não encurta o relógio, e a cobertura e a tabela do AI-18 precisam da suíte inteira. Um job pulado conta como verde, e um gate sem `always()` é pulado quando um job falha; com um check obrigatório só, mudar os jobs não mexe no ruleset. Repetir teste esconderia a corrida, que é o defeito que este serviço mais precisa ver |
| Conferência dos workflows | actionlint e zizmor no job `workflows` do CI (AI-43) | poutine, octoscan, ghalint, action-validator, o OpenSSF Scorecard como gate, a linguagem `actions` do CodeQL | O actionlint pega o YAML que não roda (expressão, contexto, shellcheck do `run:`); o zizmor pega o que roda e é inseguro (action sem SHA, commit de fork no lugar do da action, comentário de versão errado, permissão demais). Só coincidem na injeção de texto no shell. As rejeitadas ou servem a outras plataformas, ou são subconjunto do zizmor, ou ainda estão na versão 0, ou só dão nota; a linguagem `actions` do CodeQL repetiria o zizmor só apontando, sem reprovar o PR. O actionlint baixa pela versão fixa com o sha256 conferido, porque o script oficial vem da branch e não confere nada |
| Análise estática de segurança | CodeQL em configuração avançada, só `javascript-typescript`, fora os testes (AI-44) | o default setup do CodeQL; Semgrep Community Edition; SonarQube Cloud | O CodeQL segue o dado da requisição até a consulta entre arquivos, o que o lint não faz. A configuração avançada é arquivo versionado e revisado no PR; o default setup é uma chave nas configurações, fora do repositório. O Semgrep gratuito só analisa dentro de uma função ou arquivo, e as regras dele têm licença restrita; o SonarQube pede app, conta e segredo |
| Atualização de dependências | Dependabot, com espera de 7 dias (AI-45) | Renovate | O Dependabot só precisa do arquivo no repositório, sem app nem segredo, e atualiza o SHA e o comentário de versão das actions. A espera de 7 dias deixa passar a janela em que uma versão maliciosa costuma ser retirada; as atualizações de segurança não esperam. O Renovate pede app instalado ou token próprio. Exceção de idioma: os títulos e commits do Dependabot ficam em inglês, como ele os escreve |
| Integridade dos pacotes | `npm audit signatures` no job `checks` (AI-42) | OSV-Scanner; Socket | Confere a assinatura do registro e a atestação de cada pacote baixado pelo `npm ci`, sem dependência nova. O `npm audit` procura vulnerabilidade conhecida e não vê adulteração; o OSV-Scanner repete o `npm audit` num projeto só npm, e o Socket pede app e conta |
| Execução agendada | `nightly.yml`: na `main`, as checagens do job `checks`, a suíte com cobertura e os tipos do banco, e a suíte embaralhada em três sementes, com issue quando falha (AI-46) | Contar com o CI do push na `main`; um serviço de testes instáveis (Trunk, BuildPulse, Datadog) | O merge pelo auto-merge usa o `GITHUB_TOKEN`, que não dispara o CI da `main`, e uma vulnerabilidade nova chega sem commit. Embaralhar a ordem acha o teste que depende de outro; a semente fica no log para reproduzir. Os serviços pedem conta, segredo e enviar os resultados para fora. A issue existe porque o aviso de falha do agendamento vai para a conta de máquina |
| Comentários de supressão | Teste de repositório que reprova `oxlint-disable`, `eslint-disable`, `@public`, `@beta`, `@alias`, `jscpd:ignore` e as marcas de cobertura (`istanbul`, `v8`, `c8`, `node:coverage`) em `src/`, `migrations/`, `scripts/` e `.claude/hooks/`, e o `ban-ts-comment` para as diretivas do TypeScript (AI-47) | Uma regra de lint; aceitar a supressão com justificativa; o `--report-unused-disable-directives` do oxlint | A configuração das checagens é negada ao agente (AI-04), mas o comentário fica no arquivo que ele edita, e cala uma regra sem nenhum sinal no CI; o script antigo do Kysely não tinha como ser desligado assim. O oxlint não tem opção que ignore as diretivas do código, e o `--report-unused-disable-directives` só acusa a diretiva que não cala nada. O teste lê o texto, então pega também as marcas do knip, do jscpd e da cobertura |
| Origem dos pacotes | `node scripts/check-lockfile.ts` (lockfile com `packages`; toda entrada, fora a raiz, baixada de `https://registry.npmjs.org/` e com `integrity` sha512; link e pasta local reprovam, porque o projeto não usa workspaces) e só versão exata nos blocos de dependências (AI-05) | `lockfile-lint` | Um bloco de dependências com `npm:`, `file:` ou URL, ou um lockfile apontando outro host, trocaria uma ferramenta da verificação sem mudar o nome dela, e nenhuma checagem via isso. As duas regras cabem num script pequeno nosso, testado como os outros; o `lockfile-lint` faria o mesmo com uma dependência a mais |
| Espera local de versões | `min-release-age=7` no `.npmrc` (AI-50) | Só a espera do Dependabot | A espera de 7 dias do Dependabot não vale para quem roda `npm install` na máquina. Testado: com a chave, o `npm install` recusa uma versão de menos de 7 dias e o `npm ci` instala o que o lockfile fixa, então o CI não muda |
| Piso e linha de base | `node scripts/check-baselines.ts` no PR, contra a `origin/main` (AI-49) | Confiar só na guarda de caminho | A guarda impede o agente de editar o `vitest.config.ts` e a base do jscpd, mas a sessão principal pode afrouxá-los num commit sem que nada acuse; a receita do `--update-baseline` absorve em silêncio uma repetição nova |
| Guardas dos agentes | Desde a AD-027, o `implementer` e o `test-writer` rodam em worktree própria e são conferidos pelo que mudou durante a execução. Hooks no `.claude/settings.json`, pelo `agent_type`: `PreToolUse` limita as edições de cada papel e protege o oráculo do `implementer` (AI-04); `SubagentStop` devolve o `implementer` e o `test-writer` enquanto a verificação falhar (AI-03) e grava a mensagem final do `reviewer` em primeiro plano; o `PostToolUse` do `SubagentHandback` grava o relatório do `reviewer` em segundo plano, e nenhuma sessão edita `.claude/reviews/` nem `.claude/state/` pelas ferramentas (AI-15); o `PostToolUse` do `Skill` registra o `HEAD` em que o `/security-review` abriu, que o `github-guard` exige para tirar o PR do rascunho (AI-16); o `PreToolUse` de Bash (`bash-guard`) deixa os subagentes só ler o git, recusa a eles a escrita de arquivo pelo shell (interpretadores, `sed -i`, `tee`, redirecionamento para arquivo) e aceita o `git push` de qualquer sessão só na forma estreita do fluxo (AI-11); o `SubagentStart` tira um retrato do git que a parada compara, e uma mudança vira exceção (AI-12); o `.githooks/pre-push` recusa push fora de `https://github.com/` (AI-08). Permissões: `git commit`, `git push` (credencial do bot) e as nove ferramentas MCP do GitHub liberados; `gh`, `curl`, `wget`, `security` e `.env` negados; `bypassPermissions` desligado (AI-06) | Hook no frontmatter de cada agente; regras de Bash como única barreira; juiz LLM no loop; para o git dos subagentes, só uma lista de verbos negados; para o SSH, só gravar `remote.origin.pushurl` HTTPS | O hook do frontmatter é pulado sem aviso quando a pasta não está marcada como confiável, e não roda em `claude -p`; no `settings.json` vale em toda sessão. Regra de Bash compara texto, então a barreira real para o `main` é o ruleset (AD-013) e, para a máquina, a sandbox (R11). O hook de parada é determinístico; um juiz LLM muda de veredito (AD-012). O agente em segundo plano entrega o relatório pelo `SubagentHandback`, fora da mensagem final que o hook de parada recebe; ler a transcrição dependeria de um formato interno, e o `PostToolUse` dessa ferramenta é o caminho documentado. Uma guarda de texto sempre tem grafia que escapa (variável, alias, script escrito pelo próprio agente), então ela só dá retorno rápido, e a prova é o retrato do git, que não depende da grafia; a lista do que pode passar fecha por padrão, e a de negados deixava passar `pull`, `cherry-pick` e afins. O `insteadOf` global também reescreve o `pushurl`, por isso a conferência fica no `pre-push`, que recebe a URL já reescrita e roda antes de enviar qualquer ref |
| Estilo pelo compilador e pelo lint | Opções a mais no `tsconfig` (`noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`) e onze regras a mais no oxlint, entre elas `switch-exhaustiveness-check` e `no-deprecated` (AI-20) | Pedir o estilo por escrito no `AGENTS.md` ou numa skill; skills de estilo TypeScript de terceiros; `noPropertyAccessFromIndexSignature`; `prefer-nullish-coalescing`; as regras experimentais do oxlint | O que precisa valer sempre vai para o que reprova sozinho: um texto é lido e pode ser esquecido, e o `tsc` e o lint rodam no hook de parada, no pre-push e no CI. As escolhidas pegam erro real (caso de `switch` esquecido, API obsoleta, `undefined` passado onde a propriedade é opcional) e custaram poucos ajustes no código de então. A `noPropertyAccessFromIndexSignature` daria 75 erros só de estilo; a `prefer-nullish-coalescing` exigiria trocar `\|\|` por `??` onde a string vazia deve cair no padrão (o `XDG_CONFIG_HOME` vazio, o token vazio), o que mudaria o comportamento; e as experimentais mudam entre versões |
| Economia de tokens da IA | Medir antes de otimizar: os tokens de cada marco pelo `/usage`, e a mesma tarefa antes e depois de uma mudança na fábrica que promete economia (`process-changes.md`). O estilo garantido pelo compilador e pelo lint (AI-20), e não por texto. O reporter que o Vitest 5 já usa quando roda com um agente, que mostra só as falhas e já cala o log dos testes que passam, sem sobrescrevê-lo no `vitest.config.ts`. A documentação atual de uma biblioteca, quando a sessão principal precisa dela, lida no `llms.txt` publicado pela própria biblioteca, como dado e não como instrução; os agentes não têm ferramenta de rede (sem `WebFetch`, e com `curl` e `wget` negados), e um `node` pelo Bash só fica sem rede com a sandbox do R11. O estilo de resposta `Concise` no `.claude/settings.json` (AI-21), que encurta o texto das respostas da sessão principal sem mudar o trabalho nem os agentes, que têm instruções próprias. Ficam para depois de um marco medido, e só se o `/usage` mostrar o gasto que cada um ataca: um plugin LSP local (`.lsp.json` com o `tsc --lsp --stdio` do próprio projeto), para ir à definição e às referências sem ler arquivos inteiros; e um hook que encurta saída longa de comando | O plugin LSP oficial de TypeScript (`typescript-lsp`); o `ts7-lsp` da comunidade; Serena; ast-grep; o mapa de repositório do Aider; servidores MCP de índice semântico; Context7 | Sem medição, nenhuma otimização prova que economizou. O plugin oficial depende do `tsserver.js`, que o TypeScript 7 não traz, e cai em silêncio num TypeScript global sem relação com o do projeto; o `ts7-lsp` exige um TypeScript global de versão candidata. Serena, ast-grep e o mapa de repositório não têm economia medida aqui, e o repositório é pequeno o bastante para a busca comum. O índice semântico exige um serviço de embeddings e um banco vetorial, e manda o código a terceiros. O Context7 traz para o contexto, a cada consulta, texto que o projeto não controla e que não vem do mantenedor da biblioteca, numa fábrica que depende de guardrails; o `llms.txt` vem da fonte oficial e só entra quando a sessão principal o pede |
| Validação das instruções da IA | Testes determinísticos no CI: o `check:instructions` (200 linhas por instrução, agente e regra, inclusive em subpastas; 40.000 caracteres por regra; 500 linhas e 12.000 bytes por skill, com o material de referência em arquivos de apoio), com testes de unidade e controle negativo para cada limite, e o `AI-13`, que abre o frontmatter dos agentes e da skill com o `yaml` do projeto e só aceita os campos da referência do Claude Code. Auditoria do texto dos agentes por um agente independente, com fonte e linha por achado, quando as instruções mudam muito | `/doctor` ou `/doctor prompt-audit` no CI ou num hook do git; `claude doctor`; `claude plugin validate`; um linter de terceiros; validar o `settings.json` contra o schema com o `ajv-cli` | Um agente com YAML quebrado ou campo com erro de digitação é ignorado sem aviso na sessão, e uma skill maior que o que a compactação devolve ao contexto perde o fim do roteiro no meio do marco, então a conferência precisa ser automática e falhar no CI; o limite da skill é em bytes porque o CI não tem contador de tokens sem rede. O `/doctor` é interativo e não tem código de saída, o `claude doctor` e o `plugin validate` não pegaram YAML quebrado na versão em uso, e um linter de terceiros seria dependência nova sem ganho sobre os testes. O schema do `settings.json` fica para quando houver uma decisão sobre o `ajv-cli` |
| Prompts de IA | Sem diário de prompts. Os prompts relevantes são as instruções versionadas dos agentes (`AGENTS.md`, a skill `/marco` com o mapa de tarefa de cada delegação, os três agentes e as regras de `.claude/rules/`), e o `PROMPTS.md` explica isso e aponta para elas | Diário de prompts por marco, como no M0, no M1 e no F1; prompt literal obrigatório em cada entrada | A IA trabalha por um fluxo fixo, e são as instruções dele que a direcionam; elas só mudam por PR revisado e têm histórico no git. O diário repetia o que já fica registrado onde é conferido (critérios, ADs, relatórios de revisão nos PRs e trailers `Assisted-by`), custava tempo a cada marco e envelhecia |
| Perguntas do `setup:local` | `@inquirer/select` 5.2.8 e `@inquirer/input` 5.1.9, só como dependência de desenvolvimento e carregados só quando há terminal interativo: menu com setas para o modo e campo de texto para o login e o item do chaveiro. O token é pedido pelo próprio chaveiro do sistema | `@inquirer/prompts` inteiro; `@clack/prompts`; `node:readline` com lista numerada; campo de senha no Node para o token | O mantenedor quis um setup em que a pessoa seleciona cada opção; os dois pacotes cobrem exatamente o que o setup pergunta e aceitam o piso do Node 24.12, sem os outros oito do pacote completo. Com o chaveiro pedindo o token, ele não passa por este processo nem pela linha de comando |
| Verificação antes do push | `npm run verify` (lint, formato (`prettier --check`, AI-34), typecheck, testes unitários, `openapi.yaml`, limites das instruções, migrações, `package.json`, código sem uso e código repetido) no `.githooks/pre-push`; `npm run verify:full`, com a integração no Docker, antes do `/security-review` que tira o PR do rascunho; o pre-push confere a árvore de trabalho, então uma mudança ainda sem commit pode esconder um commit vermelho, que o CI pega; `concurrency` no CI, que cancela a execução anterior do mesmo PR (AI-17). O mantenedor aceitou o tempo medido em 31/10/2026 (commit-msg ~1 s, pre-push ~31 s, 23 s deles no teste do hook de parada): não entra em plano otimizar os hooks, salvo se o tempo piorar bastante ou ele pedir | Só o CI; rodar o workflow do CI localmente com `act`; conferências no `pre-commit`; pular o CI em rascunho ou por caminho de arquivo | Cada vermelho no CI custa um ciclo de push, espera, log e correção; o `verify` pega o mesmo erro em cerca de um minuto, antes de o código sair da máquina. O `act` exige Docker e imita o runner só em parte; no `pre-commit`, os testes atrasariam cada commit; pular o CI deixaria um PR sem oráculo. A integração fica fora do pre-push porque pede Docker e leva mais tempo, e o CI continua sendo o oráculo |
| Sessão principal | Opus com `effortLevel: high`, fixos no `.claude/settings.json` do projeto; o `/model` e o `/effort` do mantenedor valem na sessão | `opusplan`; `fable`; `xhigh`; agente orquestrador (`agent` no settings) | O `opusplan` só usa Opus no plan mode, que nenhum passo do fluxo ativa: o planejamento rodou em Sonnet (M1). O padrão vale para quem clona, sem depender da configuração de usuário. O `fable` não é padrão de nenhum plano; o `xhigh` é para tarefas longas, que ficam com os agentes; o agente orquestrador substitui o prompt de sistema |
| Fila do faturamento (AD-021) | `@aws-sdk/client-sqs` 3.1161.0, o SDK oficial, sem biblioteca de consumidor por cima; ElasticMQ `softwaremill/elasticmq-native` 1.7.1 no compose (filas criadas pelo `elasticmq.conf`, mensagens persistidas num volume) e pelo `GenericContainer` do Testcontainers nos testes | `sqs-consumer`; a imagem JVM do ElasticMQ; o ElasticMQ só em memória; LocalStack, Floci, Moto e MiniStack (AD-021) | O worker precisa adquirir as permissões do semáforo antes de receber e decidir a visibilidade de cada mensagem, o que o laço de uma biblioteca de consumidor esconde. Conferido no ElasticMQ 1.7.1 (31/10/2026): a visibilidade 0 devolve a mensagem na hora; a DLQ recebe no recebimento seguinte ao 12º; o *redrive* zera o `ApproximateReceiveCount`; um *receipt handle* antigo é recusado com `ReceiptHandleIsInvalid`. A imagem nativa sobe em ~50 ms contra ~1,6 s da JVM, mas o `ListMessageMoveTasks` a derruba, então nada no projeto o chama (R12). Em memória, um reinício do emulador perderia as mensagens que a outbox já marcou como publicadas |
| Visualização de traces | Jaeger 2.22.0 all-in-one no compose, em memória, recebendo OTLP da API e do worker | Grafana `otel-lgtm`; OpenTelemetry Collector entre a aplicação e o Jaeger; só o exportador de console | Mostra no navegador o trace da requisição ao banco, sem conta em ferramenta, com os mesmos dados que o Datadog receberia (AD-008). O `otel-lgtm` pede 2 GB e pode valer no M5, para os dashboards; o Jaeger recebe OTLP direto, sem Collector |
| Comandos e aprovação | Commit, push e as ferramentas MCP do GitHub sem aprovação; a mensagem do commit num arquivo, com `git commit -F`; a aprovação humana fica no plano e no PR, imposta pelo ruleset (AD-013) | Aprovar cada commit, push e comentário (M1) | Aprovar cada comando não verificava nada: a Anthropic mediu que pedidos constantes levam a aprovar sem ler. A `main` só muda por PR com checks verdes e a aprovação do dono, o que nenhum agente consegue contornar |
| Mensagens de commit | Conventional Commits pelo `@commitlint/config-conventional`, sem regras próprias (cabeçalho até 100 caracteres, descrição em minúscula e sem ponto final); conferido por um hook `commit-msg` local (`.githooks/`, instalado pelo início de sessão) e de novo no CI; trailers `Co-Authored-By` e `Assisted-by: <papel>:<modelo> effort=<nível> step=<degrau>` | Regras próprias (72 caracteres, tipos restritos); conferir só no CI; script próprio | É o padrão da comunidade, e o tipo do commit é o que o CI usa para aceitar uma mudança no bloco `scripts` do `package.json` (só `ci:` ou `build:`, AI-05). Conferir só no CI deixou quatro mensagens erradas chegarem ao PR, e a reescrita custou uma branch nova, porque o push forçado é bloqueado. O `Assisted-by` adapta a convenção do kernel Linux (`Assisted-by: AGENT_NAME:MODEL_VERSION`), acrescentando o esforço e o degrau da escada |
| Registro de decisões | ADs no `STATE.md`, aceitas pelo merge do PR que as propõe; os agentes leem só os blocos `### AD-NNN` citados; o `STATE-ARCHIVE.md` guarda a AD-007 e não recebe mais nada | Um arquivo por decisão | As ADs são curtas e se citam entre si; a leitura por trecho (AD-012) resolve o custo de ler o log inteiro, que era o motivo do arquivo e do limite de tamanho |
| Evidência rodando o app | Antes de o PR de um marco sair do rascunho, a sessão principal roda a skill de projeto `app-check` (AI-22): sobe o compose com um nome de projeto próprio, percorre checkout, worker e status com as chamadas HTTP feitas de dentro dos contêineres, lê o `/metrics` e os logs do worker, e põe a saída numa seção da descrição do PR; o que aparecer de inesperado vira achado. Uma vez por PR, no HEAD que vai sair do rascunho. A receita respeita as guardas do projeto (o `curl` negado e os comentários só do `reviewer` e da revisão de segurança) e foi rodada de ponta a ponta antes de entrar. Decidida pelo mantenedor no M3 e posta no PR #13, como exceção à regra do PR próprio de processo | Uma etapa ou um agente de QA; só o teste de ponta a ponta no CI; a skill com o nome `verify`; um script `npm run smoke` | Os testes provam o que afirmam, e o teste de ponta a ponta do `ORD-19` já cobre o fluxo a cada push; ler a saída real pega o que nenhuma asserção previu (um campo de log, um nome de métrica, a montagem do processo). Uma skill de projeto é o formato que o Claude Code documenta para a receita de rodar o app; com o nome `verify`, ele a rodaria antes de cada commit, o que repetiria o CI a cada fatia. Uma etapa de QA repetiria o `test-writer` e o `reviewer` |

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
| R11 | Um agente com Bash roda com o usuário do macOS: lê o que o dono lê (`~/.ssh`, o token do `gh` do dono, o chaveiro com o token do bot), e as regras `deny` comparam texto (`/usr/bin/security` passa por `Bash(security *)`, e um `curl` chamado pelo caminho absoluto, como `/usr/bin/curl`, passa pelo `deny` do `curl`) | Sandbox do Bash do Claude Code com leitura de `~/` negada e rede restrita, a validar com o Testcontainers no F1; até lá, as negações de texto e o ruleset, que protege a `main` mesmo com o token do bot vazado. Os hooks também rodam fora da sandbox: o hook de parada executa os testes do código que o `implementer` acabou de escrever, e um módulo que leia o chaveiro ao ser importado leria o token do bot. Contenção: a revisão do diff de `src/` e o escopo do token (só este repositório, com o ruleset); dar validade ao token reduz o dano de um vazamento |
| R12 | O ElasticMQ não é o SQS: a imagem nativa 1.7.1 cai com o `ListMessageMoveTasks`, perde acentos das mensagens ao recarregar do disco, e o *receipt handle* antigo é recusado, enquanto na AWS o `DeleteMessage` com ele pode ser aceito sem apagar | O código não chama o `ListMessageMoveTasks`; o corpo e os atributos da mensagem são ASCII pelo schema; o worker trata o `stale` e um sucesso aparente da mesma forma (a mensagem que voltar encontra o pedido com desfecho e é apagada); o compose reinicia o emulador, e as mensagens persistem no volume. Na AWS, só muda o endereço |

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
