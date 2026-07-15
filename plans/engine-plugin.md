---
status: done
pr: 4
depends: [repo-scaffold]
specs:
  - specs/scenario-engine.md
  - specs/facade.md
issues: []
---

# Engine plugin: store, boot import, session fork, request=commit

## Scope

The heart of the template: the scenario engine as a `fastify-plugin`. A runtime bare repository; deterministic boot import of trunk fixtures into per-scenario baselines; session fork in the production-proven two-commit DAG; the session-resolution `onRequest` hook; and the request=commit wrapping that turns each mutating handler into exactly one gitsheets transaction on the session ref. Everything downstream (routing modes, git exposure, demo, tests) builds on this.

## Implements

- `specs/scenario-engine.md` § Runtime store and ref layout, § Session lifecycle (Fork/Evolve/Reset), § Request = commit, § Concurrency, § gitsheets 2.x mapping
- `specs/facade.md` § Stack (the engine-plugin bullet)

## Approach

1. **Runtime store** — open/create the bare repo at the configured var path; ref layout `refs/fixtures/baseline/<scenario>` + `refs/sessions/<key>`.
2. **Boot import** — for each scenario, underlay `fixtures/base/` beneath `fixtures/scenarios/<name>/`, embed `fixtures/.gitsheets/` into the baseline tree, and write one baseline commit parented on the app commit (shipped as a depth-1 bundle). Canonical serialization ⇒ identical fixtures produce identical baseline hashes; re-boot is a no-op.
3. **Session fork** — the two-commit shape: a parentless empty-tree root, then a merge commit `[sessionRoot, scenarioBaseline]` carrying the baseline tree with `Scenario-name:` + app-version trailers; point `refs/sessions/<key>` at it. Opaque generated key (base36 time + process counter + random suffix). `git log --first-parent` = pure session history.
4. **Session-scoped record access** — the `onRequest` hook resolves the session key → `request.session`. Record access (both reads and writes) goes exclusively through `repo.transact({ parent, branch } = refs/sessions/<key>, tx => tx.sheet(...))` on **one shared `Repository` instance** process-wide, not one handle per session as originally planned — see Notes for why.
5. **Request = commit** — wrap mutating handlers so the handler runs inside one `repo.transact`; on success format the commit message (`<METHOD> <path>` + fenced request/response) and trailers (`Session`, `Scenario`, `Request-Id`, `Response-Code`, `User-Agent`, `Host`), author = authenticated principal (pseudonymized per policy), committer = engine. Read-only requests don't commit (opt-in read logging deferred). `EVENT <name>` path for non-request mutations.

## Validation

