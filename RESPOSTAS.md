# Respostas às cinco perguntas

Texto de entrega da Parte 1.A do desafio. Cada resposta segue os tópicos da pergunta na ordem do enunciado, aponta para a seção do [`ARCHITECTURE.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md), onde estão as comparações completas, e cita os critérios do [`spec.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/.specs/features/casecellshop/spec.md) que a provam. Os critérios `DOC-*` conferem o texto; os outros (`CHK-*`, `ORD-*`, `CAT-*`, `OBS-*`) são testes automatizados com o mesmo ID no nome.

Esta é a cópia versionada (`DOC-ENT-01`). Enquanto o projeto não chega ao M6, o que ainda não está implementado leva a marca do marco que o entrega (**[M4]**, **[M5]**), como no `ARCHITECTURE.md`; **[alvo]** é arquitetura alvo, fora do escopo do desafio.

## 1. Diagnóstico, trade-offs e arquitetura alvo

Seção: [Diagnóstico e arquitetura alvo](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#diagnóstico-e-arquitetura-alvo). Critérios: `DOC-DIA-01` a `DOC-DIA-06`.

**Causa raiz** (`DOC-DIA-01`). Os três problemas têm a mesma origem: a loja trata um ERP legado, que não pode ser alterado, como se fosse o banco dela.

- **Vitrine lenta:** o sistema de registro do ERP está no caminho de leitura de alto volume. A carga nele cresce com o tráfego da loja, e a capacidade dele não.
- **Overselling:** a disponibilidade é checada num momento e baixada em outro (*check-then-act*), e a janela entre os dois cresce com a latência do ERP.
- **Checkout frágil:** o faturamento é síncrono, com mediana de ~3 s e p99,9 de 8 s; timeouts e retries sem idempotência duplicam pedidos, e sem registro durável antes da chamada uma queda deixa o pedido sem rastro.

**Impacto** (`DOC-DIA-02`). Para o cliente: páginas lentas, compra confirmada e depois cancelada, pedido em dobro. Para o negócio: conversão menor no pico, estornos e faturas duplicadas, e o risco de a vitrine degradar o faturamento, que divide o mesmo ERP. Para a operação: cada pico vira incidente no ERP, e sem rastreabilidade por pedido cada caso exige procurar nos logs do ERP.

**Caminhos comparados** (`DOC-DIA-03`), em custo, complexidade, latência, consistência e esforço operacional:

- **vitrine:** cache na frente da API do ERP, banco da loja com sincronização e cache em memória (escolhido), ou CDC do MySQL do ERP. A leitura direta do MySQL do ERP, que o enunciado permite, foi descartada: as tabelas internas não são contrato, e a carga continuaria no banco que fatura; fica só como plano B da consulta por referência;
- **overselling:** `UPDATE` condicional atômico no banco da loja (escolhido), `SELECT … FOR UPDATE`, ou lock distribuído no Redis;
- **checkout:** síncrono com timeout maior e retry, `202` com outbox no banco da loja e worker (escolhido), ou `202` com publicação direta num broker.

**Arquitetura de 30 a 90 dias** (`DOC-DIA-04`). Dias 0 a 30, tirar o ERP do caminho do cliente: banco próprio da loja, checkout com reserva atômica, idempotência e `202`, fila SQS alimentada pela outbox, worker de envio e de sincronização, cache em processo na vitrine e observabilidade básica. Dias 30 a 60, operar com segurança: reconciliação com o ERP e runbook, SLOs, alertas e dashboard, um cache L2 compartilhado com várias instâncias da API, e autenticação na borda **[alvo]**. Dias 60 a 90, escalar e reduzir a defasagem: CDC no lugar da sincronização se a defasagem medida pedir, EventBridge com um segundo consumidor, várias réplicas do worker e a migração para a nuvem **[alvo]**.

**Nuvem** (`DOC-DIA-05`). É hipótese de evolução do datacenter atual, não premissa: cada componente tem um serviço gerenciado (RDS ou Aurora, ECS no Fargate, SQS, ElastiCache, Datadog ou CloudWatch, Secrets Manager), justificado pelo esforço operacional que tira. O ERP fica no datacenter, e a conexão híbrida (VPN ou link dedicado) passa a ser uma fonte de latência e de falha; para a loja, a queda do link é uma queda do ERP, que o desenho já absorve.

**Diagrama** (`DOC-DIA-06`): em Mermaid, no fim da seção.

## 2. Cache, invalidação e vitrine

Seção: [Cache e performance da vitrine](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#cache-e-performance-da-vitrine). Critérios: `DOC-CAC-01` a `DOC-CAC-04`; testes `CAT-01` a `CAT-13` e `CHK-06` **[M4]**.

**Camadas e o papel de cada uma** (`DOC-CAC-01`):

- **CDN e cache HTTP:** fora do escopo para o catálogo, que responde `Cache-Control: no-store` (`CAT-10`). Uma camada fora do serviço serviria dado defasado sem aparecer nas métricas, e sem o cabeçalho um cache intermediário pode aplicar frescor heurístico (RFC 9111). Com uma CDN, ela serve os estáticos, e o catálogo passa a levar `max-age` igual ao TTL restante **[alvo]**;
- **em processo (L1):** o catálogo inteiro numa entrada, de onde as páginas são fatiadas, com TTL de 5 s ± 10%. Absorve as leituras: o banco recebe no máximo uma consulta por instância a cada TTL, qualquer que seja o tráfego;
- **L2 compartilhado (Redis):** entre as instâncias da API, quando houver várias com taxa de acerto baixa **[alvo]**. Com uma instância, seria um contêiner e um modo de falha a mais sem ganho;
- **banco da loja:** a cópia de catálogo, preço e estoque, atualizada pela sincronização a cada 60 s. É a origem do cache e a fonte de verdade do checkout, e é a camada que tira o ERP do caminho da vitrine.

As defasagens somam: com o ERP respondendo, uma mudança chega à vitrine em até 65,5 s mais a duração de uma rodada de sincronização (60 s do intervalo mais 5,5 s do TTL; `CAT-06`).

**TTL, invalidação, cache-aside × refresh-ahead, fallback e stampede** (`DOC-CAC-02`):

- **TTL de 5 s ± 10%:** a maior parte da defasagem vem da sincronização; um TTL menor multiplicaria as consultas para ganhar segundos num limite de 65,5 s, e o jitter espalha as expirações entre instâncias (`CAT-02`);
- **invalidação só por expiração:** um aviso entre processos a cada correção tiraria no máximo 5,5 s do limite e acrescentaria um caminho de falha que, quando falha, deixa o TTL como limite de qualquer jeito. O cache nunca decide: o preço que o cliente viu é conferido no banco (`409` com o preço atual, `CHK-06`), e a reserva é o `UPDATE` condicional (`CHK-01`);
- ***cache-aside*, e não *refresh-ahead*:** o *refresh-ahead* e o *stale-while-revalidate* escondem a latência de uma origem lenta. Aqui a origem é um banco local, e o que eles escondem é uma consulta a cada 5 s; a origem lenta era o ERP, que a arquitetura tirou do caminho;
- **fallback:** com a origem em erro, a entrada vencida é servida até 60 s (*stale-if-error*), e por 5 s depois da falha sem tentar a origem; sem entrada, `503` com `Retry-After` (`CAT-04`); antes da primeira sincronização, `503` (`CAT-05`). O ERP fora não afeta a vitrine: a sincronização para, e o banco segue com o último estado conhecido;
- **stampede:** *single-flight*, em que N leituras com a entrada vencida geram uma consulta à origem (`CAT-01`), uma chave só, a promessa rejeitada descartada, o jitter e a pausa depois da falha. A disponibilidade em faixas ("disponível", "últimas unidades", "esgotado") faz a defasagem aparecer menos (`CAT-13`).

**Métricas de ganho de latência e de custo** (`DOC-CAC-03`):

- **latência:** `http.server.request.duration` na rota `/products`, com fronteira em 0,2 s para o SLO de 99% em até 200 ms;
- **taxa de acerto:** `casecellshop.catalog.cache.lookups` (`hit`, `miss`, `stale`), esperada perto de 1 − 1/(R × TTL) por instância;
- **carga na origem:** `casecellshop.catalog.origin.loads` (`ok`, `error`) por requisição, no máximo ~0,2 por segundo por instância; `casecellshop.catalog.origin.active_loads` no máximo 1 por instância mostra o *single-flight* funcionando;
- **chamadas ao ERP evitadas:** as requisições da vitrine menos as chamadas `list_catalog` do `casecellshop.erp.client.operation.duration`. Antes, uma chamada ao ERP por acesso; agora, uma leitura do catálogo por minuto, constante com o tráfego;
- **custo:** nenhum servidor a mais, e a capacidade do ERP (~30 chamadas simultâneas, ~21 usadas pelo faturamento no pico) deixa de ser disputada pela vitrine.

**Métricas de que o ganho não veio de dado velho ou incorreto** (`DOC-CAC-04`):

- **idade da entrada servida** (`casecellshop.catalog.served_entry.age`): até 5,5 s, e até 60 s só em *stale-if-error*;
- **idade da sincronização** (`casecellshop.catalog.sync.age`), lida do banco e exposta pela API, para alertar mesmo com o worker caído. Somadas, as duas idades limitam a idade do que o cliente vê;
- **preço alterado no checkout** (`price_changed` em `casecellshop.checkout.requests`): a vitrine mostrou um preço que já não valia, e o cliente recebeu `409`, sem ser cobrado por outro valor;
- **SKUs com promessa acima do estoque** (`casecellshop.inventory.oversold_skus`) e **rejeições por falta de estoque no ERP** (`casecellshop.erp.out_of_stock.rejections`, `OBS-06`);
- **correções por rodada** (`casecellshop.catalog.sync.corrections`) e **SKUs ausentes** (`casecellshop.catalog.sync.missing_skus`), que mostram quanto a defasagem custa.

## 3. Observabilidade

Seção: [Observabilidade](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#observabilidade). Critérios: `DOC-OBS-01` a `DOC-OBS-04`; testes `OBS-01` a `OBS-07`, `FND-05`, `CHK-12`, `ORD-18` e `CAT-12`. Catálogo de métricas e eventos: [`telemetry.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/.specs/features/casecellshop/telemetry.md).

Logs pelo pino, métricas e traces pelo OpenTelemetry, todos com a mesma correlação. Toda métrica e todo evento de log são declarados num catálogo tipado por pasta, e o `tsc` recusa o que estiver fora dele (`OBS-07`).

**Logs estruturados e campos obrigatórios** (`DOC-OBS-01`). JSON numa linha. Obrigatórios: `time`, `level`, `service`, `env`, `version`, `event` (o nome do evento no catálogo, como `casecellshop.checkout.accepted`), `msg`, `correlationId` (o `X-Request-Id` do cliente ou um UUID novo, que viaja na mensagem da outbox até o worker), `trace_id` e `span_id`. Quando existem: `route`, `method`, `status`, `duration_ms`, `orderId`, `sku`, `attempt`, `cause`, `reason` e `err`. `info` para o esperado, `warn` para o que o sistema absorveu, `error` para o que precisa de alguém. `orderId` e `sku` ficam nos logs e nunca nas métricas, onde criariam uma série por pedido.

**Counters, gauges e histograms** (`DOC-OBS-02`). Counter para eventos, gauge para estado, histogram para durações e idades, com uma fronteira em cada limiar de SLO:

- **cache, no M4:** `casecellshop.catalog.cache.lookups`, `casecellshop.catalog.origin.loads` (counters), `casecellshop.catalog.origin.active_loads` (gauge), `casecellshop.catalog.served_entry.age` (histogram); e a sincronização: `casecellshop.catalog.sync.age` (gauge), `casecellshop.catalog.sync.corrections` e `casecellshop.catalog.sync.missing_skus` (counters);
- **checkout:** `casecellshop.checkout.requests` por desfecho (counter) e `http.server.request.duration` (histogram); e, no M5, o estoque: `casecellshop.inventory.reserved` e `casecellshop.inventory.oversold_skus` (gauges);
- **fila:** `casecellshop.outbox.published.messages`, `casecellshop.outbox.attempts` por desfecho e `casecellshop.outbox.orphan_conclusions` (counters), `casecellshop.order.accept_to_invoice.duration` (histogram); e, no M5, `casecellshop.queue.messages` (`billing`, `dlq`) e `casecellshop.outbox.oldest_pending.age` (gauges) e `casecellshop.order.stuck` (counter);
- **ERP:** `casecellshop.erp.client.operation.duration` por operação e desfecho (histogram, cujo `_count` conta as chamadas), `casecellshop.erp.client.active_operations` (UpDownCounter) e `casecellshop.erp.out_of_stock.rejections` (counter).

No Prometheus, o ponto vira sublinhado e o counter ganha `_total` (`casecellshop_outbox_attempts_total`); um teste fixa os nomes exportados.

**Traces** (`DOC-OBS-03`):

- **`GET /products`:** requisição → cache → repositório, este só numa falta; o trace mostra quanto a origem custou (`CAT-12`) **[M4]**;
- **`POST /checkout` assíncrono:** a requisição responde `202`, e a transação grava o `traceparent` na linha da outbox (`CHK-12`); o relay o leva como atributo da mensagem no SQS, e cada tentativa do worker é um span filho do span do checkout, com `orderId` e `attempt` (`ORD-18`), seguido das chamadas ao ERP **[M5]**. Um trace por pedido, mesmo com retries de dezenas de minutos, para a cadeia requisição → worker → ERP aparecer numa visão só. Um `orderId` leva aos logs, e o `trace_id` deles, ao trace (`OBS-05`).

**SLI e SLO, alertas, dashboard e runbook** (`DOC-OBS-04`), em 30 dias:

- **SLOs:** vitrine com 99,9% sem `5xx` e 99% em até 200 ms; checkout com 99,9% sem `5xx` (o `4xx` não consome o orçamento) e 99% em até 500 ms; 99% dos pedidos com desfecho em até 60 s do aceite, com cada atrasado contado uma vez (`OBS-04`);
- **alertas:** consumo do orçamento do SLO em duas janelas; mensagem na DLQ e fila envelhecendo; furo de estoque; erro de configuração no ERP; sincronização parada;
- **dashboard:** na ordem da jornada (vitrine, checkout, fila e ERP, estoque);
- **runbook:** um por alerta; o da DLQ (*redrive* ou cancelamento depois de consultar o ERP) já existe (`ORD-14`, `ORD-15`).

As consultas PromQL, os limites e os runbooks completos ficam na seção "Operação" do [`README.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#operação), conferidos contra o `/metrics` real (`OBS-03`) **[M5]**.

## 4. Concorrência, estoque e idempotência

Seção: [Concorrência e idempotência](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#concorrência-e-idempotência). Critérios: `DOC-CON-01` a `DOC-CON-04`; testes `CHK-01` a `CHK-12`.

**Por que uma checagem simples é insuficiente** (`DOC-CON-01`). "Ler o estoque e, se houver, gravar a venda" são duas operações. Com uma unidade, duas transações leem `1`, passam pela checagem e gravam a venda. No `READ COMMITTED`, o padrão do PostgreSQL, nada impede isso, e a checagem na aplicação também não resolve com várias réplicas.

**Update condicional × lock pessimista × reserva × lock distribuído** (`DOC-CON-02`). O escolhido é `UPDATE inventory SET reserved = reserved + :q WHERE sku = :sku AND on_hand - reserved >= :q`: a checagem e a gravação são uma instrução, e o PostgreSQL faz a segunda transação esperar e reavaliar a condição; zero linhas afetadas é `409`. O `SELECT … FOR UPDATE` é correto, mas faz duas idas ao banco e põe a regra na aplicação. A reserva não é alternativa, é o modelo: `reserved` é da loja, `on_hand` espelha o ERP, e a sincronização nunca apaga uma reserva. O lock distribuído fica fora da transação do pedido e pode ser perdido num failover. Todo pedido reserva os SKUs em ordem de SKU, sem deadlock (`CHK-07`).

**Idempotência para retry, duplo clique e reprocessamento** (`DOC-CON-03`). A `Idempotency-Key` é obrigatória e gravada na transação do pedido, com o hash do pedido normalizado. Retry e duplo clique devolvem o mesmo pedido (`CHK-03`, `CHK-04`); a mesma chave com outro pedido recebe `422`; o mesmo pedido com os itens em outra ordem devolve o original (`CHK-05`). No worker, o `orderId` é a referência no ERP, e o worker consulta o ERP antes de criar de novo (`ORD-01` a `ORD-07`).

**Como o teste prova** (`DOC-CON-04`). Contra um PostgreSQL real: 50 checkouts simultâneos para um item com estoque 5, em laço, terminam com exatamente 5 `202` e 45 `409` (`CHK-01`); um controle negativo, a versão ingênua no mesmo teste, vende além do estoque, o que mostra que o teste pega o defeito (`CHK-02`).

## 5. Mensageria, resiliência, contrato e IA

Seção: [Mensageria e resiliência](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#mensageria-e-resiliência). Critérios: `DOC-MSG-01` a `DOC-MSG-04`; testes `ORD-01` a `ORD-22`.

**Publicar antes ou depois de gravar o pedido** (`DOC-MSG-01`). Nenhum dos dois: publicar antes gera mensagem fantasma se a gravação falha; publicar depois gera pedido fantasma se o processo cai entre os dois passos. A mensagem é uma linha da outbox, gravada na mesma transação do pedido, da chave e da reserva, e um *Message Relay* a publica no SQS depois do commit.

**Pedido fantasma e mensagem fantasma** (`DOC-MSG-02`). Não existem, pela transação única. A mensagem recebida do SQS só é apagada depois de gravado o desfecho, e um worker morto devolve a mensagem à fila (`ORD-02`). Contra a fatura duplicada: a permissão de chamada por pedido no banco (`ORD-11`, `ORD-22`), a consulta pela referência antes de criar de novo, só 45 s depois do início da chamada anterior (H1a e H4, `ORD-03` a `ORD-05`), e a deduplicação do ERP como segunda proteção (H1b). Limite declarado: sem a H1b e acima da H4, um pedido pode ter duas faturas (`ORD-06`, risco R6).

**Retry, DLQ, OpenAPI e testes** (`DOC-MSG-03`). Cada resposta do ERP é classificada antes do retry: permanente, transitória, ambígua ou erro de configuração (`ORD-09`, `ORD-10`). O retry espera pelo menos 45 s, com *full jitter* sobre um exponencial, até 12 recebimentos, e depois vai para a DLQ do SQS, com o pedido ainda `pending` e a reserva feita (`ORD-12`, `ORD-13`). A reconciliação lê a DLQ a cada 5 min, e o runbook faz o *redrive* ou cancela (`ORD-14`, `ORD-15`). O cliente acompanha o pedido em `GET /orders/{orderId}/status`, com o OpenAPI gerado do mesmo contrato em zod que valida as respostas nos testes (`CHK-11`, `ORD-19`). Os testes contam faturas no ERP simulado, e não chamadas, contra o PostgreSQL e o ElasticMQ reais.

**Prompts de IA** (`DOC-MSG-04`). O projeto não guarda um diário de prompts: os prompts que decidem cada passo são as instruções versionadas dos agentes, listadas no [`PROMPTS.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/PROMPTS.md) e citadas literalmente no `ARCHITECTURE.md`. A mesma seção traz as respostas da IA recusadas ou corrigidas, cada uma com o link para o relatório de revisão que a pegou.

## Repositório

https://github.com/roneyrogerio/casecellshop-backend
