# CaseCellShop backend

Serviço entre a loja virtual da CaseCellShop e um ERP legado que não pode ser alterado. Ele serve o catálogo do próprio banco, por um cache em memória; reserva o estoque de forma atômica no checkout; e envia os pedidos ao ERP de forma assíncrona, por uma outbox. O ERP é simulado dentro do processo, atrás da porta `ErpClient`.

**Estado:** marco M1 (Fundação). O esqueleto roda, testa e passa no CI, com o contrato, as migrações, o ERP simulado, a telemetria e o compose. As regras de negócio entram nos marcos seguintes do [`ROADMAP.md`](.specs/project/ROADMAP.md).

## Pré-requisitos

- Docker, com o Compose v2.20.2 ou mais novo;
- Node.js a partir da 24.12; a versão de referência é a do [`.nvmrc`](.nvmrc) (26.13.0). O Node roda o TypeScript direto, sem build.

## Subir

```sh
docker compose up --build
```

Sobem o PostgreSQL, as migrações (que terminam antes de a API e o worker subirem), a API, o worker e o Jaeger.

| O quê | Endereço |
| --- | --- |
| API | `http://localhost:3000` (`GET /health`) |
| Métricas da API | `http://localhost:3000/metrics` |
| Traces (Jaeger) | `http://localhost:16686`, serviço `casecellshop-api` |

As portas mudam com `API_PORT` e `JAEGER_UI_PORT`. O [`requests.http`](requests.http) tem as requisições de exemplo.

## Testar

```sh
npm ci
npm test            # tudo, com PostgreSQL e compose reais no Docker
npm run test:unit   # só os unitários, sem Docker
```

Os testes que tocam o banco rodam contra um PostgreSQL real, pelo Testcontainers: o que se prova é o comportamento do banco, como lock, transação e índice único, e um mock não o reproduz.

Outros comandos: `npm run lint`, `npm run typecheck`, `npm run openapi` (gera o `openapi.yaml` a partir do contrato), `npm run lint:openapi` e `npm run check:specs`. O CI roda todos, no Node do `.nvmrc` e na 24.12.

## Critérios do M1

| Critério | O que garante | Onde | Teste |
| --- | --- | --- | --- |
| `FND-01` | `docker compose up` sobe tudo, com as migrações antes da API e do worker | [`compose.yaml`](compose.yaml), [`src/main/migrate.ts`](src/main/migrate.ts) | [`compose.test.ts`](test/integration/foundation/compose.test.ts) |
| `FND-02` | `npm test` passa local e no CI | [`ci.yml`](.github/workflows/ci.yml) | O CI e a execução local registrada no PR |
| `FND-03` | Requisição fora do contrato recebe `400` em `application/problem+json`, com o `correlationId` | [`src/http/`](src/http/) | [`contract-validation.test.ts`](test/integration/foundation/contract-validation.test.ts) |
| `FND-04` | A fatura do ERP simulado continua lá depois de o worker reiniciar | [`src/erp/sim/`](src/erp/sim/) | [`erp-sim.test.ts`](test/integration/foundation/erp-sim.test.ts) |
| `FND-05` | O span do repositório sai como filho do span da requisição | [`src/telemetry.ts`](src/telemetry.ts), [`src/health/repository.ts`](src/health/repository.ts) | [`tracing.test.ts`](test/integration/foundation/tracing.test.ts) |
| `FND-06` | O CI falha se uma spec ou uma instrução da IA passar do limite de tamanho | [`scripts/check-spec-limits.ts`](scripts/check-spec-limits.ts) | [`check-spec-limits.test.ts`](scripts/check-spec-limits.test.ts) |
| `FND-07` | O CI falha se o `openapi.yaml` divergir do contrato ou não passar no lint | [`src/contract/`](src/contract/), [`scripts/generate-openapi.ts`](scripts/generate-openapi.ts) | [`generate-openapi.test.ts`](scripts/generate-openapi.test.ts) |
| `FND-08` | A guarda de caminho limita o que cada agente de IA edita | [`.claude/hooks/path-guard.mjs`](.claude/hooks/path-guard.mjs) | [`path-guard.test.ts`](.claude/hooks/path-guard.test.ts) |

Os testes unitários ficam ao lado do arquivo que testam; os de integração, em `test/integration/<área>/`.

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): o diagnóstico dos três problemas, os caminhos comparados, a arquitetura de 30 a 90 dias e a nuvem como hipótese.
- [`openapi.yaml`](openapi.yaml): o contrato HTTP em OpenAPI 3.1, gerado do zod em [`src/contract/`](src/contract/).
- [`.specs/`](.specs/README.md): visão, marcos, decisões (`AD-NNN`), critérios de aceite e design.
- [`PROMPTS.md`](PROMPTS.md): o uso de IA, com o que foi aceito, corrigido ou rejeitado.
- [`AGENTS.md`](AGENTS.md): o fluxo de agentes de IA que constrói o projeto.

## Licença

[MIT](LICENSE).
