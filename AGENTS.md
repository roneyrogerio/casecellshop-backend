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
| [`.specs/codebase/CONVENTIONS.md`](.specs/codebase/CONVENTIONS.md) | Commits, pull requests, branches, tests, language, AI instructions |

When the code and the spec disagree, do not silently pick one: mark the criterion `SPEC_DEVIATION` and resolve it in the same PR.

The workflow, the conventions, the decision-record rule and the decisions in `STATE.md` are settled: apply them as written, without researching or deciding them again. Reopen one only when a fact it rests on has changed (a tool version, a documented behavior, a requirement) or its "Rever quando" condition is met, and then propose a superseding AD or table row in the milestone PR, with the new evidence. Research only what the specs leave open, and record the outcome as "Decision records" describes, so it is not researched again.

## Language

- **English:** identifiers, file names, metric and log event names, API error codes, and instructions written for AI (this file, `.claude/`).
- **Brazilian Portuguese:** code comments, log and error messages, test names after the criterion ID, documentation, commit descriptions, and every answer or report given to the maintainer.
- **A prompt quoted verbatim** keeps its original language, in a code block, like code; the explanation around it is in Brazilian Portuguese.
- **Everything published on GitHub** is in Brazilian Portuguese: the PR title after its Conventional Commits type, the PR description and every comment. Identifiers, paths, commands, criterion IDs and code stay exactly as they are.

## Workflow

The main session orchestrates. It runs on `opus` with `effortLevel: high` (set in `.claude/settings.json`), and changes only when the maintainer explicitly asks for another model or effort. It writes the specs, the contract in `src/contract/` (and regenerates `openapi.yaml`), `ARCHITECTURE.md` and the other docs, makes every commit and opens the PRs. Tests come only from `test-writer`, and production code only from `implementer`. Agents run one at a time. For each milestone:

1. Delegate to `planner`: it proposes the milestone plan and the spec deviations. The maintainer approves; the main session updates the spec.
2. Draft the milestone section of `ARCHITECTURE.md`, add the criteria to `spec.md` and the routes to the contract, then regenerate `openapi.yaml`. Commit them and open a draft PR with the approved plan as a checklist in its description.
3. Delegate to `test-writer`: failing tests from the criteria and the contract. Commit `test(<scope>): …`.
4. Delegate to `implementer`: code until the tests and CI pass. Commit `feat(<scope>): …`. Tick each checklist item as it lands.
5. Delegate to `reviewer` and post its report on the PR as a comment. Code findings go back to `implementer`, following the escalation ladder; test findings go back to `test-writer`; spec and doc findings are fixed by the main session.
6. The maintainer merges, without squash.

- Run `/security-review` on the M2 PR and before delivery.
- Record decisions and AI usage in the same PR, as "Decision records" describes.
- Never commit or push without the maintainer's approval.
- A command that asks for approval (`git commit`, `git push`, a `gh pr` write) runs alone, on one line, never chained or with a heredoc: write the commit message to a file and run `git commit -F <file>`, and describe the command in Portuguese. The maintainer reads the whole command before approving it.

## GitHub

- Only the main session writes to GitHub; agents never post. The agents' reports feed the PR description ("o que a IA gerou").
- The only comments are the `reviewer` reports: one comment per review round, posted exactly as written. Progress shows in the commits and the checklist; CI failures stay in the checks.
- No issues: the unit of work is the milestone in `ROADMAP.md`, with its criteria in `spec.md`, and the PR points to them.
- No agent approves or requests changes. The PR comes from the maintainer's account, which cannot approve its own PR, and the merge is the maintainer's decision.

## Decision records

Record a decision in the PR where it is made, so the reasoning stays reviewable next to the code, when it changes structure, a quality attribute, a dependency, a contract or how the system is built (library, tool, process); is costly to reverse; had two or more viable options; or corrects an earlier decision or assumption. Do not record internal choices that are easy to refactor, details that follow from a recorded decision (they go in `design.md`), or how-to instructions. Full rule, AD structure and lifecycle: [`.specs/README.md`](.specs/README.md).

| Kind | Where |
| --- | --- |
| Product or architecture | A new `AD-NNN` in `STATE.md`, "proposta" in the PR and "aceita" in the last commit before merge |
| Tool or process | A row in the tool table of `STATE.md` |
| Open risk; mistake that changed course | The risk table or a new `L-NNN` in `STATE.md` |
| AI usage | `PROMPTS.md`: the request, what the AI produced, what was accepted, corrected or rejected, and how it was verified |

- State the reason in the project's own terms (requirements, constraints, trade-offs), so it stands alone. Documentation, standards and other projects go only under "Referências", as verifiable evidence, never as the reason.
- `test-writer` and `implementer` list the decisions they made that the plan or the spec did not settle; the main session applies this filter and records the ones that pass.

## Guardrails

Claude Code enforces these whatever the instructions say (`.claude/settings.json`):

