# Arquivo de decisões

ADs substituídas, retiradas do [`STATE.md`](STATE.md) perto do limite de tamanho. O texto fica como foi aceito; só o status aponta para a AD que a substituiu. Nenhum agente carrega este arquivo, e ele não tem limite de tamanho ([`.specs/README.md`](../README.md)).

### AD-007 · Contrato OpenAPI antes do código e erros em RFC 9457

**Status:** aceita (29/10/2026); substituída por AD-010 (29/10/2026)

**Contexto.** O contrato é a fonte da verdade da API e precisa cobrir sucesso, erro e o fluxo assíncrono.

**Decisão.**

- `openapi.yaml` (OpenAPI 3.1) escrito à mão; cada rota entra nele antes do código.
- O `express-openapi-validator` 5.6.2 valida toda requisição e, nos testes, o corpo das respostas, então cada teste de integração é também um teste de contrato.
- Erros em `application/problem+json` (RFC 9457), com `correlationId` e um `type` por causa, produzidos por um middleware único; falhas do banco mapeadas pelo passo da transação.
- `X-Request-Id` em toda resposta; preço sempre do banco, em centavos; só mudanças aditivas.
- Detalhes: [`design.md`, "Contrato"](../features/casecellshop/design.md#contrato-ad-007).

**Alternativas consideradas:**

- **Code-first** (zod ou TypeBox gerando o OpenAPI). A spec passa a descrever a implementação, em vez de defini-la.
- **`openapi-backend`.** Substitui o roteamento do Express; é o plano B (R2).
- **Tipos gerados do `openapi.yaml`** (`openapi-typescript`). Eliminam a divergência entre tipo e contrato, ao custo de um passo de geração; com três rotas, a validação das respostas já pega a divergência.
- **Formato de erro próprio.** Mais um formato para quem consome a API, sem media type registrado nem campos de extensão definidos.
- **Paginação por cursor.** Resiste a inserções entre páginas, mas aqui as páginas de um TTL já vêm do mesmo instantâneo.

**Trade-off.** Os tipos TypeScript das rotas são escritos à mão; a validação das respostas nos testes pega a divergência.

**Rever quando:** surgir um segundo consumidor da API. Aí entram os tipos gerados e a verificação automática de quebra de contrato no CI.
