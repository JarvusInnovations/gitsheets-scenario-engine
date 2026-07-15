---
status: planned
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

- [ ] Registry↔routes drift fails boot
- [ ] An `offline-only` route serves engine behavior and commits; an `online-only` route proxies and does not commit; a `dual` route selects per deployment/session
- [ ] The same response schema validates both an offline and an online response for a `dual` route
- [ ] The parity ledger is a real, queryable gitsheet

## Risks / unknowns

- Per-session mode override interacting with the session handle from engine-plugin — keep mode a property of the resolved session.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
