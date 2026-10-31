# Changing the factory

Read this before changing the skill, the agents, the hooks, the CI or the settings. Such a change goes in its own `chore(ai)` PR, with a time ceiling stated in its plan, never inside a milestone PR. After changing instructions, run `npm run check:instructions`.

A change earns its place by making the flow more reliable, faster to run, faster to develop with, better guaranteed or cheaper in tokens, and it says which one. To change it:

1. **Start from evidence:** a review finding, a failed run, a transcript showing an agent doing the wrong thing, or a maintainer request. State the problem as its effect on this project.
2. **Check the documented way first:** the Claude Code docs for the feature involved (best practices, hooks, sub-agents, skills, memory, settings, permissions) and the docs of the tool itself; then how established projects solve it. Prefer a documented feature over code of our own, and our own small script over a new dependency. The research stays out of the repository (see "Decision records" in `SKILL.md`). When the research reaches a clear best option, apply it; ask the maintainer only without consensus, for a new cost or dependency, or for an action on the maintainer's accounts and settings.
3. **Put the rule where it is enforced at the right strength:** what must always or never happen goes in a hook, a `deny` rule, the CI or the ruleset; `AGENTS.md` holds only facts every task needs and Claude cannot see in the code; `.claude/rules/` holds the convention of one area; the skill holds procedures, and its reference material goes in files like this one; an agent file holds what one role needs. A written rule that keeps being missed moves to a hook, and a hook that only enforces a preference is removed.
4. **Respect the documented size limits:** `CLAUDE.md`/`AGENTS.md` and each rule under 200 lines, each `SKILL.md` under 500 lines and 12,000 bytes (what compaction re-attaches), each rule under 40,000 characters. The CI checks them (`FND-06`).
5. **Same flow as a milestone:** criteria, failing tests from `test-writer` with a negative control for each guard, the change, a green CI and an independent review round on the delta.
6. **Use the dedicated tools:** read files with Read and change them with Edit or Write; Bash runs commands, never edits files.
7. **Prove it live when you can** (the hook fired, the guard denied, the script ran in a clean environment), and say what could not run. A change that claims to save tokens or time measures it: the same task before and after, with the numbers from `/usage` or the run time in the PR.
8. **Record it:** the decision in `STATE.md` in the project's terms, and the item checked off or moved to the next plan.
