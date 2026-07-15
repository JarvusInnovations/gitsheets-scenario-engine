---
status: planned
depends: [engine-plugin]
specs:
  - specs/facade.md
issues: []
---

# Git exposure: read-only smart-HTTP endpoint

## Scope

Mount a git smart-HTTP endpoint serving the runtime repository **read-only**, so a developer can `git fetch`/`git clone` a session's complete causal history — requests, responses, record mutations — traceable through the baseline to the exact app version. Advertise baseline and session refs; gate on operator auth; never expose write access.

## Implements

- `specs/facade.md` § Git exposure

## Approach

1. Mount `git-http-backend` (or an equivalent smart-HTTP handler) against the runtime bare repo, read-only (upload-pack only; no receive-pack).
2. Ref advertisement scoped to `refs/fixtures/baseline/*`, `refs/sessions/*`, and pinned-session tags — session refs live outside `refs/heads/` precisely so ordinary clones stay clean and this layer advertises them explicitly.
3. Operator-auth gate (deployment-configured) in front of the endpoint; all mutation stays behind the API.
4. Document the debugging flow: fetch a session ref → inspect `git log --first-parent` / `git blame` on records.

## Validation

- [ ] `git clone`/`git fetch` of the endpoint retrieves a session ref with full history; second-parent lineage brings the baseline along
- [ ] Only the advertised refs are visible; no write path (receive-pack refused)
- [ ] Auth gate enforced

## Risks / unknowns

- Smart-HTTP handler choice under Fastify (subprocess `git-http-backend` vs. a JS implementation) — pick for the same-process, no-extra-daemon story.

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
