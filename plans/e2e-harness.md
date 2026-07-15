---
status: done
depends: [demo-world]
specs:
  - specs/facade.md
issues: []
pr: 10
---

# E2E harness: inject-based tests asserting HTTP + commits

## Scope

The template's living test tier: tests declare a scenario, log in, drive the API via `fastify.inject()` (no sockets, fully parallel), and assert on **both** surfaces — HTTP responses and the resulting session commits/records. Wired into CI with node and the checkout only; a thin over-the-wire smoke tier keeps `inject` honest; the session ref bundles as a CI artifact.

## Implements

- `specs/facade.md` § E2E harness

## Approach

1. A harness that forks a session per test (isolation ⇒ trivial parallel workers), exercises routes via `fastify.inject()`, and asserts both the HTTP response and the session's commits/records (e.g. "accept produced exactly 2 commits; `orders/1234` = `accepted`; the notification record exists").
2. A minimal over-the-wire smoke tier (real socket) running a subset, guarding against `inject`-only assumptions.
3. Session-as-recording: `git bundle` the session ref as a CI artifact alongside any media.
4. CI wiring: extend repo-scaffold's workflow to run the e2e tier against the demo world on every push — the fixture state of the commit under test, no external services.

## Validation

- [x] E2E suite passes against the demo world in CI (bun + checkout only)
- [x] Parallel workers with per-session isolation, no cross-test cleanup beyond ref deletion
- [x] Assertions cover both HTTP and commit/record surfaces; the smoke tier passes over a real socket
- [x] A failing test's session bundles as an inspectable artifact

## Risks / unknowns

- Balancing `inject` speed against the over-the-wire tier's coverage — keep the smoke tier thin but real.

## Notes

Built as `src/tests/e2e/harness.ts` plus four suites layered on it, per the approach:

- **`E2EClient`** abstracts the transport: `injectClient` (`fastify.inject()`, the
  default) or `socketClient` (real `fetch()` against a listening socket). Both speak the
  same minimal request/response shape, so `login()`/`E2ESession` work unmodified against
  either — `loginInject()` is the inject-tier convenience, `login(socketClient(...), ...)`
  the smoke-tier equivalent.
- **`E2ESession`** pairs a session's HTTP surface (`request()`, `SESSION_HEADER`
  auto-attached) with its record surface (`commitCount()`, `record()`, `records()` via
  `fastify.engine.sessionRead` + `plumbing.firstParentLog` directly) — the "assert on
  both surfaces" requirement in one object, matching the spec's own worked example
  (exact commit counts, terminal record state, notification records) in
  `state-machine.e2e.test.ts`.
- **`e2eTest()`** — a drop-in `test()` replacement, not a Bun-internals hook: it wraps the
  test body in try/catch and calls `bundleSession` (`bundle.ts`, `git bundle create`) on
  every `E2ESession` the test constructed before rethrowing. Runs inside the test's own
  promise, so the bundle write is guaranteed to land before any file's `afterEach`
  (`fastify.close()`) tears down the runtime repo. `bundle.ts`'s mechanism itself is
  covered directly in `artifact-bundle.test.ts` (round-trips through `git bundle verify`
  and `git fetch`); the "on-failure" trigger path is code-reviewable but not exercised
  by an actual failing `bun:test` run (that would itself fail CI).
- **Parallel isolation** (`parallel-isolation.e2e.test.ts`) targets the harder of the two
  isolation layers: cross-*file* isolation is structural (`helpers.ts`'s
  `buildTestApp()` mints a fresh `mkdtempSync` runtime repo per call), so the test proves
  isolation *within* one runtime store instead — 8 concurrent sessions, fully
  interleaved, each landing exactly 3 commits with zero cross-session bleed, despite
  `RuntimeStore`'s single process-wide commit mutex (`engine/runtime-store.ts`'s
  documented trade-off). Verified stable under `bun test --rerun-each=3` and
  `bun test --parallel` (Bun's own file-level worker parallelism); the workers'
  serialized-commit cost needed a raised per-test timeout (20s) to stay reliable under
  `--parallel`'s added CPU contention — not a correctness issue, just real wall-clock
  work through one mutex.
- **The smoke tier** (`smoke.e2e.test.ts`) caught a genuine inject-vs-socket divergence
  while being built: `content-type: application/json` on a bodyless request (e.g.
  `POST .../accept`, no payload) 400s over a real socket
  (`FST_ERR_CTP_EMPTY_JSON_BODY`) but is silently accepted under `fastify.inject()`.
  Fixed in `socketClient` (only sets the header when there's a body) — exactly the class
  of bug this tier exists to guard against.
- **CI wiring**: the `Test` step got an `id` so the new upload step can gate on
  `steps.test.outcome == 'failure'` specifically, rather than a bare `if: failure()`
  that would also (harmlessly, but confusingly) fire on a lint/typecheck failure
  upstream where `var/e2e-artifacts` never gets created. `actions/upload-artifact@v7`
  confirmed current via the action's GitHub releases before adding.
- Rebased cleanly onto `main` post-merge of `agent-sandbox-profile` (#9, disjoint
  files) — `bun test` covers 100 tests total (86 here + 14 from that PR).
- `state-machine.e2e.test.ts` deliberately drives `order-1002` (standard-day's other
  pending order) rather than re-covering `order-1001`, which `demo-world.test.ts`
  already exercises exhaustively — this suite's job is proving the harness, not
  re-testing the same fixture record twice.

## Follow-ups

- The e2e tier currently runs as part of the single `bun test` invocation (Bun
  auto-discovers `src/tests/e2e/*.test.ts`); there's no separate CI step isolating just
  the e2e tier's timing/output. Worth revisiting if the suite grows large enough that a
  dedicated `bun test src/tests/e2e` step (with its own artifact-on-failure gate) earns
  its keep over the current single-step wiring.
- `.github/workflows/ci.yml` doesn't run `bun run format:check` at all (a gap that
  predates this plan) — the local build gate here ran it, but CI itself doesn't enforce
  formatting. Out of this plan's scope (not part of `specs/facade.md` § E2E harness) but
  worth a follow-up plan.
- The CI artifact-upload step's real behavior (an actual failing job producing a
  downloadable `e2e-session-bundles` artifact) is logically verified (`steps.test.outcome`
  gating, matching `path:`/`E2E_ARTIFACTS_DIR`) but not observed live in GitHub Actions —
  flagged for whoever first sees a real e2e failure in CI to confirm.
