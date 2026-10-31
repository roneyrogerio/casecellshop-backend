---
name: app-check
description: Run the whole system through docker compose and walk the main flow (checkout, worker, invoiced status, worker metrics and logs) to collect evidence for a pull request. Use in the "Ready and merge" step of /marco, before the PR leaves draft, or when asked to see the running app.
---

# Run the app and collect evidence

The tests prove what they assert. This run reads the real output of the assembled system (headers, logs, metrics) to catch what no assertion covers: wiring in `src/main/`, compose configuration, a missing log field. Run it once per PR, on the HEAD that is about to leave draft. It is not named `verify` on purpose: Claude Code runs a project skill named `verify` before every commit, which would bring the compose up on each slice.

Write the evidence in Brazilian Portuguese. Keep each output trimmed to the lines that show the point.

## Steps

1. **Up:** `docker compose up -d --build`, then wait until `curl -sf http://127.0.0.1:${API_PORT:-3000}/health` answers (up to 90 s). If the port is busy, set `API_PORT`.
2. **Store catalog (until the M4 sync exists):** the seed fills only `erp_sim.products`. Copy it into the store tables:

   ```sh
   docker compose exec -T postgres psql -U casecellshop -d casecellshop -v ON_ERROR_STOP=1 -c "
     insert into products (sku, name, price_cents) select sku, name, price_cents from erp_sim.products on conflict (sku) do nothing;
     insert into inventory (sku, on_hand) select sku, on_hand from erp_sim.products on conflict (sku) do nothing;"
   ```

   Remove this step when the sync fills the catalog; then wait for its first round instead.
3. **Checkout:** `curl -si -X POST http://127.0.0.1:${API_PORT:-3000}/checkout` with `Content-Type: application/json`, a fresh `Idempotency-Key`, `X-Request-Id: app-check-<timestamp>` and the body `{"items":[{"sku":"CAPA-MOTO-G84","quantity":1,"expectedUnitPrice":4990}]}`. Expect `202` with `orderId`, `Location` and `Retry-After`. Send the same request again: same `orderId`.
4. **Status:** poll the `Location` until `invoiced` (up to 30 s).
5. **Worker metrics:** the port is not published, so read it inside the container:

   ```sh
   docker compose exec -T worker node -e "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then((t) => console.log(t.split('\n').filter((l) => /^(outbox_|erp_|order_)/.test(l)).join('\n')))"
   ```

6. **Logs:** `docker compose logs --no-color api worker | grep <X-Request-Id>`. Check that the worker lines carry `correlationId`, `orderId`, `attempt`, `trace_id` and `span_id`.
7. **Down:** `docker compose down -v`, also when a step fails.

## Report

Post one PR comment starting with `## Evidência rodando o app`: the HEAD SHA, each command and its trimmed output, and a list of anything unexpected. Each unexpected item is a finding: route it like a reviewer's finding (code to `implementer` with a test from `test-writer`). If a step cannot run (no Docker, port in use), say what did not run; never report it as passing.
