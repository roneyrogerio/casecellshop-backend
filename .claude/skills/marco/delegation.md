# Delegation and waiting

Reference for the `/marco` skill: the task map, bringing an agent's work in, the CI, the review report, and how to wait.

## Task map

Sent in every delegation prompt (a subagent does not see the conversation):

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

## Bringing the work in

Read `.claude/state/stop-exceptions.log` first: a stop-hook exception is an escalation, and a git-state change listed there is undone before anything else.

The agent's result names its worktree `<wt>` and branch. Run `git -C <wt> add -A && git -C <wt> diff --cached --binary | git apply --index`, then `git -C <wt> reset -q && git worktree remove --force <wt> && git branch -D <branch>`. If the apply fails, `git restore --staged --worktree` the files it touched and retry. If the removal is refused because the agent still holds the worktree lock, remove it after the agent's completion notice. Then check `git status` against the role and commit.

**Without a worktree** (the result names no worktree of this agent, and no new one appeared under `.claude/worktrees/` during its run; a worktree left by an earlier agent or by another session does not count): `isolation` did not apply and the agent edited the main folder. Its stop hook already checked only what changed there during the run (AI-28). There is nothing to apply: check `git status` against the role, undo any file outside it, commit the rest, and record the missing isolation in the milestone record. If it happens twice, check before the next delegation `claude --version`, the `isolation: worktree` line in the frontmatter of `.claude/agents/implementer.md` and `.claude/agents/test-writer.md`, which turns the isolation on, and the `worktree` keys of `.claude/settings.json` (AI-24).

## CI

Read it with `mcp__github__pull_request_read` (`method: get_check_runs`) and, on a failure, `mcp__github__get_job_logs` (`failed_only: true`, `return_content: true`, `tail_lines: 200`), so only the failing tail enters the context. Route it: code → `implementer` (escalation step for that problem); a test that looks wrong → `implementer` reports with evidence and `test-writer` fixes it; oracle, spec or contract → you; infrastructure → one re-run, then treat as a code problem.

## Review report

Before a whole-PR round, run `git fetch origin` yourself: the reviewer only reads git (AI-11), and a ref change in its run is logged as an exception (AI-12). A hook saves its report to `.claude/reviews/<agent_id>.md` (AI-15); post that file's text unchanged with `mcp__github__add_issue_comment`: a hook refuses a comment that differs from a saved report, so the PR shows the report exactly as written. Never write that folder yourself.

## Waiting

No documented way delivers the end of a CI run, a review or a merge to a local session yet (`STATE.md`, tool table, "Espera pelo CI e por comandos longos"). So:

- a long local command (`verify:full`, app-check) runs with Bash `run_in_background` or under `Monitor`, and you keep working until its notice arrives;
- a delegated agent runs in the background, and its completion notice is the signal;
- the CI is read through the MCP only after each push and before each review round, never on a fixed timer or a `sleep` loop. If it is still running, do the next independent step (the next slice's `test-writer`) and read it again before the review. A new push cancels the PR's previous run (AI-17), so push a slice's fix only after reading the run that covers it.
