# fixtures/

The application's **source tree** copy of every scenario's fixture records — versioned with
the code, not on a side branch. This is deliberate: a PR that changes an endpoint's behavior
changes its fixtures and its tests **in the same commit**, so scenarios can never drift out of
sync with the code version they describe. See
[`specs/scenario-engine.md`](../specs/scenario-engine.md) § Concepts.

## Layout

```
fixtures/
├── .gitsheets/           # sheet configs (schemas) shared by every scenario
├── base/                 # records every scenario shares
└── scenarios/
    └── <name>/           # per-scenario overlay records — win over base on conflict
```

Quoting the spec directly:

> A scenario is fixture records in the application's **source tree**, versioned with the
> code: `fixtures/.gitsheets/` (sheet configs), `fixtures/base/` (records every scenario
> shares), and `fixtures/scenarios/<name>/` (per-scenario overlay records that win over base
> on conflict).

## The overlay-and-embed rule

At boot, the engine builds one baseline commit per scenario by:

1. **Underlaying** `fixtures/base/` beneath `fixtures/scenarios/<name>/` — base records provide
   the shared floor; a scenario's own records at the same path win on conflict.
2. **Embedding** `fixtures/.gitsheets/` into the resulting baseline tree itself, rather than
   leaving schemas as an external reference — so each session carries its own schema copy and
   stays valid and replayable even after trunk's schemas evolve later.

Import is deterministic (gitsheets' canonical serialization): the same fixture files always
produce the same baseline tree hash, so re-boots are no-ops and two replicas of the same build
agree byte-for-byte. See `specs/scenario-engine.md` § Runtime store and ref layout for the full
boot-import and ref-layout description — the engine plugin (`plans/engine-plugin.md`) is what
actually performs this import.

`scenarios/standard-day/` ships empty (`.gitkeep` only) as the first scenario placeholder; the
demo-world plan (`plans/demo-world.md`) populates it.
