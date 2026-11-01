# Decision records

Reference for the `/marco` skill.

Record a decision in the PR that makes it when it changes structure, a quality attribute, a dependency, a contract or how the system is built; is costly to reverse; had two or more viable options; or corrects an earlier decision. Do not record easy-to-refactor internals or how-to steps.

- Product or architecture: a new `### AD-NNN` block in `STATE.md`, in the form of `.specs/README.md`. It is accepted by the merge of its PR. An accepted AD changes only in its status line or by a dated erratum that keeps the decision; a new AD supersedes it ("substituída por AD-NNN").
- Tool or process: a row in the tool table of `STATE.md`.
- Open risk or a mistake that changed course: the risk table or a new `L-NNN` lesson.
- State the decision and its reason in the project's terms (the effect here), and cite as `.specs/README.md` ("Fontes", "Formato das referências") says: another project only as evidence, never as the reason; descriptive links that say what they support; commits, README and comments cite the AD, not external links.
