# AGENTS.md

Instructions for AI coding agents working in this repository. People should start at [`.specs/README.md`](.specs/README.md).

## Project

CaseCellShop backend: a Node.js/TypeScript service between an online store and a legacy ERP that cannot be changed. It serves the catalog from its own database through an in-process cache, reserves stock atomically at checkout, and sends orders to the ERP asynchronously through an outbox. The ERP is simulated in-process, behind the `ErpClient` port.

## Source of truth

Read the specs before planning or changing anything. The spec wins over the code.

| File | Holds |
| --- | --- |
| [`.specs/project/PROJECT.md`](.specs/project/PROJECT.md) | Vision, goals, scope, ERP hypotheses (H1a–H4), load assumptions |
| [`.specs/project/ROADMAP.md`](.specs/project/ROADMAP.md) | Current milestone, how each milestone is done, done criteria |
| [`.specs/project/STATE.md`](.specs/project/STATE.md) | Decisions (`AD-NNN`), tool choices, risks, lessons |
| [`.specs/features/casecellshop/spec.md`](.specs/features/casecellshop/spec.md) | Acceptance criteria with IDs |
| [`.specs/features/casecellshop/design.md`](.specs/features/casecellshop/design.md) | How each part is built, and every parameter |
| [`.specs/codebase/CONVENTIONS.md`](.specs/codebase/CONVENTIONS.md) | Commits, pull requests, branches, language |

When the code and the spec disagree, do not silently pick one: mark the criterion `SPEC_DEVIATION` and resolve it in the same PR.

## Language

- **English:** identifiers, file names, metric and log event names, API error codes, and instructions written for AI (this file, `.claude/`).
- **Brazilian Portuguese:** code comments, log and error messages, documentation, commit and PR descriptions, and every answer given to the maintainer.

## Workflow

The main session orchestrates. It runs on `opusplan` (set in `.claude/settings.json`): Opus while planning, Sonnet while executing. It writes the specs, `openapi.yaml`, `ARCHITECTURE.md` and the other docs, makes every commit and opens the PRs. Tests come only from `test-writer`, and production code only from `implementer`. Agents run one at a time. For each milestone:

1. Delegate to `planner`: it proposes the milestone plan and the spec deviations. The maintainer approves; the main session updates the spec.
2. Draft the milestone section of `ARCHITECTURE.md`, add the criteria to `spec.md` and the routes to `openapi.yaml`.
3. Delegate to `test-writer`: failing tests from the criteria and the contract. Commit `test(<scope>): …`.
4. Delegate to `implementer`: code until the tests and CI pass. Commit `feat(<scope>): …`.
5. Delegate to `reviewer` and post its report on the PR as a comment. Code findings go back to `implementer`, following the escalation ladder; spec and doc findings are fixed by the main session.
6. The maintainer merges, without squash.

- Run `/security-review` on the M2 PR and before delivery.
- Record the relevant prompts, and what was accepted, corrected or rejected, for `PROMPTS.md`.
- Never commit or push without the maintainer's approval.

## Models and effort

The defaults live in each agent's frontmatter in `.claude/agents/`:

| Who | Model | Effort |
| --- | --- | --- |
| Main session | `opusplan`: Opus while planning, Sonnet while executing | Session default |
| `planner` | Opus | `high` |
| `test-writer` | Sonnet | `high` |
| `implementer` | Sonnet | `medium` |
| `reviewer` | Opus | `high` |

**Escalation ladder**, only for `implementer`, counted per problem. A problem is one reviewer finding, or one CI check failing for one cause. Escalate by passing `model` and `effort` on the `implementer` call; never change the frontmatter.

| Step | When | Call with |
| --- | --- | --- |
| 0 | First implementation of the milestone | Frontmatter: `sonnet`, `medium` |
| 1 | First fix of a problem | `model: sonnet`, `effort: high` |
| 2 | The same problem comes back | `model: opus`, `effort: high`, until it is fixed |

- "Comes back" is a verifiable signal, never an impression: `reviewer` marks the finding `não corrigido (rodada k)`, or the same CI check fails for the same cause. Read the step from the last PR comment of each problem.
- Each step is a new `implementer` call that receives the finding, the link to its PR comment and the previous commit. Never resume the previous agent: a resumed agent keeps its effort.
- A new problem starts at step 1. The next milestone starts again from the frontmatter.
- Nothing above step 2: more effort does not fix a wrong premise. Sonnet never goes above `high`; when `high` is not enough, change the model. `max` is never used: it shows diminishing returns and tends to overthink.
- `planner`, `test-writer` and `reviewer` never escalate. A review that does not convince becomes a question to the maintainer.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `maxEffortLevel`: they override the effort of every agent. Per-call `model` and `effort` need Claude Code v2.1.292 or later.

## Spec maintenance

- Each spec file has a word limit, listed in [`.specs/README.md`](.specs/README.md); CI fails above it (`FND-06`). Near a limit, consolidate; never delete content without moving it to the right file.
- An accepted `AD-NNN` is never edited: a new AD supersedes it, and the old one is marked "substituída por AD-NNN".
- A spec change goes in the PR of the milestone that caused it.

## Code rules

- Node.js 24 with native type stripping: ESM and erasable TypeScript only (`erasableSyntaxOnly`), so no `enum`, `namespace`, parameter properties or decorators. `tsc` only type-checks.
- Exact dependency versions, as listed in `STATE.md`. A new dependency needs a decision recorded there.
- SQL is explicit and parameterized; never build SQL from input. Migrations are `.sql` files.
- Never call the ERP inside a database transaction.
- Lock order between existing rows: outbox message, order, stock by SKU, one `UPDATE` per row.
- Order transitions by compare-and-set; stock changes only if the transition affected a row.
- Every outbox transition is conditioned on the claim token.
- Deadlines stored in the database use the database clock; process timers use the injectable clock.
- Money in integer cents.
- Errors as RFC 9457 `application/problem+json`; never expose stack traces, SQL or internal details.
- Metric labels come from a closed list, never `orderId` or `sku`. Log fields and events follow `design.md`.
- Comments explain why, in Portuguese; do not restate the code.

## Tests

- Tests live in `test/`, never in `src/`, as `*.test.ts` files:
  - `test/unit/`: no Docker (`npm run test:unit`);
  - `test/integration/<area>/`: Testcontainers and supertest, one folder per area of `spec.md`, such as `checkout/`, `orders/` and `catalog/`.
- Each test name starts with the ID of the criterion it proves, e.g. `CHK-01 …`.
- Anything that touches the database runs against real PostgreSQL; no database mocks.
- No `sleep`: use the injectable clock and timestamps seeded in the database.
- ERP failure tests count invoices in the simulated ERP, not calls.
- Never delete, skip or weaken a test to make it pass.

## Commands

Created in M1: `docker compose up`, `npm test`, `npm run test:unit`, `npm run lint`, `npx tsc --noEmit`.
