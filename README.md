# gitsheets-scenario-engine

*Working title — template repo in specification stage.*

A template for building a **scenario simulation backend**: a dual-mode API facade where git is the world-state engine. In offline mode the facade serves and mutates schema-validated [gitsheets](https://github.com/JarvusInnovations/gitsheets) records; in online mode it proxies to real upstream APIs. Each login forks an isolated **scenario** onto a per-session branch, and every API request becomes a commit that logs the request/response alongside the record mutations it caused.

The pattern is production-proven at enterprise scale (a nationwide delivery platform's driver app, 2020–22), where it carried four load-bearing uses:

1. **Infrastructure-free E2E testing** — CI runs full end-to-end suites against scenarios with zero online infrastructure.
2. **Contract-first parallel development** — frontend teams sprint ahead by defining desired behavior as scenarios; backend teams build to those scenarios as an executable spec; the facade mediates gradual convergence to parity.
3. **Training environments** — operational users log into scenarios on the online instance for risk-free onboarding.
4. **Time-travel debugging** — a misbehaving session is a clonable git ref interleaving requests, responses, and state changes in one graph. You can `git clone` the running server's state.

A fifth use is native to 2026: the same primitive is an **agent sandbox** — forkable, diffable, deterministically replayable world-state for developing and evaluating agents in parallel.

## Status

Specs first (see [`specs/`](specs/)); implementation follows once the spec is settled. The original implementation hand-rolled its git plumbing on a legacy API; gitsheets 2.x (`transact`, CAS ref updates, schema validation, canonical serialization) has since absorbed most of that, so this template is mostly **conventions and middleware**, not engine work. Tracked publicly at JarvusInnovations/gitsheets#231.

## Spec index

- [`specs/scenario-engine.md`](specs/scenario-engine.md) — scenarios, sessions, ref layout, request=commit format, lifecycle
- [`specs/facade.md`](specs/facade.md) — the dual-mode seam, parity model, git exposure, E2E harness
