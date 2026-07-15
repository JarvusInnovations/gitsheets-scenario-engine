# registry/

The **route parity ledger** — a reviewable gitsheet tracking every dual-mode-facade
route's status (`offline-only` | `online-only` | `dual`) with links to the scenario
behaviors that define it. See
[`specs/facade.md`](../specs/facade.md) § Mode model:

> The parity ledger is the registry itself — a reviewable file (a gitsheet, naturally)
> tracking each route's status with links to the scenario behaviors that define it.
> "Backend caught up" = a PR flipping `offline-only` → `dual`, reviewed against the
> scenario's recorded request/response pairs.

## Layout

```
registry/
├── .gitsheets/routes.toml   # sheet config (schema) for ledger entries
└── routes/                  # one record per registered route: <id>.toml
```

Each record's `mode` must match that route's `config.mode` in code (declared via
[`registerModeRoute`](../src/routing/register-route.ts)) — a boot-time check
(`src/plugins/routing.ts`, backed by `src/routing/validate-registry.ts`) fails startup
if the two diverge. Routes outside the dual-mode facade (e.g. `/health`) don't declare
`config.mode` and are ignored by this check.

## Why it's a gitsheet, and how it's read

Like `fixtures/`, this ledger is versioned in the application source tree so a PR that
changes a route's mode changes its ledger entry in the same commit. At boot,
`src/routing/registry-import.ts` imports this tree into the runtime store as one
deterministic commit (`refs/registry/routes`), mirroring `engine/boot-import.ts`'s
fixture import; `src/routing/registry-store.ts` reads it back through the engine's
*existing* shared gitsheets `Repository` instance (never a second one against the same
gitDir — see `runtime-store.ts`'s module comment on why that races).

`plans/demo-world.md` populates `routes/` with the demo world's six entries
(`src/routes/orders.ts`, `src/routes/couriers.ts`) — one `dual`, four `offline-only`
(three of them the order state machine's transitions), one `online-only`. `POST
/session/login` (`src/routes/session.ts`) has no entry here deliberately — see that
file's module comment for why login sits outside the dual-mode facade, same as
`/health`. The agent-sandbox profile's `/sandbox/*` routes (`src/routes/sandbox.ts`:
fork-per-run, judgment-by-diff, replay-based regression — see `specs/facade.md` §
Agent-sandbox profile) extend the same exemption for the same reason: sandbox/runtime
infrastructure for evaluating agents against the engine, not dual-mode business routes.

Tests that exercise the drift mechanism in isolation from the real demo world still
scaffold their own scratch registry (`scaffoldRegistry()` in `src/tests/helpers.ts`,
the same pattern `fixtures/README.md` documents for `scaffoldFixtures()`) — but because
`app.ts` always registers the demo world's routes too, any such test's scaffolded
ledger must include matching entries for them as well (see the `DEMO_LEDGER` constant
in `src/tests/routing.test.ts`) or the boot-time drift check correctly flags the gap.
`src/tests/demo-world.test.ts` instead boots against the real `registry/` and
`fixtures/` trees, proving the shipped ledger and the shipped routes actually agree.
