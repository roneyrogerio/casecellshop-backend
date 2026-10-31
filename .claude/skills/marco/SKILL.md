---
name: marco
description: Runs one milestone of the CaseCellShop roadmap end to end (plan, tests, code, review, PR), or closes it after the merge.
argument-hint: "<milestone, e.g. M2> | fechar"
disable-model-invocation: true
---

# Milestone workflow

You are the main session: you orchestrate one milestone (`$ARGUMENTS`). You plan, write specs, the contract, ADs, docs, the CI and every file that configures verification; you make every commit and drive the PR through the `mcp__github__*` tools. Tests come only from `test-writer`, production code only from `implementer`, and the review only from `reviewer`. Agents run one at a time, and you change no git state while one runs: its stop hook compares a git snapshot taken at its start (AI-12). Talk to the maintainer in Brazilian Portuguese.

## Essentials (keep these even after compaction)

- The maintainer acts at four points only: approves the plan, decides exceptions, does the fixed ~10 min check, approves and merges. Everything else is yours and the agents'.
- The CI is the oracle. A slice is done when its `feat:` commit is green and a review round covers it. Never report done on a red or unrun check.
- One review round per slice; a new round only when a commit outside the free list lands after it, covering only that delta. Reviewing stops when no `alta` or `média` finding is open (AD-015); `baixa` never blocks and becomes a checklist item of the next plan. A blocking finding comes with a reproduction, and its fix with a test that failed before it. The maintainer decides on the third round over the same finding, or when fixes create a new `média` twice in a row.
- `implementer` escalation: step 0 frontmatter (Sonnet, `medium`); step 1 `model: sonnet`, `effort: high`; step 2 `model: opus`, `effort: high`, at most two calls per problem; past it, the maintainer decides.
- Never `--force`, never push to `main`, never merge, never approve. GitHub only through the `mcp__github__*` tools (owner `roneyrogerio`, repo `casecellshop-backend`), acting as the identity configured for the clone (`git config casecellshop.identity`, AI-14); in `bot` mode `git push` uses the machine account's credential.
- Start by reading the `SessionStart` environment report; if something is missing, tell the maintainer the fix before any work.

## 1. Start

1. Fresh session (`/clear` before a new milestone). Run `claude --version` (need 2.1.292 or later for per-call `model` and `effort`), `git status` and `git switch main && git pull --ff-only`. Read the milestone section of `ROADMAP.md` and the pending items left by the previous plan.
2. Create the branch `feat/<area>` (or `chore/<subject>` for process work).

## 2. Plan (plan mode)

Read only the sections you need: the milestone criteria in `spec.md`, the matching `design.md` sections, the ADs they cite, the contract and the code they touch. Produce, in Portuguese:

- the criteria in scope, with any `SPEC_DEVIATION` found (criterion, evidence, proposed fix);
- slices by area, each of at most ~400 lines of production code (`src/`, `migrations/`), checked after each `feat:` with `git diff --shortstat <base>..HEAD -- src migrations`; if the milestone estimate passes ~800 lines, split it into two PRs;
- for each slice, the task map below;
- the ADs to propose, the stubs to create, and the pending items inherited from the previous milestone as checklist items;
- the `DOC-*` criteria this milestone touches (the answers to the challenge questions), drafted in `ARCHITECTURE.md` in this same PR;
- the threats the milestone's area opens, each with the criterion that covers it (AD-016).

Task map, sent in every delegation prompt (a subagent does not see this conversation):

```text
Fatia N de M · Área: <área> · Critérios: <IDs>
Tarefa: <uma frase>
Ler (só estes trechos): spec.md § <seção>; design.md § <seção>; STATE.md § AD-NNN; <arquivos>
Tocar: <arquivos ou pastas>
Stubs já criados: <arquivos e rotas>
Testes que devem passar: <arquivos>
Estimativa: ~<linhas> linhas de produção
Achados e CI (correções): <texto do achado ou .claude/reviews/<arquivo>.md>; <cauda do log do CI>
Se faltar algo: buscar com grep e listar no relatório o que leu além do mapa.
```

Show the plan to the maintainer and wait for approval (maintainer point 1).

## 3. Specs, contract and stubs

Update `spec.md`, `design.md`, the contract in `src/contract/` (then `npm run openapi`), the ADs and the `ARCHITECTURE.md` drafts. Create typed stubs for every route and module in the maps: a route answers `501` in `application/problem+json`; a function throws `new Error('não implementado')`. Stubs let the tests type-check and fail on assertions, not on imports or 404. Commit, `git push -u origin HEAD`, and open the PR with `mcp__github__create_pull_request` (`draft: true`, `base: main`, title in the commit format), with the approved plan as a checklist in the body.

## 4. Each slice

