---
status: planned
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

- [ ] Booting the demo imports both scenarios deterministically
- [ ] The state-machine flow produces the expected sequence of commits and terminal record state
- [ ] No state lives outside records — a clone + replay of a demo session reproduces it exactly

## Risks / unknowns

- Keeping the domain generic enough to publish (no client identifiers) while rich enough to be convincing.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
