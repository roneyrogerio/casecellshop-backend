# Respostas às cinco perguntas

Texto de entrega da Parte 1.A do desafio. Cada resposta segue os tópicos da pergunta na ordem do enunciado e aponta para a seção do [`ARCHITECTURE.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md), onde estão as comparações completas.

Tudo o que as respostas descrevem está implementado e testado no repositório, exceto o que leva a marca **[alvo]**: a arquitetura alvo, fora do escopo do desafio.

**Como ler os códigos.** Os códigos entre parênteses (`CHK-01`, `ORD-06`) são testes automatizados que levam o mesmo código no nome. A linha no início de cada resposta lista também os critérios `DOC-*` do [`spec.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/.specs/features/casecellshop/spec.md), que conferem o texto.

## 1. Diagnóstico, trade-offs e arquitetura alvo

Seção: [Diagnóstico e arquitetura alvo](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#diagnóstico-e-arquitetura-alvo). Critérios: `DOC-DIA-01` a `DOC-DIA-06`.

**Causa raiz.** Os três problemas têm a mesma origem: a loja trata um ERP legado, que não pode ser alterado, como se fosse o banco dela.

- **Vitrine lenta:** o sistema de registro do ERP está no caminho de leitura de alto volume. A carga nele cresce com o tráfego da loja, e a capacidade dele não.
- **Overselling:** a disponibilidade é checada num momento e baixada em outro (*check-then-act*), e a janela entre os dois cresce com a latência do ERP.
- **Checkout frágil:** o faturamento é síncrono, com mediana de ~3 s e p99,9 de 8 s pela premissa de carga; timeouts e retries sem idempotência duplicam pedidos, e sem registro durável antes da chamada uma queda deixa o pedido sem rastro.

**Impacto**, para o cliente, o negócio e a operação:

- **Vitrine lenta:** páginas lentas e erro quando o ERP oscila; conversão menor justamente no pico, e a carga da vitrine disputa o ERP com o faturamento; cada pico vira incidente no ERP, sem como separar a carga da vitrine da carga interna.
- **Overselling:** compra confirmada e depois cancelada; estorno, atendimento e perda de confiança, concentrados nas promoções; pedidos para cancelar à mão e estoque negativo no ERP para corrigir.
- **Checkout frágil:** espera longa e pedido em dobro; abandono no último passo e faturas duplicadas para estornar; sem rastreabilidade por pedido, cada caso exige procurar nos logs do ERP, e os retries em cascata aumentam a carga no ERP quando ele já está lento.

**Caminhos comparados**, em custo, complexidade, latência, consistência e esforço operacional; o escolhido em negrito.

Vitrine:

| | Cache na frente da API do ERP | **Banco da loja, sincronização e cache em memória** | Captura de mudanças (CDC) do MySQL do ERP |
| --- | --- | --- | --- |
| Custo | Baixo | Médio: um banco e um worker | Alto: conector, broker e acesso de replicação |
| Complexidade | Baixa | Média | Alta |
| Latência | Boa no acerto; a falta chama o ERP | Boa sempre: a origem é um banco local | Boa sempre |
| Consistência | Expira e volta ao ERP; um stampede na expiração derruba o ERP | Defasagem limitada: até 65,5 s mais a duração de uma rodada, com o ERP respondendo | Segundos |
| Esforço operacional | Baixo | Médio: a rodada de sincronização e o alerta de idade | Alto: binlog, replicação e um broker para operar |

A leitura direta do MySQL do ERP, que o enunciado permite, foi descartada: as tabelas internas não são contrato, e a carga continuaria no banco que fatura; fica só como plano B da consulta por referência.

Overselling:

| | **`UPDATE` condicional atômico no banco da loja** | `SELECT … FOR UPDATE` e depois `UPDATE` | Contador ou lock distribuído no Redis |
| --- | --- | --- | --- |
| Custo | Baixo | Baixo | Médio: mais um serviço |
| Complexidade | Baixa: uma instrução por SKU | Média: duas idas ao banco e a checagem na aplicação | Alta: o lock precisa de prazo e de *fencing token* |
| Latência | Uma ida ao banco por SKU | Duas idas ao banco por SKU | Uma ida ao Redis, mais o banco para o pedido |
| Consistência | Forte, na mesma transação do pedido | Forte | Fora da transação do pedido; um failover pode perder uma escrita confirmada |
| Esforço operacional | Nenhum além do banco | Nenhum além do banco | Um cluster Redis para operar |

Risco residual do escolhido: o estoque físico (`on_hand`) espelha o ERP com a defasagem da sincronização, então uma venda em outro canal pode deixar a loja prometendo mais do que o ERP tem. O furo aparece na métrica de SKUs com promessa acima do estoque (`casecellshop.inventory.oversold_skus`), e, pela premissa de que o ERP recusa faturar sem estoque, o pedido que o ERP recusa termina como falho, com a reserva liberada.

Checkout:

| | Síncrono, com timeout maior e retry | `202` e a outbox como fila, no banco da loja | **`202`, outbox, *Message Relay* e SQS** |
| --- | --- | --- | --- |
| Custo | Nenhum | Baixo: só o banco da loja, que já existe | Médio: uma fila SQS com DLQ (o ElasticMQ no compose) e o processo do relay |
| Complexidade | Baixa, mas o retry precisa de idempotência no ERP | Média: worker com lease e token, retry, DLQ numa tabela e reconciliação | Alta: relay, worker, *visibility timeout*, permissão de chamada por pedido contra a mensagem repetida, DLQ e reconciliação |
| Latência para o cliente | A do ERP: segundos | A de uma transação curta, sem o ERP | A mesma: o relay publica depois do commit |
| Consistência | Duplica pedido sob retry sem idempotência; uma queda no meio deixa o pedido sem rastro | Pedido e mensagem na mesma transação: sem pedido nem mensagem fantasma | A mesma transação; o relay publica pelo menos uma vez, e o worker tolera a mensagem repetida |
| Esforço operacional | Baixo, mas cada lentidão do ERP vira incidente | Médio: polling no banco, DLQ e reprocessamento em lote por SQL | Médio: a fila e o relay para operar; a DLQ, o *redrive* e a contagem de recebimentos ficam com o SQS |

Publicar direto num broker, sem outbox, ficou fora: o banco e o broker não têm transação comum, então publicar antes gera mensagem fantasma, e publicar depois, pedido fantasma. Entre as duas opções com outbox, o SQS assume o que a tabela fazia à mão: esconder a mensagem em processamento, contar os recebimentos, mandar para a DLQ e devolver à fila. É também a mesma fila que vai para a AWS. O custo é um contêiner, uma dependência e o relay a mais, e a entrega pelo menos uma vez, que a permissão de chamada por pedido no banco absorve.

**Arquitetura de 30 a 90 dias.** Dias 0 a 30, tirar o ERP do caminho do cliente: banco próprio da loja, checkout com reserva atômica, idempotência e `202`, fila SQS alimentada pela outbox, worker de envio, a sincronização e o cache em processo na vitrine, e observabilidade básica (logs, métricas e traces da vitrine, do checkout e do worker). Dias 30 a 60, operar com segurança: reconciliação com o ERP e runbook; objetivos de nível de serviço (SLOs), alertas e dashboard; um cache L2 compartilhado com várias instâncias da API e autenticação na borda **[alvo].** Dias 60 a 90, escalar e reduzir a defasagem: CDC no lugar da sincronização se a defasagem medida pedir, EventBridge com um segundo consumidor, várias réplicas do worker e a migração para a nuvem **[alvo]**.

**Nuvem.** É hipótese de evolução do datacenter atual, não premissa: cada componente tem um serviço gerenciado (RDS ou Aurora, ECS no Fargate, SQS, ElastiCache, Datadog ou CloudWatch, Secrets Manager), justificado pelo esforço operacional que tira. O ERP fica no datacenter, e a conexão híbrida (VPN ou link dedicado) passa a ser uma fonte de latência e de falha; para a loja, a queda do link é uma queda do ERP, que o desenho já absorve.

**Diagrama:** em Mermaid, no [`ARCHITECTURE.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#diagrama-da-arquitetura-alvo).

## 2. Cache, invalidação e vitrine

Seção: [Cache e performance da vitrine](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#cache-e-performance-da-vitrine). Critérios: `DOC-CAC-01` a `DOC-CAC-04`; testes `CAT-01` a `CAT-15` e `CHK-06`.

**Camadas e o papel de cada uma**:

- **rede de distribuição de conteúdo (CDN) e cache HTTP:** fora do escopo para o catálogo, que responde `Cache-Control: no-store`. Uma camada fora do serviço serviria dado defasado sem aparecer nas métricas, e sem o cabeçalho um cache intermediário pode aplicar frescor heurístico (RFC 9111). Com uma CDN, ela serve os estáticos, e o catálogo passa a levar `max-age` igual ao tempo de vida (TTL) restante **[alvo]**;
- **em processo (L1):** o catálogo inteiro numa entrada, de onde as páginas são fatiadas, com TTL de 5 s ± 10%. Absorve as leituras: o banco recebe no máximo uma consulta por instância a cada TTL, qualquer que seja o tráfego;
- **L2 compartilhado (Redis):** entre as instâncias da API, quando houver várias com taxa de acerto baixa **[alvo].** Com uma instância, seria um contêiner e um modo de falha a mais sem ganho;
- **banco da loja:** a cópia de catálogo, preço e estoque, atualizada pela sincronização a cada 60 s. É a origem do cache e a fonte de verdade do checkout, e é a camada que tira o ERP do caminho da vitrine; a sincronização lê o catálogo inteiro do ERP e grava só o que mudou.

As defasagens somam: com o ERP respondendo, uma mudança chega à vitrine em até 65,5 s mais a duração de uma rodada de sincronização (60 s do intervalo mais 5,5 s do TTL).

**TTL, invalidação, cache-aside × refresh-ahead, fallback e stampede**:

- **TTL de 5 s ± 10%:** a maior parte da defasagem vem da sincronização; um TTL menor multiplicaria as consultas para ganhar segundos num limite de 65,5 s, e o jitter espalha as expirações entre instâncias;
- **invalidação só por expiração:** um aviso entre processos a cada correção tiraria no máximo 5,5 s do limite e acrescentaria um caminho de falha que, quando falha, deixa o TTL como limite de qualquer jeito. O cache nunca decide: o preço que o cliente viu é conferido no banco (`409` com o preço atual), e a reserva é o `UPDATE` condicional;
- **disponibilidade em faixas:** "disponível", "últimas unidades" ou "esgotado" (no contrato, `available`, `low_stock` e `out_of_stock`) muda menos que o número exato, então a defasagem aparece menos, e o estoque exato não é exposto;
- ***cache-aside*, e não *refresh-ahead*:** o *refresh-ahead* e o *stale-while-revalidate* escondem a latência de uma origem lenta. Aqui a origem é um banco local, e o que eles escondem é uma consulta a cada 5 s; a origem lenta era o ERP, que a arquitetura tirou do caminho;
- **fallback:** com a origem em erro, a entrada vencida é servida até 60 s (*stale-if-error*), e por 5 s depois da falha sem tentar a origem; sem entrada, `503` com `Retry-After`; antes da primeira sincronização, `503`. O ERP fora não afeta a vitrine: a sincronização para, e o banco segue com o último estado conhecido;
- **stampede:** *single-flight*, em que N leituras com a entrada vencida geram uma consulta à origem (`CAT-01`), uma chave só, a promessa rejeitada descartada, o jitter e a pausa depois da falha.

**Métricas de ganho de latência e de custo**:

- **latência:** `http.server.request.duration` na rota `/products`, com fronteira em 0,2 s para o SLO de 99% em até 200 ms;
- **taxa de acerto:** `casecellshop.catalog.cache.lookups` (`hit`, `miss`, `stale`), esperada perto de 1 − 1/(R × TTL) por instância, com R requisições por segundo;
- **carga na origem:** `casecellshop.catalog.origin.loads` (`ok`, `error`), lida de duas formas: cargas por requisição, a medida de custo, e cargas por segundo, no máximo ~0,2 por instância qualquer que seja o tráfego; `casecellshop.catalog.origin.active_loads` no máximo 1 por instância mostra o *single-flight* funcionando;
- **chamadas ao ERP evitadas:** as requisições da vitrine menos as chamadas `list_catalog` do `casecellshop.erp.client.operation.duration`. Antes, uma chamada ao ERP por acesso; agora, uma leitura do catálogo por minuto, constante com o tráfego;
- **custo:** nenhum servidor a mais, e a capacidade do ERP (~30 chamadas simultâneas, ~21 usadas pelo faturamento no pico) deixa de ser disputada pela vitrine.

**Métricas de que o ganho não veio de dado velho ou incorreto**:

- **idade da entrada servida** (`casecellshop.catalog.served_entry.age`): até 5,5 s, e até 60 s só em *stale-if-error*;
- **idade da sincronização** (`casecellshop.catalog.sync.age`), lida do banco e exposta pela API, para alertar mesmo com o worker caído. Somadas, as duas idades limitam a idade do que o cliente vê;
- **preço alterado no checkout** (`price_changed` em `casecellshop.checkout.requests`): a vitrine mostrou um preço que já não valia, e o cliente recebeu `409`, sem ser cobrado por outro valor;
- **SKUs com promessa acima do estoque** (`casecellshop.inventory.oversold_skus`) e **rejeições por falta de estoque no ERP** (`casecellshop.erp.out_of_stock.rejections`), juntos no alerta de furo de estoque;
- **correções por rodada** (`casecellshop.catalog.sync.corrections`) e **SKUs ausentes** (`casecellshop.catalog.sync.missing_skus`), que mostram quanto a defasagem custa.

## 3. Observabilidade

Seção: [Observabilidade](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#observabilidade). Critérios: `DOC-OBS-01` a `DOC-OBS-04`; testes `OBS-01` a `OBS-07`, `FND-05`, `CHK-12`, `ORD-18` e `CAT-12`. Catálogo de métricas e eventos: [`telemetry.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/.specs/features/casecellshop/telemetry.md).

Logs pelo pino, métricas e traces pelo OpenTelemetry, todos com a mesma correlação. Toda métrica e todo evento de log são declarados num catálogo tipado por pasta, e o `tsc` recusa o que estiver fora dele.

**Logs estruturados e campos obrigatórios.** JSON numa linha. Obrigatórios em toda linha: `time`, `level`, `service`, `env`, `version`, `event` (o nome do evento no catálogo, como `casecellshop.checkout.accepted`) e `msg`. Obrigatório em toda linha de uma requisição ou de uma tentativa do worker: `correlationId` (o `X-Request-Id` do cliente ou um UUID novo, que viaja na mensagem da outbox até o worker). Obrigatórios em toda linha escrita dentro de um span: `trace_id` e `span_id`. Os logs do próprio processo, como a subida e o encerramento, saem sem os três, porque não há requisição nem span a que ligar. Quando existem: `route`, `method`, `status`, `duration_ms`, `cache` (`hit`, `miss` ou `stale`, na vitrine), `orderId`, `sku`, `attempt`, `cause`, `reason` e `err`. `info` para o esperado, `warn` para o que o sistema absorveu, `error` para o que precisa de alguém. `orderId` e `sku` ficam nos logs e nunca nas métricas, onde criariam uma série por pedido.

**Counters, gauges e histograms.** Counter para eventos, gauge para estado, histogram para durações e idades, com uma fronteira em cada limiar de SLO:

- **cache:** `casecellshop.catalog.cache.lookups`, `casecellshop.catalog.origin.loads` (counters), `casecellshop.catalog.origin.active_loads` (UpDownCounter, as cargas em andamento), `casecellshop.catalog.served_entry.age` (histogram); e a sincronização: `casecellshop.catalog.sync.age` (gauge), `casecellshop.catalog.sync.corrections` e `casecellshop.catalog.sync.missing_skus` (counters);
- **checkout:** `casecellshop.checkout.requests` por desfecho (counter) e `http.server.request.duration` (histogram); e o estoque: `casecellshop.inventory.reserved` e `casecellshop.inventory.oversold_skus` (gauges);
- **fila:** `casecellshop.outbox.published.messages`, `casecellshop.outbox.attempts` por desfecho e `casecellshop.outbox.orphan_conclusions` (counters), `casecellshop.order.accept_to_invoice.duration` (histogram); `casecellshop.queue.messages` (`billing`, `dlq`) e `casecellshop.outbox.oldest_pending.age` (gauges) e `casecellshop.order.stuck` (counter);
- **ERP:** `casecellshop.erp.client.operation.duration` por operação e desfecho (histogram, cujo `_count` conta as chamadas), `casecellshop.erp.client.active_operations` (UpDownCounter) e `casecellshop.erp.out_of_stock.rejections` (counter);
- **leitura dos gauges:** um counter por pasta conta a leitura que falhou (`casecellshop.catalog.gauge.read_failures`, por exemplo), porque o gauge segue com o último valor, e os alertas disparam também por ele.

No Prometheus, o ponto vira sublinhado e o counter ganha `_total` (`casecellshop_outbox_attempts_total`); um teste fixa os nomes exportados.

**Traces**:

- **`GET /products`:** requisição → `catalog.cache.get` → `catalog.repository.list`, este só numa falta; o trace mostra quanto a origem custou. A sincronização tem o próprio trace no worker: `catalog.sync.round` e um `erp.list_catalog` por página;
- **`POST /checkout` assíncrono:** a requisição responde `202`, e a transação grava o `traceparent` na linha da outbox; o relay o leva como atributo da mensagem no SQS, e cada tentativa do worker é um span filho da transação do checkout, com `orderId` e `attempt`, e cada chamada ao ERP é um span `erp.<operação>` dentro da tentativa. Um trace por pedido, mesmo com retries de dezenas de minutos, para a cadeia requisição → worker → ERP aparecer numa visão só. Um `orderId` leva aos logs, e o `trace_id` deles, ao trace inteiro, da requisição ao ERP.

**Indicadores e objetivos de nível de serviço (SLI e SLO), alertas, dashboard e runbook**, em 30 dias:

- **SLOs:** vitrine com 99,9% sem `5xx` e 99% em até 200 ms; checkout com 99,9% sem `5xx` (o `4xx` não consome o orçamento) e 99% em até 500 ms; 99% dos pedidos com desfecho em até 60 s do aceite, com cada atrasado contado uma vez, mesmo com várias réplicas da API;
- **alertas:** consumo do orçamento do SLO em duas janelas; mensagem na DLQ e fila envelhecendo; furo de estoque; erro de configuração no ERP e ERP falhando; sincronização parada; vitrine servida velha;
- **dashboard:** na ordem da jornada (vitrine, checkout, fila e ERP, estoque, sincronização);
- **runbook:** um por alerta; o da DLQ (*redrive* ou cancelamento depois de consultar o ERP) usa o comando de runbook do worker.

As consultas PromQL, os limites e os runbooks completos ficam na seção "Operação" do [`README.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/README.md#operação), com cada consulta conferida contra o catálogo de métricas. O Datadog coleta o mesmo `/metrics` pela integração OpenMetrics, sem mudar o código, e a mesma seção diz como as consultas viram monitores do Datadog.

## 4. Concorrência, estoque e idempotência

Seção: [Concorrência e idempotência](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#concorrência-e-idempotência). Critérios: `DOC-CON-01` a `DOC-CON-04`; testes `CHK-01` a `CHK-12`.

**Por que uma checagem simples é insuficiente.** "Ler o estoque e, se houver, gravar a venda" são duas operações. Com uma unidade, duas transações leem `1`, passam pela checagem e gravam a venda. No `READ COMMITTED`, o padrão do PostgreSQL, nada impede isso, e a checagem na aplicação também não resolve com várias réplicas.

**Update condicional × lock pessimista × reserva × lock distribuído.** O escolhido é `UPDATE inventory SET reserved = reserved + :q WHERE sku = :sku AND on_hand - reserved >= :q`: a checagem e a gravação são uma instrução, e o PostgreSQL faz a segunda transação esperar e reavaliar a condição; zero linhas afetadas é `409`. O `SELECT … FOR UPDATE` é correto, mas faz duas idas ao banco e põe a regra na aplicação. A reserva não é alternativa, é o modelo: `reserved` é da loja, `on_hand` espelha o ERP, e a sincronização nunca apaga uma reserva. O lock distribuído fica fora da transação do pedido e pode ser perdido num failover. Todo pedido reserva os SKUs em ordem de SKU, sem deadlock.

**Idempotência para retry, duplo clique e reprocessamento.** A `Idempotency-Key` é obrigatória e gravada na transação do pedido, com o hash do pedido normalizado. Retry e duplo clique devolvem o mesmo pedido; a mesma chave com outro pedido recebe `422`; o mesmo pedido com os itens em outra ordem devolve o original. No worker, o `orderId` é a referência no ERP, e o worker consulta o ERP antes de criar de novo.

**Como o teste prova.** Contra um PostgreSQL real: 50 checkouts simultâneos para um item com estoque 5, em laço, terminam com exatamente 5 `202` e 45 `409` (`CHK-01`); um controle negativo, a versão ingênua no mesmo teste, vende além do estoque, o que mostra que o teste pega o defeito (`CHK-02`).

## 5. Mensageria, resiliência, contrato e IA

Seção: [Mensageria e resiliência](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#mensageria-e-resiliência). Critérios: `DOC-MSG-01` a `DOC-MSG-04`; testes `ORD-01` a `ORD-22`.

**Publicar antes ou depois de gravar o pedido.** Nenhum dos dois: publicar antes gera mensagem fantasma se a gravação falha; publicar depois gera pedido fantasma se o processo cai entre os dois passos. A mensagem é uma linha da outbox, gravada na mesma transação do pedido, da chave e da reserva, e um *Message Relay* a publica no SQS depois do commit.

**Pedido fantasma e mensagem fantasma.** Não existem, pela transação única. A mensagem recebida do SQS só é apagada depois de gravado o desfecho, e um worker morto devolve a mensagem à fila. Contra a fatura duplicada, três proteções:

- a permissão de chamada por pedido no banco, que deixa passar uma só chamada ao ERP por pedido a cada 45 s, mesmo com a mensagem repetida;
- a consulta ao ERP pelo `orderId` antes de criar de novo, pela premissa de que a API do ERP aceita essa referência e permite consultá-la. A consulta só acontece 45 s depois do início da chamada anterior, pela premissa de que o ERP conclui ou abandona uma criação em até 40 s;
- a premissa de que o ERP recusa uma segunda criação com a mesma referência.

Limite declarado: se o ERP não recusar a criação repetida e passar dos 40 s, um pedido pode terminar com duas faturas, caso que um teste demonstra (`ORD-06`).

**Retry, DLQ, OpenAPI e testes.** Cada resposta do ERP é classificada antes do retry: permanente, transitória, ambígua ou erro de configuração. O retry espera pelo menos 45 s, com *full jitter* sobre um exponencial, até 12 recebimentos, e depois vai para a DLQ do SQS, com o pedido ainda `pending` e a reserva feita. A reconciliação lê a DLQ a cada 5 min, e o runbook faz o *redrive* ou cancela. O cliente acompanha o pedido em `GET /orders/{orderId}/status`, com o [OpenAPI](https://github.com/roneyrogerio/casecellshop-backend/blob/main/openapi.yaml) gerado do mesmo contrato em zod que valida as respostas nos testes. Os testes contam faturas no ERP simulado, e não chamadas, contra o PostgreSQL e o ElasticMQ reais.

**Prompts de IA.** O projeto não guarda um diário de prompts: os prompts que decidem cada passo são as instruções versionadas dos agentes, listadas no [`PROMPTS.md`](https://github.com/roneyrogerio/casecellshop-backend/blob/main/PROMPTS.md) e citadas literalmente na seção [Prompts de IA relevantes](https://github.com/roneyrogerio/casecellshop-backend/blob/main/ARCHITECTURE.md#prompts-de-ia-relevantes) do `ARCHITECTURE.md`. A mesma seção traz as respostas da IA recusadas ou corrigidas, cada uma com o link para o relatório de revisão que a pegou ou conferiu a correção.

## Repositório

https://github.com/roneyrogerio/casecellshop-backend
