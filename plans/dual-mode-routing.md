---
status: done
pr: 7
depends: [engine-plugin]
specs:
  - specs/facade.md
issues: []
---

# Dual-mode routing: registry, mode resolution, parity ledger

## Scope

The dual-mode seam: one API surface, per-route backend selection between offline (engine) and online (proxy). A route registry expressed as route config, per-route mode resolution in a hook, the parity ledger as a reviewable gitsheet, and serializer parity via per-route response schemas. Online-mode adapters can be stubs at this stage — the point is the seam and the ledger, not real upstreams.

## Implements

- `specs/facade.md` § Rule, § Mode model, § Offline mode, § Online mode

## Approach

1. **Route registry as route config** — each route declares `mode: offline-only | online-only | dual` via Fastify route options; a boot-time check validates the registry against actually-registered routes and fails startup on drift.
2. **Mode resolution hook** — resolve per-route mode (deployment default, overridable per session at login for `dual` routes) before the handler; offline routes flow through the request=commit wrapper, online routes through the adapter path (no commit).
3. **Parity ledger** — a gitsheet tracking each route's status with links to the scenario behaviors that define it; "backend caught up" = a PR flipping `offline-only` → `dual`, reviewed against the scenario's recorded request/response pairs.
4. **Serializer parity** — one Fastify per-route response schema serializes both backends; a mismatch is a contract-conformance failure.
5. Online adapters: a thin adapter interface + a stub/echo implementation; shadow-capture is a documented seam, deferred.

## Validation

- [x] Registry↔routes drift fails boot (`src/tests/routing.test.ts` "boot-time registry↔routes drift check" — a registered route missing from the ledger, a stale ledger entry with no matching route, and a mode mismatch between code and ledger each independently fail `fastify.ready()`)
- [x] An `offline-only` route serves engine behavior and commits; an `online-only` route proxies and does not commit; a `dual` route selects per deployment/session (`src/tests/routing.test.ts` "mode dispatch end-to-end" — covers all three, plus the online branch never requiring a session and never advancing the session ref)
- [x] The same response schema validates both an offline and an online response for a `dual` route (`assertMatchesResponseSchema` against `catalogItemSchema`, exercised on both an offline- and an online-produced body from `GET /catalog/:slug`)
- [x] The parity ledger is a real, queryable gitsheet (`readRegistry()` reads `registry/` back through `tx.sheet('routes').queryAll()` off `refs/registry/routes`)

## Risks / unknowns

- Per-session mode override interacting with the session handle from engine-plugin — keep mode a property of the resolved session. **Resolved as designed:** `ResolvedSession.modeOverride` (plain `string`, untyped at the engine-plugin layer deliberately — see `src/plugins/engine.ts`) is populated by a `Mode-Override:` trailer on the fork commit, read via the same first-parent-log walk as `Scenario-name:` (refactored into a shared `forkTrailers()` helper in `session.ts`). The routing layer narrows/validates it into a `Backend` in `src/routing/mode.ts`.

## Notes

**Where the ledger physically lives.** `specs/facade.md` calls the parity ledger "a reviewable file (a gitsheet, naturally)" without specifying storage. Two options were considered: (a) open the *application's own* `.git` at runtime and read `registry/` off its committed tree, or (b) import `registry/` into the runtime store as a derived ref, mirroring `boot-import.ts`'s fixture handling. Went with (b): `.git` isn't guaranteed to ship with a deployed build (the whole point of "no build step, ship the source" doesn't promise a working tree's VCS metadata comes along), and reusing the *existing* shared gitsheets `Repository` instance (`fastify.engine.repo`) for the read sidesteps re-triggering the two-separate-`Repository`-instances race documented at length in `runtime-store.ts`. `registry-import.ts` and `registry-store.ts` are the result — deliberately parallel in shape to `boot-import.ts` / the session read path.

**`exposeHeadRoute: false` was a real gotcha, not a nicety.** Fastify 5 auto-registers a HEAD variant for every GET unless told not to; that shadow route inherits `config.mode` and immediately tripped the registry-drift check in testing (a route the ledger never declared). `register-route.ts` disables it explicitly — the ledger tracks routes the facade actually declares, not Fastify's derived ones.

**Fixed a latent test-isolation bug while building this.** `src/tests/helpers.ts`'s `buildTestApp` mutated `process.env` for its overrides and never restored it; harmless while only `FIXTURES_PATH`/`RUNTIME_REPO_PATH` were involved (their values are valid across the whole run), but this plan's `REGISTRY_PATH` override — which legitimately differs per test — leaked across test *files* under `bun test`'s single-process run and broke `health.test.ts`. Fixed by snapshotting and restoring the overridden keys around registration+`ready()` (safe because `@fastify/env` resolves `fastify.config` once at registration; nothing downstream reads `process.env` directly, per this repo's own convention).

**Rebased onto `main` mid-flight.** `git-exposure` (PR #5) merged while this was in progress; rebasing produced conflicts in `src/app.ts` and `src/plugins/env.ts` (both plans add a plugin registration line and env keys) — resolved by keeping both additions, renumbering `app.ts`'s registration-order comments.

**No production routes ship in this PR.** Per the plan's own scope ("the point is the seam and the ledger, not real upstreams") and to avoid ledger entries with no owner, `registry/routes/` ships empty (mirroring `fixtures/scenarios/`) and the three demo routes (one of each mode) live under `src/tests/support/` — exercised by tests, not registered in `app.ts`. `plans/demo-world.md` is expected to be the first plan to populate `registry/routes/` with real entries.

## Follow-ups

- Real per-service online adapters (auth injection, shape mapping, version selection) — only the echo stub exists.
- Shadow capture (recording online responses as candidate fixture material) — documented seam in `src/routing/adapters.ts`, not implemented.
- A login HTTP route accepting a client-requested mode override doesn't exist yet — `RuntimeStore.fork()`'s `modeOverride` option is exercised directly in tests (as `fastify.engine.fork()` already is elsewhere); wiring it to an actual `/session/login`-style endpoint is unclaimed by any plan so far.
- `registry/routes/` ships empty; the next plan that adds real dual-mode-facade routes (`plans/demo-world.md`) should populate matching ledger entries in the same PR, or boot will fail on drift.