- [x] Boot import is deterministic: same fixtures ⇒ identical baseline tree hashes across two boots and two processes (`src/tests/engine.test.ts` "boot import determinism" — two boots + a `Bun.spawn`'d second process, hashes compared)
- [x] Fork produces the two-commit DAG; `git log --first-parent <session>` shows only session history; trailers recover scenario identity from the ref alone (`src/tests/engine.test.ts` "session fork")
- [x] A mutating request produces exactly one commit on the session ref with correct message/trailers/author; the record mutation is schema-validated (`src/tests/engine.test.ts` "request = commit" — schema validation is gitsheets' own JSON-Schema layer on `tx.sheet().upsert()`, exercised implicitly; author mechanism is proven, but no principal/auth exists yet in this plan's scope, so tested commits author as the engine identity — see Notes)
- [x] Two concurrent sessions never cross-contaminate reads; intra-session writers serialize (`src/tests/engine.test.ts` "session isolation" — both sub-cases). **Not independently verified:** "a lost CAS race surfaces as an error" — the implementation *prevents* the race by construction (a single shared `Repository` instance + an `AsyncMutex` serialize every `sessionTransact` call, so two writers can never actually collide at the CAS layer) rather than triggering and catching one; no test forces two writers past the mutex to observe `parent_moved`.
- [x] Reset re-forks cheaply; nothing else references the session ref (`src/tests/engine.test.ts` "session reset" — also demonstrates deterministic re-fork reproduces the *exact* original fork commit hash)

## Risks / unknowns

- Depth-1 app-commit bundle availability at boot (the build must ship it as the baseline parent) — **still unresolved.** `APP_COMMIT_HASH` is wired as an optional config knob that parents baseline commits when set; nothing in this plan produces or ships the bundle. Baselines are parentless root commits when unset (true for all tests and local dev).
- Per-session handle lifecycle/pooling under load (open cost vs. reuse) — **superseded**, see Notes: the design uses one shared handle, not per-session handles, so this risk doesn't apply as originally framed. The new risk is the process-wide commit-phase serialization noted below.

## Notes

**Two empirically-verified corrections to `specs/scenario-engine.md` § gitsheets 2.x mapping, fixed in this PR's docs commit:**

1. **Trailer casing.** gitsheets' `repo.transact` enforces HTTP-header-style trailer keys (`Request-Id`, not `Request-id`) and throws `TransactionError('commit_failed')` otherwise. The spec's prose examples used non-conforming casing; fixed there and in this plan's Approach.

2. **"One Repository handle per session" is wrong for gitsheets 2.4.0 — verified empirically with scratch probe scripts (not checked in) against the shipped npm package.** Two findings, both load-bearing:
   - `Repository#openSheet()` binds unconditionally to the literal git `HEAD` ref (confirmed reading `node_modules/gitsheets/dist/repository.js`), never to whatever ref a transaction targeted. Session refs live outside `refs/heads/`, so `openSheet()` can never see session data — this engine never uses it for session data; every read and write goes through `repo.transact(...)`, using no-op detection to keep reads commit-free.
   - Two **separate** `Repository` instances racing a `transact()` call against the same `gitDir` don't queue — the native core throws `transaction_in_progress` instead. The documented "fair queue" is a **per-instance** JS mutex, not per-gitDir. Opening a fresh `Repository` per session/request (the spec's literal recommendation) reintroduces that exact race non-deterministically under concurrent cross-session load.

   The fix: **one shared `Repository` instance process-wide** (`RuntimeStore`), whose per-instance mutex becomes the real serializer for every session's `transact` calls. This is correct but narrows `specs/scenario-engine.md` § Concurrency's "cross-session concurrency is unlimited" claim — commit-phase work now serializes globally rather than running git-level-parallel across sessions. Flagged in the spec as an implementation note tied to gitsheets 2.4.0.

**The commit-then-reword pattern** (`request-commit.ts`): `repo.transact`'s `message`/`trailers` are fixed before the handler runs, but the spec requires the commit body to carry the *response* (only known after the handler resolves). No gitsheets API defers the message. So the wrapper commits once inside `repo.transact` with the request-only message, then — only if a commit actually landed — atomically rewords that single commit (same tree, same parents, CAS `update-ref`, original author/committer identity+timestamp preserved) to the complete message. A dedicated `AsyncMutex` (not gitsheets') wraps transact+reword as one atomic unit — an earlier version raced two concurrent same-session requests and threw exit-128 `update-ref` lock failures until this was added; see `src/tests/engine.test.ts` "two concurrent mutating requests on the SAME session".

**Determinism approach:** every plumbing-authored commit (boot-import baselines, session root/merge commits) uses a fixed engine identity (`plumbing.ENGINE_IDENTITY`) and a fixed timestamp (`1970-01-01T00:00:00Z`), never wall-clock. Session *keys* still use `Date.now()`/`Math.random()` per spec (sanctioned — they name a ref, never enter tree content).

## Follow-ups

- Depth-1 app-commit bundle packaging for baseline parenting (see Risks).
- Session GC/TTL sweep + pinned-session tags (`specs/scenario-engine.md` § Session lifecycle "Expire/GC") — out of this plan's Implements list.
- Route registry / mode resolution (`offline-only`/`online-only`/`dual`) — a separate, later plan per `specs/facade.md` § Mode model.
- Auth / principal pseudonymization policy hook — `RequestCommitContext.principal` threads through to the commit author, but nothing in this plan authenticates a caller yet.
- Failed mutating requests currently produce no commit/record at all (the transaction's tree is discarded on handler throw, per gitsheets semantics) — worth a follow-up decision on whether failed requests should be captured.
- Consider filing a gitsheets upstream issue: `specs/behaviors/transactions.md`'s documented "concurrent-but-independent transact calls queue on an in-process mutex" doesn't hold across separate `Repository` instances on the same `gitDir` (verified against 2.4.0) — either the docs or the queueing behavior should be reconciled upstream, since a per-gitDir queue would restore true cross-session parallelism for this engine.
