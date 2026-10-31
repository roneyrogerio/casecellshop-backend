---
name: app-check
description: Run the whole system through docker compose and walk the main flow (checkout, worker, invoiced status, worker metrics and logs) to collect evidence for a pull request. Use in the "Ready and merge" step of /marco, before the PR leaves draft, or when asked to see the running app.
---

# Run the app and collect evidence

The tests prove what they assert. This run reads the real output of the assembled system (headers, logs, metrics) to catch what no assertion covers: wiring in `src/main/`, compose configuration, a missing log field. Run it once per PR, on the HEAD that is about to leave draft. It is not named `verify` on purpose: Claude Code runs a project skill named `verify` before every commit, which would bring the compose up on each slice.

Every `docker compose` command uses the project name `-p casecellshop-app-check`, so the run never touches the maintainer's own compose or its data volume, and starts from a fresh database. The host has no HTTP client to use (`curl` and `wget` are denied by `.claude/settings.json`): every HTTP call runs inside a container with `node -e` and `fetch`. Never work around that denial.

Write the evidence in Brazilian Portuguese. Keep each output trimmed to the lines that show the point.

## Steps

`dc` below stands for `docker compose -p casecellshop-app-check`; write the full command each time.

1. **Up:** `API_PORT=0 JAEGER_UI_PORT=0 dc up -d --build` (port `0` lets Docker pick free host ports). Then wait for the API from inside its container (up to 90 s):

   ```sh
   dc exec -T api node -e "const end = Date.now() + 90000; (async () => { for (;;) { try { const r = await fetch('http://127.0.0.1:3000/health'); if (r.ok) { console.log('health', r.status); return; } } catch {} if (Date.now() > end) process.exit(1); await new Promise((s) => setTimeout(s, 2000)); } })()"
   ```

2. **Store catalog (until the M4 sync exists):** the seed fills only `erp_sim.products`. Copy it into the store tables:

   ```sh
   dc exec -T postgres psql -U casecellshop -d casecellshop -v ON_ERROR_STOP=1 -c "
     insert into products (sku, name, price_cents) select sku, name, price_cents from erp_sim.products on conflict (sku) do nothing;
     insert into inventory (sku, on_hand) select sku, on_hand from erp_sim.products on conflict (sku) do nothing;"
   ```

   Remove this step when the sync fills the catalog; then wait for its first round instead.
3. **Checkout, twice with the same key:** expect `202` with `orderId`, `Location` and `Retry-After`, and the same `orderId` on the repeat.

   ```sh
   dc exec -T -e KEY=app-check-key-<timestamp> -e RID=app-check-<timestamp> api node -e "const post = () => fetch('http://127.0.0.1:3000/checkout', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': process.env.KEY, 'x-request-id': process.env.RID }, body: JSON.stringify({ items: [{ sku: 'CAPA-MOTO-G84', quantity: 1, expectedUnitPrice: 4990 }] }) }).then(async (r) => console.log(r.status, r.headers.get('location'), r.headers.get('retry-after'), await r.text())); post().then(post)"
   ```

4. **Status:** poll the `Location` from inside the container until `invoiced` (up to 30 s), printing each response.
5. **Worker metrics:** the port is not published, so read it inside the container:

   ```sh
   dc exec -T worker node -e "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then((t) => console.log(t.split('\n').filter((l) => /^(outbox_|erp_|order_)/.test(l)).join('\n')))"
   ```

6. **Logs:** `dc logs --no-color api worker | grep <X-Request-Id>`. Check that the worker lines carry `correlationId`, `orderId`, `attempt`, `trace_id` and `span_id`.
7. **Down:** `dc down -v`, also when a step fails.

## Report

Put the evidence in the PR description, in a section `## Evidência rodando o app`, with `mcp__github__update_pull_request` (`body`). The `body` replaces the whole description: read the current one first with `mcp__github__pull_request_read` (`method: get`) and add or replace only this section, never dropping the rest. The section holds the HEAD SHA, each command and its trimmed output, and a list of anything unexpected. Not a comment: the GitHub guard accepts only the reviewer's saved reports and the security review as comments, and the description is the place for what the main session writes. Each unexpected item is a finding: route it like a reviewer's finding (code to `implementer` with a test from `test-writer`). If a step cannot run (no Docker), say what did not run; never report it as passing.
