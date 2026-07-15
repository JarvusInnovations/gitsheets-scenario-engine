---
status: done
pr: 8
depends: [engine-plugin, dual-mode-routing]
specs:
  - specs/scenario-engine.md
  - specs/facade.md
issues: []
---

# Demo world: the living example

## Scope

A small, believable world that exercises every load-bearing concept: 3–4 sheets, 2 scenarios, and a handful of `dual`/`offline-only` routes including at least one state machine, so the template is a runnable example rather than an abstraction. The demo is the surface the e2e harness and the docs recipe build on.

## Implements

- `specs/scenario-engine.md` § Concepts, § Request = commit (a concrete world)
- `specs/facade.md` § Offline mode (the state-machine-in-handler discipline)

## Approach

1. 3–4 sheets under `fixtures/.gitsheets/` with JSON Schemas — a generic micro-domain (e.g. orders / routes / notifications), deliberately not the original client's.
2. Two scenarios: a `standard` baseline and a divergent one (e.g. an edge-case order) as `fixtures/scenarios/<name>/` overlays over `fixtures/base/`.
3. A handful of routes: at least one `offline-only` (executable spec for unbuilt backend), at least one `dual`, and one non-trivial state machine (e.g. accept → in-progress → complete) implemented as plain handler code operating on records — demonstrating the **all-state-in-records** discipline (nothing in process memory).
4. A trivial demo client or curl script showing login (fork) → a few requests → clone-the-session.

## Validation

- [x] Booting the demo imports both scenarios deterministically (`src/tests/demo-world.test.ts` "boot: both scenarios import deterministically" — asserts both `standard-day` and `rush-hour` produce baseline refs, and that two independent boots of the shipped fixtures agree byte-for-byte on both)
- [x] The state-machine flow produces the expected sequence of commits and terminal record state (`src/tests/demo-world.test.ts` "the order state machine: accept -> start -> complete" — exactly one commit per transition, terminal `status: "completed"`, the assigned courier freed back to `available`, and exactly one `notifications` record per transition)
- [x] No state lives outside records — a clone + replay of a demo session reproduces it exactly (`src/tests/demo-world.test.ts` "all-state-in-records" — `replaySession()` re-executes the request log against a fresh fork with zero divergences, AND a real `git fetch` over the live git-exposure endpoint reproduces a byte-identical tree with the record readable straight out of the clone)

## Risks / unknowns

- Keeping the domain generic enough to publish (no client identifiers) while rich enough to be convincing.

## Notes

- The domain: `couriers`, `orders`, `notifications`, `clock` (a generic delivery-desk
  micro-domain, deliberately not the original client's). Two scenarios: `standard-day`
  (baseline) and `rush-hour` (divergent — two couriers already busy, so only one of two
  pending rush orders can be accepted).
- `POST /session/login` is deliberately **not** registered through `registerModeRoute()`
  — that helper's offline dispatch requires `request.session` to already be resolved
  before it will invoke a route's `offline` handler, and login is what *creates* the
  session a later request's `x-session-key` header resolves. It's infrastructure for
  reaching the dual-mode facade, not a route the facade itself serves — the same
  exemption `/health` already has (no `config.mode`, no parity-ledger entry). See
  `src/routes/session.ts`'s module comment.
- Found and fixed a real bug in the already-shipped `git-exposure` plugin
  (`src/plugins/git-http.ts`) while verifying `scripts/demo.sh` end-to-end against
  default config: `invokeGitHttpBackend` passed the same possibly-relative `gitDir` as
  both the CGI subprocess's `cwd` and its `GIT_PROJECT_ROOT` env var, so a relative
  `RUNTIME_REPO_PATH` (the shipped default) caused a double-relative resolution that
  silently 404'd every ref advertisement. Every existing test happened to use an
  absolute path, so this never surfaced until a real `git clone` against dev defaults.
  Fixed with `path.resolve()`; added a regression test (confirmed to fail against the
  pre-fix code and pass against the fix).
- Because `app.ts` now registers the demo world's routes unconditionally (it's the
  shipped app, not a test-only fixture), `src/tests/routing.test.ts`'s scaffolded
  parity ledger had to grow the demo world's entries too — every `buildTestApp()` call
  in that suite boots the whole app, not just the routes under test.
- `src/tests/demo-world.test.ts` deliberately boots against the real `fixtures/` and
  `registry/` trees (not scratch scaffolds like `engine.test.ts`/`routing.test.ts`) —
  the point is proving the *shipped* demo world works, not a stand-in.

## Follow-ups

- `e2e-harness` (next in the DAG) can lean on `src/routes/orders.ts` and
  `src/tests/demo-world.test.ts` as the worked example for its `fastify.inject()` +
  commit/record assertion pattern.
- `docs-recipe`'s worked example is this demo world verbatim — sheets, scenarios,
  routes, and `scripts/demo.sh` are all named there for cross-reference.