1. `test-writer` with the map: failing tests for the slice criteria. Its stop hook requires lint and typecheck green. Check `git status` against the role, then commit `test(<escopo>): …`. The tests must fail by assertion; a collection error goes back to it.
2. `implementer` with the map and the test files: code until the slice tests pass. Its stop hook runs `npm run verify:fast` and sends it back while anything is red (after the third return it lets it stop and reports an exception: treat it as an escalation). Read `.claude/state/stop-exceptions.log` (a stop-hook exception is an escalation; a git-state change listed there is undone by you before anything else); check `git status` against the role, then commit `feat(<escopo>): …`, `git push`, and tick the checklist with `mcp__github__update_pull_request` (`body`).
3. Read the CI with `mcp__github__pull_request_read` (`method: get_check_runs`) and, on a failure, `mcp__github__get_job_logs` (`failed_only: true`, `return_content: true`, `tail_lines: 200`), so only the failing tail enters the context. Route it: code → `implementer` (escalation step for that problem); a test that looks wrong → `implementer` reports with evidence and `test-writer` fixes it; oracle, spec or contract → you; infrastructure → one re-run, then treat as a code problem.
4. `reviewer` on the slice delta (`git diff <base>..<head>`), with the map's criteria, the plan, the CI summary, the round number and, from the second round on, the path of the previous report in `.claude/reviews/`. Before a whole-PR round, run `git fetch origin` yourself: the reviewer only reads git (AI-11), and a ref change in its run is logged as an exception (AI-12). A hook saves its report to `.claude/reviews/<agent_id>.md` (AI-15); post that file's text unchanged with `mcp__github__add_issue_comment`: a hook refuses a comment that differs from a saved report, so the PR shows the report exactly as written. Never write that folder yourself. Route findings: code → `implementer` (escalation); tests → `test-writer`; spec, docs, ADs, CI → you. Each fix commit outside the free list needs a new round on its delta.

The free list (commits that need no new round): the status line of `ROADMAP.md`, the PR description and its checklist. `README.md` is not free: the challenge evaluates it.

## 5. Exceptions (maintainer point 2)

Stop and ask the maintainer, in one question, with your recommendation, when: a `SPEC_DEVIATION` changes a criterion; a new dependency is needed; a ceiling is reached (review rounds, escalation, stop-hook exception); a finding is contested; the milestone passes the size cut.

## 6. Ready and merge

The PR is ready when every slice has its `feat:` green, the last review round covers the HEAD (or only free-list commits came after it), no `alta` or `média` finding is open, the checklist is complete and no `SPEC_DEVIATION` remains. Then:

- write the milestone record in the PR description: rounds and findings by severity, findings the `reviewer` got wrong, escalation steps used, red CI runs by cause, approvals asked, the milestone's token use from `/usage`, lessons (1–3), and the pending items for the next plan;
- update the `ROADMAP.md` status line;
- run the `app-check` skill through the Skill tool on the HEAD and put its evidence in the PR description (AI-22); an unexpected output is a finding;
- run `npm run verify:full`, push, then `/security-review` through the Skill tool on that HEAD (AI-16; only the Skill tool records it, a typed command does not); post its report as a comment starting with `## Revisão de segurança`, and treat its `alta` and `média` findings like the reviewer's (a fix commit needs a new review round and a new `/security-review`);
- `mcp__github__update_pull_request` with `draft: false` and `reviewers: ["roneyrogerio"]` (GitHub notifies the maintainer), and tell the maintainer, in a few lines, what to read: the criteria × test names table of the CI summary and the `ARCHITECTURE.md` sections of the `DOC-*` criteria this milestone touched (maintainer point 3, ~10 min). The maintainer approves on GitHub (point 4); the approval turns on auto-merge, and GitHub merges once the ruleset is satisfied. A commit after the approval dismisses it. If the CI turns red after `draft: false`, ask the maintainer to convert the PR back to draft: the machine account cannot.

## 7. Close (`/marco fechar`)

`git fetch --prune`, `git switch main`, `git pull --ff-only`, `git branch -d <branch>`; set each AD the merge accepted to `aceita (<data>, PR #<n>)` (from then on it is never edited: a new AD supersedes it); confirm `ROADMAP.md` points to the next milestone; print the first step for it.

## Commits

Conventional Commits, type in English and description in Portuguese, lowercase start (start with a verb, never with a proper noun), header up to 100 characters, body with the motivation; a local `commit-msg` hook runs commitlint. Commit messages go in a file (`git commit -F <file>`), written with the Write tool: the Bash guard reads a heredoc's text as part of the command. Trailers, after a blank line:

```text
Co-Authored-By: Claude <model name> <noreply@anthropic.com>
Assisted-by: <main|test-writer|implementer>:<model-id> effort=<level> step=<0|1|2>
```

The first trailer credits the model that produced most of the commit; the second says which role, model, effort and escalation step produced it, so the history shows who did what.

## Decision records

Record a decision in the PR that makes it when it changes structure, a quality attribute, a dependency, a contract or how the system is built; is costly to reverse; had two or more viable options; or corrects an earlier decision. Do not record easy-to-refactor internals or how-to steps.

- Product or architecture: a new `### AD-NNN` block in `STATE.md` (context, decision, alternatives, trade-off, "Rever quando", references). It is accepted by the merge of its PR. An accepted AD is never edited except its status line: a new AD supersedes it ("substituída por AD-NNN").
- Tool or process: a row in the tool table of `STATE.md`.
- Open risk or a mistake that changed course: the risk table or a new `L-NNN` lesson.
- State the decision and its reason in the project's terms (the effect here: "so the setup works without a keychain on WSL"). Research informs the decision and stays out of the repository: no market comparisons, adoption numbers or "project X does it" in `STATE.md`, the README or commit messages. Sources go only under "Referências". The same applies to the reason written in a commit body.

## Process changes

A change to this skill, the agents, the hooks, the CI or the settings follows [process-changes.md](process-changes.md): read it before planning one.
