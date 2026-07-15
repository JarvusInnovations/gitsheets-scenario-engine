---
status: done
depends: [engine-plugin]
specs:
  - specs/scenario-engine.md
issues: []
pr: 6
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

- [x] Expired unpinned sessions are swept; pinned sessions survive; disk reclaims after `git gc`
- [x] Replay of a recorded session reproduces byte-identical trees on a fresh fork
- [x] An injected non-determinism (e.g. a clock leak into a record) is caught by the replay diff

## Risks / unknowns

- Request-log parsing fidelity from commit messages — the message format must round-trip the request exactly, or replay drifts; may motivate a structured payload convention alongside the human-readable message.

## Notes

- **"Last commit" for TTL can't be the tip commit's own committer date.** Fork/boot
  commits pin their author/committer date to a fixed epoch (`session.ts
  FORK_IDENTITY_DATE`, `boot-import.ts BASELINE_IDENTITY`) so `resetSession()` can
  reproduce a byte-identical commit hash — a freshly-forked, unused session's tip
  commit therefore always carries a 1970-01-01 date. Fixed by enabling
  `core.logAllRefUpdates=always` on the bare runtime repo (bare repos default reflogs
  OFF) and reading the ref's reflog instead: a reflog entry is stamped with the real
  wall-clock time of that specific `update-ref` invocation, independent of any
  `GIT_COMMITTER_DATE` override baked into the commit object it points at — verified
  empirically before relying on it (see `plumbing.ts` `ensureBareRepo`/`refLastUpdatedAt`
  doc comments).
- **Request-log parsing fidelity (the plan's flagged risk) resolved cleanly**: the
  request=commit message format built by `request-commit.ts` (subject line + fenced
  ` ```json ` `Request:`/`Response:` blocks + trailers) round-trips exactly for replay.
  The trailer block is always the message's last paragraph, so it's never mistaken for
  JSON content and vice versa. No structured machine-readable payload convention beyond
  the existing fences was needed — the spec did not need amending.
- The replay harness (`engine/replay.ts`) is deliberately Fastify-agnostic: it parses
  and diffs, but delegates actually *executing* a parsed request to a caller-supplied
  `executeStep`. `engine/replay-fastify.ts` supplies the `fastify.inject()`-based
  executor this app uses. This keeps the door open for driving replay against a
  differently-hosted facade (e.g. true cross-version regression) without the core
  module knowing about HTTP at all.
- The GC sweep never touches objects, only refs — reclaiming a swept session's now-
  unreachable commits/trees/blobs is normal `git gc`'s job, on whatever cadence the
  deployment configures (tested explicitly with `git gc --prune=now`, not exercised as
  an automatic cadence here).

## Follow-ups

- **EVENT-commit replay has no re-invocation path.** `parseSessionLog` parses `EVENT
  <name>` commits (non-request mutations) into event steps, but `replaySession` throws
  `UnsupportedReplayStepError` if one is actually encountered — there's no registry
  mapping an event name back to the code that produced it in this build (no route
  currently emits an EVENT commit via `runEventCommit` outside tests). Deferred:
  building simulated background events (timers advancing order state, etc.) is out of
  this plan's scope; whichever plan introduces the first real event producer should
  also decide how replay re-invokes it (a name→handler registry is the likely shape).
- **Cross-session GC load at scale is unmeasured.** `specs/scenario-engine.md` § gitsheets
  2.x mapping already flags "Ephemeral-ref GC cost at thousands of live sessions" as a
  benchmark, not a gap, left for the template to tune — this plan ships the sweep
  mechanism but doesn't load-test it against thousands of session refs or measure
  `for-each-ref`/reflog-read cost at that scale.
