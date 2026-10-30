---
paths:
  - "**/*.test.ts"
  - ".claude/**/*.test.ts"
  - "test/**"
---

# Tests

Loaded only when a test file is read or written, because only then do these rules matter.

- Unit tests (no database, network or Docker) sit next to the file they test; every `*.test.ts` outside `test/integration/` runs in the `unit` project.
- Integration tests live in `test/integration/<area>/`: Testcontainers and supertest, one folder per area of `spec.md`. Shared helpers and fixtures live in `test/helpers/` and `test/fixtures/`.
- Each test name is the ID of the criterion it proves followed by a description in Brazilian Portuguese, e.g. `CHK-01 50 checkouts simultâneos com estoque 5 aceitam exatamente 5`. Identifiers stay in English.
- Anything that touches the database runs against real PostgreSQL; no database mocks. No `sleep`: use the injectable clock and timestamps seeded in the database. ERP failure tests count invoices in the simulated ERP, not calls.
- A concurrency test proves itself with a negative control: a naive version with a forced window must fail it.
- Never delete, skip, focus or weaken a test to make it pass; `.only`, `.skip` and a test without assertions fail the lint. `skipIf` and `runIf` escape the lint, so they are allowed only for a documented environment condition, never to hide a failure.
