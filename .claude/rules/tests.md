---
paths:
  - "**/*.test.ts"
  - ".claude/**/*.test.ts"
  - "test/**"
---

# Tests

Loaded only when a test file is read or written, because only then do these rules matter.

- Unit tests (no database, network or Docker) sit next to the file they test; every `*.test.ts` outside `test/integration/` runs in the `unit` project.
- Hooks and scripts: test the decision through the function the file exports, in-process, with the whole case table; only a few tests per file run it as a process, for the wiring (stdin, stdout, exit code, one allowed and one denied case). Each Node process costs ~75 ms, and a matrix run as processes once took the unit suite from 44 s to 100 s, past what a pre-push can afford. A per-test temporary git repository is for tests that change refs, config or the worktree; read-only tests share one per file.
- Tests of repository configuration with no source file to sit next to (`.github/`, `.githooks/`, `.mcp.json`, the `package.json` scripts, the agent instructions) live in `test/repo/`. Write temporary files under the system temp folder, never inside the repository: a parallel lint or an interrupted run would trip over them.
- Integration tests live in `test/integration/<area>/`: Testcontainers and supertest, one folder per area of `spec.md`. Shared helpers and fixtures live in `test/helpers/` and `test/fixtures/`.
- Each test name is the ID of the criterion it proves followed by a description in Brazilian Portuguese, e.g. `CHK-01 50 checkouts simultâneos com estoque 5 aceitam exatamente 5`. Identifiers stay in English.
- Prefer the real implementation: PostgreSQL through Testcontainers, and the simulated ERP (and, for a queue, its emulator) for external services. Never simulate database queries or results: the guarantees live in PostgreSQL behavior (conditional updates, locks, `SKIP LOCKED`, constraints, `ON CONFLICT`, aborted transactions).
- When the real implementation cannot produce a case on demand (a code defect, an aborted transaction, a service down), inject the failure at the boundary (the pool, the transport) or use a fake of our own port, and assert that the injection actually fired. A mock that verifies calls fits only when the criterion is about the number of calls (for example, N concurrent reads cause one origin query); never mock a third-party SDK.
- No `sleep`: use the injectable clock and timestamps seeded in the database. ERP failure tests count invoices in the simulated ERP, not calls.
- A concurrency test proves itself with a negative control: a naive version with a forced window must fail it.
- Never delete, skip, focus or weaken a test to make it pass; `.only`, `.skip` and a test without assertions fail the lint. `skipIf` and `runIf` escape the lint, so they are allowed only for a documented environment condition, never to hide a failure.
