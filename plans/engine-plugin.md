---
status: planned
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
4. **Session-scoped `Repository` handle** — the `onRequest` hook resolves the session key → a per-session gitsheets `Repository` handle bound to `refs/sessions/<key>` (transact `parent`/`branch` both set to the session ref, since it's outside `refs/heads/`), so commit-time auto-refresh stays session-local per the spec's design consequence. `withLock` serializes writers within a session.
5. **Request = commit** — wrap mutating handlers so the handler runs inside one `repo.transact`; on success format the commit message (`<METHOD> <path>` + fenced request/response) and trailers (`Session`, `Scenario`, `Request-id`, `Response-code`, `User-agent`, `Host`), author = authenticated principal (pseudonymized per policy), committer = engine. Read-only requests don't commit (opt-in read logging deferred). `EVENT <name>` path for non-request mutations.

## Validation

- [ ] Boot import is deterministic: same fixtures ⇒ identical baseline tree hashes across two boots and two processes
- [ ] Fork produces the two-commit DAG; `git log --first-parent <session>` shows only session history; trailers recover scenario identity from the ref alone
- [ ] A mutating request produces exactly one commit on the session ref with correct message/trailers/author; the record mutation is schema-validated
- [ ] Two concurrent sessions never cross-contaminate reads (per-session handle proven); intra-session writers serialize; a lost CAS race surfaces as an error
- [ ] Reset re-forks cheaply; nothing else references the session ref

## Risks / unknowns

- Depth-1 app-commit bundle availability at boot (the build must ship it as the baseline parent) — verify the packaging step.
- Per-session handle lifecycle/pooling under load (open cost vs. reuse) — feeds the latency benchmark in the scenario-engine spec.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
