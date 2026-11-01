---
paths:
  - "src/**"
---

# Architecture

Loaded when a file under `src/` is read or written. The table and the reasons are in `.specs/codebase/CONVENTIONS.md` ("Pastas do código", "Tamanho e forma do código") and AD-025/AD-026; the numbers live in `.oxlintrc.json`, which `npm run lint` enforces.

- **Where a file goes:** the folder of the business capability it serves (`checkout/`, `orders/`, `health/`, `billing/`, `catalog/`), or of the external system it adapts (`erp/`, `db/`, `queue/`, `http/`, `cache/`); `shared/` only for code every capability uses and that knows no business concept; `main/` only to read configuration and wire each process. Never create a layer folder (`services/`, `repositories/`, `utils/`).
- **Dependency direction:** `main/` → business → boundary, contract, `shared/`. A boundary or `shared/` never imports a business folder, and a business folder never imports another one. Only `main/` imports `erp/sim/`.
- **Ports and adapters:** a port is named by the conversation the business needs (`ErpClient`, `Queue`), not by the technology; the adapter holds the technology.
- **When the lint flags size or complexity:** split by responsibility (move inner functions of a `createX` factory to module level with their dependencies as parameters; one file per responsibility in the same folder). Never raise a limit, disable a rule or add a lint-disable comment; a real exception needs an AD, which is the main session's.
- **Configuration:** read the environment only in `src/shared/config.ts`; `main/` passes values down.
- **Duplication:** before writing a helper, search for an existing one (`grep`); the same logic twice is a finding.
- **Language:** identifiers, file names, log events and metric names in English; comments and log/error messages in Brazilian Portuguese, explaining why. Use the project's term for each concept (`.specs/codebase/CONVENTIONS.md`).
