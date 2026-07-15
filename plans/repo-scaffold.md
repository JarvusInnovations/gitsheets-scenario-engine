---
status: done
depends: []
specs:
  - specs/facade.md
  - specs/scenario-engine.md
issues: []
pr: 3
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

- [x] `bun install && bun run typecheck && bun test` green on a clean checkout with the pinned Bun (also ran `bun run lint`; all clean — see Notes)
- [x] `import` of `gitsheets` under Bun loads the napi native binding (platform prebuild resolves)
- [x] Fastify boots and serves the health route; `fastify.inject()` reaches it (also verified with a real `bun run start` + `curl`, not just inject)
- [x] `fixtures/` layout present and documented; CI green (confirmed on PR #3's first Actions run, after this line was originally written pre-CI-run — see Notes)

## Risks / unknowns

- **gitsheets napi under Bun** — the package selects a platform-specific prebuilt `.node` via `optionalDependencies`; Bun's resolution of that pattern is the load-bearing unknown for the whole template. Smoke it in step 1 before anything else; if Bun mis-resolves it, capture the fix (or, worst case, escalate the npm-vs-bun toolchain choice) here rather than papering over it.

## Notes

- **gitsheets napi under Bun — confirmed working, no workaround needed.** A throwaway
  script (`import { openRepo } from 'gitsheets'; await openRepo({ gitDir })` against a
  fresh bare repo) ran clean under `bun run` with `bun.lock`-installed dependencies.
  `bun add` correctly resolved gitsheets' transitive `@gitsheets/core-napi`
  `optionalDependencies` down to the platform prebuild
  (`@gitsheets/core-napi-linux-x64-gnu@0.3.0` on this Linux x64 box — confirmed present
  under `node_modules/@gitsheets/`), and `openRepo()` returned a live `Repository`
  handle. No Bun-specific resolution quirks observed. gitsheets is pinned `~2.4.0` (the
  2.4.x line; 2.4.0 is current).
- All four gate commands are clean on a from-scratch `node_modules` (`rm -rf
  node_modules && bun install`): `bun run typecheck`, `bun run lint` (oxlint, exit 0),
  `bun test` (1 pass), and `bun run format:check` (oxfmt, added as a fifth script beyond
  the plan's ask since the jarvus-fastify skill's CI section prescribes oxlint+oxfmt as
  the house linter/formatter pair — used that instead of falling back to `tsc --noEmit`
  as `lint`).
- Verified the health route two ways: `fastify.inject()` in `src/tests/health.test.ts`
  (the committed regression test) and a real `bun run start` + `curl
  http://localhost:3001/health` → `200 {"status":"ok",...}`, confirmed via server log
  output before shutting the process down.
- `GET /health` is registered at the bare path (no `/api` prefix), per this plan's own
  task framing ("a `GET /health` route") rather than the setup-guide's `/api/health`
  example — a deliberate deviation the orchestrator should confirm reads correctly; the
  route-registry plan (`plans/dual-mode-routing.md`) is free to introduce a prefix
  scheme later without this being load-bearing.
- `app.ts` intentionally omits the setup-guide's custom request/response logging hooks
  (the ones that skip logging `/api/health`) — kept the scaffold minimal per this plan's
  brief. Consequence: Fastify's built-in request logger currently logs every `/health`
  hit at `info`. Flagged as a follow-up, not fixed here, since no health-check prober
  exists yet to make the noise concrete.
- `typescript` landed in `package.json` under `peerDependencies` (bun init's placement,
  not `devDependencies`) even after `bun add -d typescript`; functionally fine —
  `tsc` installs and `bun run typecheck` works — but worth knowing this is a Bun
  convention, not a mistake, if it looks odd on review.
- CI workflow (`.github/workflows/ci.yml`) was authored against the current
  `oven-sh/setup-bun` README (pinned `@v2`, `bun-version-file: .tool-versions`) and
  runs the exact same four commands verified locally. Opening PR #3 triggered the first
  Actions run against this branch, which passed (`test: pass`) — confirmed and checked
  off above in a follow-up commit to this closeout.

## Follow-ups

- Consider re-adding the setup-guide's health-check-skipping logging hooks once a real
  health-check prober (k8s liveness, uptime monitor, etc.) exists and the log noise is
  worth suppressing.
- The `fixtures/.gitsheets/example.toml` sheet config is a placeholder; `demo-world`
  (plans/demo-world.md) replaces it with the real world model.
