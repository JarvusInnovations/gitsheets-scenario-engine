---
status: planned
depends: []
specs:
  - specs/facade.md
  - specs/scenario-engine.md
issues: []
---

# Repo scaffold: Fastify project + fixtures layout

## Scope

Stand up the buildable skeleton every later plan lands into: a TypeScript/ESM Node project (Node ≥ 20), Fastify 5.x, a pinned gitsheets 2.4.x dependency, the `fixtures/` trunk layout the specs prescribe, and a CI skeleton that runs lint + typecheck + tests. No engine logic yet — just the frame and its conventions.

## Implements

- `specs/facade.md` § Stack (Fastify 5.x, Node ≥ 20 — prescribed)
- `specs/scenario-engine.md` § Concepts (the `fixtures/.gitsheets/`, `fixtures/base/`, `fixtures/scenarios/<name>/` trunk layout)

## Approach

1. `package.json` (ESM, `"type": "module"`), TypeScript strict, a build/test/lint toolchain matching gitsheets' house style; add `fastify` 5.x and `gitsheets` (pin the 2.4.x line — the published npm package, no Rust toolchain needed by consumers).
2. Create the `fixtures/` skeleton: a placeholder `.gitsheets/`, `base/`, and one empty `scenarios/<name>/`, with a README explaining the overlay-and-embed rule (base underlaid beneath scenario overlay; `.gitsheets/` embedded into each baseline).
3. `src/` entrypoint booting a bare Fastify instance with a health route — the seam the engine plugin registers into.
4. CI (GitHub Actions): checkout + node, `npm ci`, typecheck, lint, test — node-only, no services. The harness later plans extend.

## Validation

- [ ] `npm ci && npm run build && npm test` green on a clean checkout under node ≥ 20
- [ ] Fastify boots and serves the health route; `fastify.inject()` reaches it
- [ ] `fixtures/` layout present and documented; CI green

## Risks / unknowns

- gitsheets ESM/TS consumption ergonomics from a fresh project (types, module resolution) — smoke early; it doubles as a real-world test of the published package as a dependency.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
