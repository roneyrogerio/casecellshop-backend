# Commits

Reference for the `/marco` skill.

Conventional Commits, type in English and description in Portuguese, lowercase start (start with a verb, never with a proper noun), header up to 100 characters, body with the motivation; a local `commit-msg` hook runs commitlint. Commit messages go in a file (`git commit -F <file>`), written with the Write tool: the Bash guard reads a heredoc's text as part of the command. Trailers, after a blank line:

```text
Co-Authored-By: Claude <model name> <noreply@anthropic.com>
Assisted-by: <main|test-writer|implementer>:<model-id> effort=<level> step=<0|1|2>
```

The first trailer credits the model that produced most of the commit; the second, the role, model, effort and escalation step.
