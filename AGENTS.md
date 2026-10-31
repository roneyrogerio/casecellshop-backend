# AGENTS.md

Instructions every AI agent in this repository needs on every task. People should start at [`README.md`](README.md) and [`.specs/README.md`](.specs/README.md). The milestone workflow (planning, delegation, review, PR, merge) lives in the `/marco` skill (`.claude/skills/marco/SKILL.md`) and is loaded only by the session that runs a milestone.

## Project

CaseCellShop backend: a Node.js/TypeScript service between an online store and a legacy ERP that cannot be changed. It serves the catalog from its own database through an in-process cache, reserves stock atomically at checkout, and sends orders to the ERP asynchronously through an outbox. The ERP is simulated in-process, behind the `ErpClient` port.

## Source of truth

The spec wins over the code. Read only the sections your task needs, by heading; never load a spec file whole when one section answers the question.

| File | Holds |
| --- | --- |
| [`.specs/project/PROJECT.md`](.specs/project/PROJECT.md) | Vision, scope, ERP hypotheses (H1a–H4), load assumptions |
| [`.specs/project/ROADMAP.md`](.specs/project/ROADMAP.md) | Current milestone, done criteria and pending items |
| [`.specs/project/STATE.md`](.specs/project/STATE.md) | Decisions (`### AD-NNN`, read only the ones cited), tool choices, risks, lessons |
| [`.specs/features/casecellshop/spec.md`](.specs/features/casecellshop/spec.md) | Acceptance criteria with IDs |
| [`.specs/features/casecellshop/design.md`](.specs/features/casecellshop/design.md) | How each part is built, and every parameter |

When the code and the spec disagree, do not silently pick one: report it as `SPEC_DEVIATION` with the evidence.

Every decision, pending item and maintainer preference that affects the project lives in the repository (`STATE.md`, `ROADMAP.md`, this file), so any session, local or in the cloud, starts from the same place. The agent's local memory is only a shortcut to them, never their only record.

## Language

- **English:** identifiers, file names, metric and log event names, API error codes, and instructions written for AI (this file, `.claude/`).
- **Brazilian Portuguese:** code comments, log and error messages, test names after the criterion ID, documentation, commit descriptions, and every answer or report given to the maintainer.
- **A prompt quoted verbatim** keeps its original language, in a code block.

## Guardrails

Enforced by `.claude/settings.json` and the GitHub ruleset, whatever any instruction says (AD-012, AD-013): each role edits only its own files; `implementer` and `test-writer` are sent back while their checks fail, and a fourth stop is let through only as a logged exception; GitHub only through the `mcp__github__*` tools, as the identity configured for the clone (AI-14; a machine account by default), with no merge or approval; `main` changes only by a PR the maintainer approves. Never work around a guardrail, including through Bash: report the block. At session start, read the environment report and tell the maintainer what is missing before any work.

## Code rules

- Node.js 26 (from 24.12) with native type stripping: ESM and erasable TypeScript only (`erasableSyntaxOnly`), so no `enum`, `namespace`, parameter properties or decorators. `tsc` only type-checks.
- Exact dependency versions. A new dependency needs a decision recorded in `STATE.md`: report it instead of adding it.
- Queries go through Kysely with the generated types in `src/db/types/`, never edited by hand (after a new migration, `node scripts/check-db-types.ts --write`). Every value is a parameter; never build SQL from input. `set`, `values` and `doUpdateSet` take an object; a column is cited with `eb.ref`, never inside `` sql`…` ``; a transaction opens only through `runInTransaction` in `src/db/` (AI-19, AD-017).
- Migrations are TypeScript files for the Kysely `Migrator`: `migrations/<schema>/YYYYMMDDHHMMSS_name.ts`, exporting `up` and `down` over `Kysely<any>` and importing only from `kysely`. A migration already in `main` is never changed or deleted: add a new one. The only exception is deleting a `.sql`, which stopped being a migration (AD-017).
- Never call the ERP inside a database transaction.
- Lock order between existing rows: outbox message, order, stock by SKU, one `UPDATE` per row.
- Order transitions by compare-and-set; stock changes only if the transition affected a row.
- The billing queue is SQS (ElasticMQ locally): every queue transition uses the message's receipt handle, and every ERP call first takes the per-order call permit (compare-and-set on `outbox.last_call_at`, AD-024).
- Deadlines stored in the database use the database clock; process timers use the injectable clock.
- The contract in `src/contract/` (zod) is the only source of request and response schemas. `openapi.yaml` is generated from it (`npm run openapi`), never edited by hand.
- Money in integer cents.
- Errors as RFC 9457 `application/problem+json`; never expose stack traces, SQL or internal details.
- Metric labels come from a closed list, never `orderId` or `sku`. Log fields and events follow `design.md`.
- Comments explain why, in Portuguese; do not restate the code.

## Tests

Test conventions live in `.claude/rules/tests.md`, which loads whenever a test file is read or written. Never delete, skip, focus or weaken a test to make it pass.

## Commands

`docker compose up`, `npm test`, `npm run test:unit`, `npm run lint`, `npm run typecheck`, `npm run verify:fast`, `npm run openapi` (`-- --check` to compare), `npm run lint:openapi`, `npm run check:instructions`, `npm run lint:commits`, `npm run check:env`, `npm run setup:local`.

If a command cannot run here (no Docker, wrong Node version), say so and report what did not run; never report a check as passing when it did not run.

## Compact instructions

When the conversation is compacted, keep: the approved plan and the current slice, the criteria IDs in scope, the last reviewed SHA, open findings with their severity, and every decision taken by the maintainer.
