# Specs

The **desired state** of the scenario-engine template. Specs lead; the [`plans/`](../plans/)
DAG brings code into conformance.

- [`scenario-engine.md`](scenario-engine.md) — scenarios, sessions, the runtime store and ref
  layout, session lifecycle, request=commit format, determinism/replay, concurrency, and the
  gitsheets 2.x mapping.
- [`facade.md`](facade.md) — the dual-mode API facade: the offline/online seam, the parity
  model, git exposure, the E2E harness, fixtures-as-shippable-data, and the agent-sandbox profile.

Both specs are trued up against shipped gitsheets 2.4.x; every gitsheets primitive they lean on
(`transact` with `parent`/`branch`, commit-time freshness, `withLock`, canonical serialization,
indexing) is published and cold-verified. Umbrella tracker:
[gitsheets#231](https://github.com/JarvusInnovations/gitsheets/issues/231).
