---
status: planned
depends: [session-lifecycle-tooling, demo-world]
specs:
  - specs/facade.md
issues: []
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

- [ ] N parallel agent runs get isolated forks of one scenario; no cross-run interference
- [ ] A run is scored by diffing its session against a reference; evaluator records land in a judging sheet
- [ ] Replay-based regression detects a behavior change between two facade versions

## Risks / unknowns

- Overlap with the evaluation-corpus recipe (#229) — keep this the *sandbox/runtime* half, cross-linking rather than duplicating the corpus/schema half.

## Notes

*(populated at closeout)*

## Follow-ups

*(populated at closeout)*
