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

Stand up the buildable skeleton every later plan lands into: a TypeScript-on-**Bun** Fastify 5.x project per the vendored [`jarvus-fastify`](../.claude/skills/jarvus-fastify/SKILL.md) skill, a pinned gitsheets 2.4.x dependency, the `fixtures/` trunk layout the specs prescribe, and a CI skeleton that runs typecheck + lint + tests. No engine logic yet — just the frame and its conventions.

## Implements

- `specs/facade.md` § Stack (Fastify 5.x, Node ≥ 20 — prescribed)
- `specs/scenario-engine.md` § Concepts (the `fixtures/.gitsheets/`, `fixtures/base/`, `fixtures/scenarios/<name>/` trunk layout)

## Approach

1. Follow `jarvus-fastify` § setup-guide: `asdf set bun latest` (writes `.tool-versions`), `bun init`, `package.json` scripts (`dev: bun --watch`, `test: bun test`, `typecheck: tsc --noEmit` — no build step; Bun runs the TS source), TypeScript strict, `@types/bun`. Add `fastify` 5.x + the house plugins (`fastify-plugin`, `@fastify/env`, `@fastify/cors`, `pino-pretty`) via `bun add`, and `gitsheets` (pin the 2.4.x line — the published npm package). **Smoke the one real risk early: `import { openRepo } from 'gitsheets'` under Bun and confirm the napi native binding loads** (Bun must resolve the platform prebuild via the package's `optionalDependencies`); if it doesn't, record the workaround here before proceeding.
2. Create the `fixtures/` skeleton: a placeholder `.gitsheets/`, `base/`, and one empty `scenarios/<name>/`, with a README explaining the overlay-and-embed rule (base underlaid beneath scenario overlay; `.gitsheets/` embedded into each baseline).
3. `src/` entrypoint booting a bare Fastify instance with a health route — the seam the engine plugin registers into.
4. CI (GitHub Actions): checkout + `oven-sh/setup-bun`, `bun install --frozen-lockfile`, typecheck, lint, `bun test` — Bun-only, no services. The harness later plans extend.

## Validation

- [ ] `bun install && bun run typecheck && bun test` green on a clean checkout with the pinned Bun
- [ ] `import` of `gitsheets` under Bun loads the napi native binding (platform prebuild resolves)
- [ ] Fastify boots and serves the health route; `fastify.inject()` reaches it
- [ ] `fixtures/` layout present and documented; CI green

## Risks / unknowns

- **gitsheets napi under Bun** — the package selects a platform-specific prebuilt `.node` via `optionalDependencies`; Bun's resolution of that pattern is the load-bearing unknown for the whole template. Smoke it in step 1 before anything else; if Bun mis-resolves it, capture the fix (or, worst case, escalate the npm-vs-bun toolchain choice) here rather than papering over it.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
