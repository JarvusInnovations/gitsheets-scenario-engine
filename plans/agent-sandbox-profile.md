---
status: done
depends: [session-lifecycle-tooling, demo-world]
specs:
  - specs/facade.md
issues: []
pr: 9
---

# Agent-sandbox profile

## Scope

The same server run for agent development/evaluation rather than app development, adding three conventions: fork-per-agent-run, judgment-by-diff, and replay-based regression evals. This is the "native to 2026" fifth use and a flagship demo angle — forkable, diffable, deterministically replayable world-state for developing and evaluating agents in parallel.

## Implements

- `specs/facade.md` § Agent-sandbox profile

## Approach

1. **Fork-per-run** — a convention/endpoint minting a session per evaluation run; N candidate agents run against identical forks of one scenario.
2. **Judgment by diff** — score a run from its session's tree diff + commit log, compared against a reference session or via evaluator records written to a separate judging sheet (ties to the evaluation-corpus pattern, gitsheets recipe #229).
3. **Regression evals** — reuse the replay harness (session-lifecycle-tooling) to replay a prior run's requests against a new agent/facade version and diff.

## Validation

- [x] N parallel agent runs get isolated forks of one scenario; no cross-run interference
- [x] A run is scored by diffing its session against a reference; evaluator records land in a judging sheet
- [x] Replay-based regression detects a behavior change between two facade versions

## Risks / unknowns

- Overlap with the evaluation-corpus recipe (#229) — keep this the *sandbox/runtime* half, cross-linking rather than duplicating the corpus/schema half.

## Notes

Built as three thin conventions layered over the existing engine, per the approach:

- **Fork-per-run** (`POST /sandbox/runs`) is a batch wrapper around the existing
  `fastify.engine.fork()` — no new fork mechanism. N concurrent `fork()` calls each
  write their own distinct ref via git plumbing (not `sessionTransact`), so parallel
  minting has no shared mutable state to race.
- **Judgment by diff** (`POST /sandbox/judge`, `GET /sandbox/judgments`,
  `src/engine/judging.ts`) diffs a run session's final tree against a reference
  session's (`plumbing.diffTrees`, new) plus compares first-parent commit-log length,
  and persists the verdict in a **new** `judgments` sheet
  (`fixtures/.gitsheets/judgments.toml`). Key design decision: judgment records live on
  their own persistent ref (`refs/judging/records`), never inside either session's own
  tree — judging a run must not pollute the very trees being diffed, and a verdict must
  outlive the (TTL'd/GC'd) sessions it judges. The record id is a deterministic
  composite (`<runSession>--<referenceSession>`), so re-judging a pair upserts rather
  than accumulating duplicates. `judgeRun` requires both sessions share a scenario
  (`ScenarioMismatchError`, 400) — comparing against a reference only makes sense
  against the same starting world state.
- **Regression evals** (`POST /sandbox/regression`) is a direct HTTP wrapper around the
  session-lifecycle-tooling replay harness (`engine/replay.ts` + `replay-fastify.ts`) —
  no new replay logic. Proven against both a clean deterministic replay and the existing
  deliberately-nondeterministic test route (`support/nondeterministic-routes.ts`), which
  now doubles as the "behavior changed between facade versions" stand-in.
- All four `/sandbox/*` routes are registered outside `registerModeRoute` with no
  parity-ledger entry — same documented infra exemption as `/health` and
  `/session/login` (extended in `registry/README.md`): sandbox/runtime tooling, not
  dual-mode facade business routes.
- Cross-linked, not duplicated, against the evaluation-corpus pattern (gitsheets recipe
  #229) per the plan's flagged risk: this plan owns the sandbox/runtime half (minting
  isolated forks, scoring by diff, persisting verdicts); the corpus/schema half (what a
  scenario/rubric record looks like) stays that recipe's to define.
- A pinned reference session surviving a TTL sweep that reclaims its unpinned candidate
  runs is exercised directly in `src/tests/sandbox.test.ts`, tying fork-per-run +
  judgment-by-diff to the existing session-gc pin/unpin mechanism (no new GC code was
  needed).

## Follow-ups

- No HTTP route wraps `fastify.sessionGc.pin`/`unpin` — a harness pins a reference
  session by calling the plugin API directly (as the test suite does) or would need one
  added if sandbox tooling moves outside the same process.
- `judgeRun`'s diff is whole-tree (every sheet). A rubric that only cares about specific
  sheets/paths (e.g. ignore `clock` ticks, compare only `orders/`) would need a
  path-filtered variant — left for whenever the evaluation-corpus recipe's schema half
  defines what a rubric actually constrains.
