# Spec: Scenario engine

## Concepts

- **World** — the domain data model, declared as gitsheets sheets (`.gitsheets/<sheet>.toml` with JSON Schemas). All simulated state is records; no state lives outside the repository.
- **Scenario** — a named, curated base world-state (e.g. `standard-day`, `age-gated-order`, `multi-stop-route`). A scenario is fixture records in the application's **source tree**, versioned with the code: `fixtures/.gitsheets/` (sheet configs), `fixtures/base/` (records every scenario shares), and `fixtures/scenarios/<name>/` (per-scenario overlay records that win over base on conflict). Fixtures living in trunk — not on a side branch — is deliberate: a PR that changes an endpoint's behavior changes its fixtures and its tests **in the same commit**, so scenarios can never drift out of sync with the code version they describe.
- **Session** — a mutable fork of a scenario, created at login, living on its own ref. Sessions evolve commit-by-commit as the client exercises the API. Sessions are cheap, disposable, and isolated from each other.

## Runtime store and ref layout

The engine owns a **runtime repository** (bare, at a configured var path) that holds baselines and sessions. The fixture *source of truth* is the application source tree; the runtime store is derived state, disposable and rebuildable.

```
refs/fixtures/baseline/<scenario>      # per-scenario baseline, imported at boot (derived, deterministic)
refs/sessions/<session-key>            # one per live session (NOT refs/heads/ — see below)
```

- **Boot import**: at startup the engine imports the fixtures from the running code's tree — for each scenario, `fixtures/base/` underlaid beneath `fixtures/scenarios/<name>/`, with the `fixtures/.gitsheets/` sheet definitions **embedded into the baseline tree itself** (each session thereby carries its own schema, so a session stays valid and replayable even after trunk's schemas evolve) — into the runtime store as one baseline commit per scenario, parented on the imported application commit (the build ships a depth-1 bundle of the app commit so it exists as a parent object). gitsheets' canonical serialization makes the import deterministic: the same fixture files always produce the same baseline tree hash, so re-boots are no-ops and two replicas of the same build agree byte-for-byte.
- `<session-key>` is an **opaque generated value** (e.g. base36 timestamp + process counter + random suffix — the production-proven format): collision-free by construction, so parallel sessions per user are inherent and no create-time coordination is needed. The authenticated principal is recorded in the session's commits (author identity and/or trailer), never encoded in the key. Keys are returned to the client at login and presented on subsequent requests.
- Sessions live outside `refs/heads/` so ordinary branch listings and clones stay clean; the git exposure layer (see facade spec) advertises them explicitly.

## Session lifecycle

1. **Fork (login)** — resolve the scenario named in the login request, then create the session in the production-proven two-commit shape:
   - a **root commit of the empty tree with no parents** (`initialize session <key>`) — the session's own root, unique to it;
   - a **merge commit** carrying the scenario baseline's tree, with parents **`[sessionRoot, scenarioBaseline]`** and a `Scenario-name:` trailer (plus an application-version trailer).
   Point `refs/sessions/<key>` at the merge commit. This shape is load-bearing, not cosmetic: `git log --first-parent` yields **pure session history** from the session's own root (trunk history never pollutes a session walk), while the second-parent edge makes provenance a real DAG edge — graph viewers render "session forked from fixture state X," `merge-base` works between any session and trunk, and fetching a session ref brings its source lineage along. The trailer makes every session **self-describing from its ref alone**: the engine recovers scenario identity by reading trailers from the log, never from side state.
2. **Evolve (each request)** — see *Request=commit* below.
3. **Reset** — delete and re-fork the ref. Resetting is always cheap; nothing else references session refs.
4. **Expire/GC** — sessions are leases: a TTL since last commit, enforced by a sweep that deletes expired refs. Deleted session history becomes unreachable and is reclaimed by normal git GC. Retention overrides (e.g. keep a session pinned for debugging) are a tag: `refs/tags/sessions/<key>/pinned`.

## Request = commit

Every mutating API request handled in offline mode executes as **one gitsheets transaction** producing **one commit** on the session ref:

- **Tree**: the record mutations the request caused (upserts/deletes across any sheets), schema-validated.
- **Message**: first line `<METHOD> <path>` (e.g. `POST /orders/1234/accept`); body carries the JSON request and response payloads, fenced and labeled.
- **Trailers** (machine-readable; the debugging and analysis surface):
  - `Session:` session key
  - `Scenario:` scenario name at fork
  - `Request-id:` correlation id
  - `Response-code:` HTTP status
  - `User-agent:`, `Host:` as available
- **Author/committer**: the authenticated principal as author (pseudonymized per deployment policy); the engine as committer. `git blame` on any record answers "which request changed this."

Read-only requests do not commit by default; a deployment may opt into logging reads as empty-tree-delta commits when full interaction capture matters (e.g. training review), accepting the history volume.

**Non-request mutations** (simulated background events — e.g. a timer advancing an order's state) commit with a synthetic message (`EVENT <name>`) and the same trailer discipline, so the graph remains a complete causal log.

## Determinism and replay

- A session's history is a deterministic function of (fixture content at the running application version, ordered request/event log). Replaying the same requests against the same baseline must reproduce byte-identical trees — this is what makes sessions diffable across code versions and usable for agent evaluation.
- Consequences: no wall-clock or randomness may leak into record content from the engine itself; simulated time is a record (a `clock` sheet or scenario field) advanced by requests/events; any id generation is derived (sequence records), not random.
- **Session keys are the one sanctioned use of clock/randomness**: a key names a ref, it never enters record content or trees, and replay compares trees, not ref names — so key generation cannot affect determinism.
- **Replay harness**: given a session ref, re-execute its request log (parsed from commit messages) against a fresh fork and diff the resulting trees. Divergence = behavior change; this doubles as a regression test between facade versions.

## Concurrency

- One session = one writer at a time: requests within a session serialize (per-session queue); the CAS ref update is the backstop, and a lost race is a bug, not a retry loop.
- Cross-session concurrency is unlimited — sessions share nothing but ancestry.

## gitsheets 2.x mapping and open questions

Maps directly: `repo.transact` (one per request), CAS `updateRef`, schema validation, canonical serialization (idempotent event replay), bare-repo operation, `Sheet.defineIndex` for the facade's lookups.

To validate against the current core (candidate upstream issues if they don't hold):

- **Per-request transaction latency** at interactive budgets (target: single-digit ms on session-scale trees; the Rust core's measured ~25ms single-upsert on an 18k-record tree suggests comfortable headroom at typical scenario scale).
- **Ref namespace ergonomics** — transactions targeting `refs/sessions/*` rather than branches.
- **Post-commit read freshness** within a session (per-sheet refresh; gitsheets#184).
- **Ephemeral-ref GC** — nothing needed from gitsheets, but the template must ship the sweep.
