---
status: planned
depends: [demo-world]
specs:
  - specs/facade.md
issues: []
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

- [ ] E2E suite passes against the demo world in CI (node + checkout only)
- [ ] Parallel workers with per-session isolation, no cross-test cleanup beyond ref deletion
- [ ] Assertions cover both HTTP and commit/record surfaces; the smoke tier passes over a real socket
- [ ] A failing test's session bundles as an inspectable artifact

## Risks / unknowns

- Balancing `inject` speed against the over-the-wire tier's coverage — keep the smoke tier thin but real.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