- `test-writer` can edit only `*.test.ts` files and `test/`; `implementer` cannot edit `*.test.ts` files, `test/`, `.specs/`, `.claude/`, `src/contract/`, `openapi.yaml`, `ARCHITECTURE.md`, `AGENTS.md` or `CLAUDE.md`. A `PreToolUse` hook keyed by `agent_type` checks every `Edit`, `Write` and `NotebookEdit` call (`.claude/hooks/path-guard.mjs`). Writes through Bash are not covered (R10), so the main session checks `git status` against the agent's role after each call.
- `git commit`, `git push` and PR writes with `gh` always ask the maintainer, in every permission mode.
- Force pushes, `gh pr merge`, `gh pr review`, `gh issue create` and reading `.env` files are denied.
- Bash rules match the usual form of a command and are not a security boundary; the reviewer's history check and the maintainer's merge stay the final checks. Never work around a guardrail: report the block instead.

## Models and effort

The defaults live in each agent's frontmatter in `.claude/agents/`:

| Who | Model | Effort |
| --- | --- | --- |
| Main session | Opus, fixed in `.claude/settings.json` | `high`, fixed there too |
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

- "Comes back" is a verifiable signal, never an impression: `reviewer` marks the finding `não corrigido (rodada k)`, or the same CI check fails for the same cause. Read the step from the last `reviewer` comment for a finding, or from the PR's CI runs for a CI problem.
- Each step is a new `implementer` call that receives the finding, the link to its PR comment or CI run, and the previous commit. Never resume the previous agent: a resumed agent keeps its effort.
- A new problem starts at step 1. The next milestone starts again from the frontmatter.
- Nothing above step 2: more effort does not fix a wrong premise. Sonnet never goes above `high`; when `high` is not enough, change the model. `max` is never used: it shows diminishing returns and tends to overthink.
- `planner`, `test-writer` and `reviewer` never escalate. A review that does not convince becomes a question to the maintainer.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `maxEffortLevel`: they override the effort of every agent. The project `effortLevel` sets only the main session's default; a maintainer's `/effort` or `--effort` still wins. Per-call `model` and `effort` need Claude Code v2.1.292 or later.

## Spec and instruction maintenance

- Each spec file has a word limit, listed in [`.specs/README.md`](.specs/README.md); CI fails above it (`FND-06`). Near a limit, consolidate; never delete content without moving it to the right file.
- This file and each agent in `.claude/agents/` stay under 200 lines, and agent descriptions stay short ([`CONVENTIONS.md`](.specs/codebase/CONVENTIONS.md)); CI enforces it (`FND-06`). `CLAUDE.md` only imports this file. After changing them, the maintainer runs `/doctor prompt-audit`.
- An accepted `AD-NNN` is never edited: a new AD supersedes it, and the old one is marked "substituída por AD-NNN".
- A spec change goes in the PR of the milestone that caused it.

## Code rules

- Node.js 26 (from 24.12) with native type stripping: ESM and erasable TypeScript only (`erasableSyntaxOnly`), so no `enum`, `namespace`, parameter properties or decorators. `tsc` only type-checks.
- Exact dependency versions, as listed in `STATE.md`. A new dependency needs a decision recorded there.
- SQL is explicit and parameterized; never build SQL from input. Migrations are `.sql` files.
- Never call the ERP inside a database transaction.
- Lock order between existing rows: outbox message, order, stock by SKU, one `UPDATE` per row.
- Order transitions by compare-and-set; stock changes only if the transition affected a row.
- Every outbox transition is conditioned on the claim token.
- Deadlines stored in the database use the database clock; process timers use the injectable clock.
- The contract in `src/contract/` (zod) is the only source of request and response schemas: handlers infer their types from it, and the validation middleware and the tests use the same schemas. `openapi.yaml` is generated from it (`npm run openapi`), never edited by hand.
- Money in integer cents.
- Errors as RFC 9457 `application/problem+json`; never expose stack traces, SQL or internal details.
- Metric labels come from a closed list, never `orderId` or `sku`. Log fields and events follow `design.md`.
- Comments explain why, in Portuguese; do not restate the code.

## Tests

- Tests are `*.test.ts` files, placed by what they exercise:
  - unit tests (no database, network or Docker) sit next to the file they test, such as `src/cache/ttl.test.ts` or `scripts/check-spec-limits.test.ts` (`npm run test:unit`);
  - integration tests live in `test/integration/<area>/`: Testcontainers and supertest, one folder per area of `spec.md`, such as `checkout/`, `orders/` and `catalog/`;
  - shared helpers and fixtures live in `test/helpers/` and `test/fixtures/`. No test ships in the image (`.dockerignore`).
- Each test name is the ID of the criterion it proves followed by a description in Brazilian Portuguese, e.g. `CHK-01 50 checkouts simultâneos com estoque 5 aceitam exatamente 5`. Identifiers in test code stay in English.
- Anything that touches the database runs against real PostgreSQL; no database mocks.
- No `sleep`: use the injectable clock and timestamps seeded in the database.
- ERP failure tests count invoices in the simulated ERP, not calls.
- Never delete, skip or weaken a test to make it pass.

## Commands

`docker compose up`, `npm test`, `npm run test:unit`, `npm run lint`, `npm run typecheck`, `npm run openapi` (`-- --check` to compare), `npm run lint:openapi`, `npm run check:specs` and `npm run lint:commits`.
