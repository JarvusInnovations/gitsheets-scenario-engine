---
status: done
pr: 5
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

- [x] `git clone`/`git fetch` of the endpoint retrieves a session ref with full history; second-parent lineage brings the baseline along (`src/tests/git-http.test.ts` "git exposure: fetch retrieves full session history" — a real `fastify.listen({port:0})` socket, fetched with the actual `git` CLI; asserts the client's `--first-parent` log matches the server's exactly, and the merge commit's second parent resolves to the scenario baseline commit)
- [x] Only the advertised refs are visible; no write path (receive-pack refused) (`src/tests/git-http.test.ts` "ref advertisement scoping" — a deliberately planted off-pattern `refs/heads/*` ref is confirmed hidden from `git ls-remote`, not just absent by construction; "no write path" — `git push` fails end-to-end with 403/forbidden in the output and no ref lands server-side)
- [x] Auth gate enforced (`src/tests/git-http.test.ts` "operator-auth gate" — unauthenticated, wrong-token, and unset-`GIT_EXPOSURE_TOKEN` requests are all 401; a real `git fetch` without the bearer header fails against the live socket too)

## Risks / unknowns

- Smart-HTTP handler choice under Fastify (subprocess `git-http-backend` vs. a JS implementation) — **resolved**: subprocess `git http-backend`, spawned per-request via `Bun.spawn` and bridged through the CGI protocol (env vars in, header-block-then-body out). Verified empirically against the shipped git 2.51 binary before writing the bridge (see PR description). No extra daemon, no second port — matches "same-process, no-extra-daemon story."

## Notes

**Ref-scoping and read-only enforcement are both done via per-invocation git config injection, not by touching the runtime repo's on-disk config.** Git >= 2.31's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` env vars inject `uploadpack.hideRefs` (hide everything under `refs/`, un-hide the three advertised prefixes) and `http.receivepack=false` for the lifetime of one subprocess call only. This keeps `src/plugins/git-http.ts` fully decoupled from `engine/plumbing.ts`/`boot-import.ts`, which own the repo's actual on-disk state.

**Read-only is enforced at two independent layers, not one.** `POST <prefix>/git-receive-pack` is refused directly by the Fastify route handler — there is no code path from that endpoint to the subprocess at all. The `GIT_CONFIG` `http.receivepack=false` injection is defense in depth for the *shared* `/info/refs` negotiation endpoint, which the smart-HTTP protocol requires to handle `?service=git-receive-pack` probes too (git itself returns `403 Forbidden` there — verified empirically, see the PR description's probe transcript).

**No app-wide operator-identity system exists in this template yet** (`plans/engine-plugin.md`'s own Notes flag this: "nothing in this plan authenticates a caller yet"). The auth gate here is therefore a single, scoped `Authorization: Bearer <GIT_EXPOSURE_TOKEN>` check — deny-by-default per the `jarvus-fastify` `authentication.md` model (unset token fails closed, never open) — rather than a build-out of full OIDC/session infrastructure, which is out of this plan's scope. The plugin is deliberately not `fastify-plugin`-wrapped so Fastify's encapsulation keeps its content-type parser and auth hook off the rest of the app.

**Test-only real socket.** `fastify.inject()` executes route handlers in-process without opening a TCP listener, which is fine for the auth-gate-only assertions but cannot serve an actual `git` CLI process. The fetch/ls-remote/push tests use `fastify.listen({ port: 0 })` for an ephemeral real socket, torn down in `afterEach`.

## Follow-ups

- The `Git-Protocol` request header is forwarded to the subprocess as the `GIT_PROTOCOL` env var (matching the documented nginx/apache git-http-backend server-config convention) so protocol v2 negotiation works when a client sends it; not independently tested — protocol v0 (the fallback when absent) is what the test suite exercises, and both are fully functional for clone/fetch.
- No streaming: request/response bodies are fully buffered in memory before being handed to/read from the subprocess. Fine at scenario-session scale; would need revisiting if the runtime repo's fetchable data grows large (e.g. captured media blobs — see `specs/scenario-engine.md` § gitsheets 2.x mapping's `readBlobStream` mention).
- `uploadpack.allowTipSHA1InWant`/`allowAnySHA1InWant` were not touched, so a client cannot fetch a hidden ref's objects even by guessing its SHA — the default (disabled) is the correct read-only-scoping posture and was left alone rather than actively verified with a dedicated test.
