---
status: planned
depends: [engine-plugin]
specs:
  - specs/scenario-engine.md
issues: []
---

# Session lifecycle tooling: GC sweep + replay harness

## Scope

The operational tooling around sessions: the TTL sweep that expires and reclaims stale session refs (with pinned-session retention), and the deterministic replay harness that re-executes a session's request log against a fresh fork and diffs the resulting trees — the mechanism behind cross-version regression and agent evaluation.

## Implements

- `specs/scenario-engine.md` § Session lifecycle (Expire/GC), § Determinism and replay

## Approach

1. **GC sweep** — a periodic task deleting `refs/sessions/*` whose last commit is older than the TTL, skipping any with a `refs/tags/sessions/<key>/pinned` retention tag; rely on normal `git gc` to reclaim unreachable history. Configurable interval + TTL.
2. **Replay harness** — given a session ref, parse the ordered request log from commit messages, re-execute it against a fresh fork of the same baseline, and diff the resulting trees. Byte-identical ⇒ deterministic; divergence ⇒ a behavior change (doubles as a regression test between facade versions).
3. **Determinism guards** — assert no wall-clock/randomness leaks into record content (simulated time is a record; ids are derived sequences); document the one sanctioned clock/random use — session keys, which name refs and never enter trees.

## Validation

- [ ] Expired unpinned sessions are swept; pinned sessions survive; disk reclaims after `git gc`
- [ ] Replay of a recorded session reproduces byte-identical trees on a fresh fork
- [ ] An injected non-determinism (e.g. a clock leak into a record) is caught by the replay diff

## Risks / unknowns

- Request-log parsing fidelity from commit messages — the message format must round-trip the request exactly, or replay drifts; may motivate a structured payload convention alongside the human-readable message.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
