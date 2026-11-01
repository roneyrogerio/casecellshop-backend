---
paths:
  - "**/*.md"
  - ".specs/**"
---

# Documentation

Loaded when a Markdown file or a spec is read or written. The full rules are in `.specs/README.md` ("Fontes", "Formato das referências") and `.specs/codebase/CONVENTIONS.md`.

- **Language:** Brazilian Portuguese prose; identifiers, paths, commands and IDs as they are. A prompt quoted verbatim keeps its language, in a code block.
- **Plain technical writing:** direct order, short sentences, one idea per paragraph, active voice, the full name before an acronym, no foreign word that has a common Portuguese equivalent. State facts; never narrate research ("a pesquisa mostrou").
- **One term per concept:** use the term the project already uses (for example "mantenedor", "ERP simulado", "redrive"); do not introduce a synonym.
- **One fact, one home:** a number or rule lives where it is enforced (config, script, criterion); other documents link to it instead of repeating it.
- **Decisions:** the reason is technical, in the project's terms, and stands without the links. Another project or company appears only as evidence, in "Alternativas consideradas" or "Referências", never as the reason. References are descriptive links that say what the source supports; code links use a commit permalink; volatile pages carry "consultado em DD/MM/AAAA". Cite internal IDs (`AD-NNN`, `ORD-11`), not heading anchors.
- **Code and docs change together:** when code changes what a document states (a path, a name, a behavior), the same PR updates the document.
