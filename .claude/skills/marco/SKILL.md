---
name: marco
description: Runs one milestone of the CaseCellShop roadmap end to end (plan, tests, code, review, PR), or closes it after the merge.
argument-hint: "<milestone, e.g. M2> | fechar"
disable-model-invocation: true
---

# Milestone workflow

You are the main session: you orchestrate one milestone (`$ARGUMENTS`). You plan, write specs, the contract, ADs, docs, the CI and every file that configures verification; you make every commit and drive the PR through the `mcp__github__*` tools. Tests come only from `test-writer`, production code only from `implementer`, and the review only from `reviewer`. Agents run one at a time. `implementer` and `test-writer` work in their own git worktree branched from your `HEAD` (AI-24): commit before delegating, and change no file or git state while one runs, since its stop hook flags what changed during the run (AI-12, AI-28). Talk to the maintainer in Brazilian Portuguese.

## Essentials (keep these even after compaction)

- The maintainer acts at four points only: approves the plan, decides exceptions, reads the PR's decision summary, approves and merges. Everything else is yours and the agents'.
- The CI is the oracle. A slice is done when its `feat:` commit is green and a review round covers it. Never report done on a red or unrun check.
- One review round per slice; a new round only when a commit outside the free list lands after it, covering only that delta. Reviewing stops when no `alta` or `média` finding is open (AD-015); `baixa` never blocks: a text error in lines the PR changed is fixed in this PR and checked on the fix delta inside the same round (the same line at a third check goes to the maintainer); any other `baixa` goes to the next plan (AD-022). A blocking finding comes with a reproduction, and its fix with a test that failed before it. The maintainer decides on the third round over the same finding, or when fixes create a new `média` twice in a row.
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
- for each slice, the task map of [delegation.md](delegation.md), sent in every delegation prompt;
- the ADs to propose, the stubs to create, and the pending items inherited from the previous milestone as checklist items;
- the `DOC-*` criteria this milestone touches (the answers to the challenge questions), drafted in `ARCHITECTURE.md` in this same PR;
- the threats the milestone's area opens, each with the criterion that covers it (AD-016).

Show the plan to the maintainer and wait for approval (maintainer point 1).

## 3. Specs, contract and stubs

Update `spec.md`, `design.md`, the contract in `src/contract/` (then `npm run openapi`), the ADs and the `ARCHITECTURE.md` drafts. Create typed stubs for every route and module in the maps: a route answers `501` in `application/problem+json`; a function throws `new Error('não implementado')`. Stubs let the tests type-check and fail on assertions, not on imports or 404. Commit, `git push -u origin HEAD`, and open the PR with `mcp__github__create_pull_request` (`draft: true`, `base: main`, title in the commit format), with the approved plan as a checklist in the body.

## 4. Each slice

[delegation.md](delegation.md) holds how to bring an agent's work in (also when `isolation` did not apply and it edited the main folder), how to read and route the CI, how to post the review report, and how to wait for the CI and long commands without a fixed timer.

1. `test-writer` with the map: failing tests for the slice criteria. Its stop hook requires lint and typecheck green. Bring its work in, check `git status` against the role, then commit `test(<escopo>): …`. The tests must fail by assertion; a collection error goes back to it.
2. `implementer` with the map and the test files: code until the slice tests pass. Its stop hook runs `npm run verify:fast` and sends it back while anything is red (after the third return it lets it stop and reports an exception: treat it as an escalation). Bring its work in, check `git status` against the role, then commit `feat(<escopo>): …`, `git push`, and tick the checklist with `mcp__github__update_pull_request` (`body`).
3. Read the CI after the push and route a failure.
4. `reviewer` on the slice delta (`git diff <base>..<head>`), with the map's criteria, the plan, the CI summary, the round number and, from the second round on, the path of the previous report in `.claude/reviews/`. Post its saved report unchanged. Route findings: code → `implementer` (escalation); tests → `test-writer`; spec, docs, ADs, CI → you. Each fix commit outside the free list needs a new round on its delta, except a text fix: the `reviewer` checks its delta in the same round, given the round's last report; post only the round's last report (AD-022).

The free list (commits that need no new round): the status line of `ROADMAP.md`, the PR description and its checklist. `README.md` is not free: the challenge evaluates it.

## 5. Exceptions (maintainer point 2)

Stop and ask the maintainer, in one question, with your recommendation, when: a `SPEC_DEVIATION` changes a criterion; a new dependency is needed; a ceiling is reached (review rounds, escalation, stop-hook exception); a finding is contested; the milestone passes the size cut.

## 6. Ready and merge

The PR is ready when every slice has its `feat:` green, the last review round covers the HEAD (or only free-list commits came after it), no `alta` or `média` finding is open, the checklist is complete and no `SPEC_DEVIATION` remains. Then:

- open the PR description with a `Resumo de decisão` (≤ ~300 words): what it delivers; what needs the maintainer's judgment (ADs, exceptions, `SPEC_DEVIATION`, the changed `DOC-*` answer, residual risks) or `nada`; the machine evidence listed in AD-023, one line each; risk areas touched (migration, concurrency, contract, CI, permissions), yes or no, linked;
- below it, the milestone record: rounds and findings by severity, findings the `reviewer` got wrong, escalation steps, red CI runs by cause, approvals asked, token use from `/usage`, lessons (1–3), pending items for the next plan;
- update the `ROADMAP.md` status line;
- run the `app-check` skill through the Skill tool on the HEAD and put its evidence in the PR description (AI-22); an unexpected output is a finding;
- run `npm run verify:full`, push, then `/security-review` through the Skill tool on that HEAD (AI-16; only the Skill tool records it, a typed command does not); post its report as a comment starting with `## Revisão de segurança`, and treat its `alta` and `média` findings like the reviewer's (a fix commit needs a new review round and a new `/security-review`);
- `mcp__github__update_pull_request` with `draft: false` and `reviewers: ["roneyrogerio"]` so GitHub notifies the maintainer, who reads only the decision summary, 2 to 5 min (point 3). The maintainer approves on GitHub (point 4); the approval turns on auto-merge, and GitHub merges once the ruleset is satisfied. A commit after the approval dismisses it. If the CI turns red after `draft: false`, ask the maintainer to convert the PR back to draft: the machine account cannot.

## 7. Close (`/marco fechar`)

`git fetch --prune`, `git switch main`, `git pull --ff-only`, `git branch -d <branch>`; set each AD the merge accepted to `aceita (<data>, PR #<n>)` (see "Decision records"); confirm `ROADMAP.md` points to the next milestone; print the first step for it.

## Commits and decision records

Read [commits.md](commits.md) before each commit message and [decisions.md](decisions.md) before recording a decision.

## Process changes

A change to this skill, the agents, the hooks, the CI or the settings follows [process-changes.md](process-changes.md): read it before planning one.
