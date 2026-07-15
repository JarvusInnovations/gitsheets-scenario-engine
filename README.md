# gitsheets-scenario-engine

*Working title — template repo in specification stage.*

A template for building a **scenario simulation backend**: a dual-mode API facade where git is the world-state engine. In offline mode the facade serves and mutates schema-validated [gitsheets](https://github.com/JarvusInnovations/gitsheets) records; in online mode it proxies to real upstream APIs. Each login forks an isolated **scenario** onto a per-session branch, and every API request becomes a commit that logs the request/response alongside the record mutations it caused.

The pattern is production-proven at enterprise scale (a nationwide delivery platform's driver app, 2020–22), where it carried four load-bearing uses:

1. **Infrastructure-free E2E testing** — CI runs full end-to-end suites against scenarios with zero online infrastructure.
2. **Contract-first parallel development** — frontend teams sprint ahead by defining desired behavior as scenarios; backend teams build to those scenarios as an executable spec; the facade mediates gradual convergence to parity.
3. **Training environments** — operational users log into scenarios on the online instance for risk-free onboarding.
4. **Time-travel debugging** — a misbehaving session is a clonable git ref interleaving requests, responses, and state changes in one graph. You can `git clone` the running server's state.

A fifth use is native to 2026: the same primitive is an **agent sandbox** — forkable, diffable, deterministically replayable world-state for developing and evaluating agents in parallel.

## Status

**Specs settled and trued up against shipped gitsheets 2.4.x; the implementation DAG is planned (see [`plans/`](plans/)).** The original implementation hand-rolled its git plumbing on a legacy API; gitsheets 2.x — `transact` (with explicit `parent`/`branch` targets), CAS ref updates, the commit-time freshness model, `withLock`, schema validation, canonical serialization, now published to npm and PyPI and cold-verified — has since absorbed the engine work, so this template is mostly **conventions and middleware**. Every open question the first spec draft flagged is now answered by a shipped gitsheets primitive (see the scenario-engine spec's *gitsheets 2.x mapping*). Tracked publicly at JarvusInnovations/gitsheets#231.

## Spec index

- [`specs/scenario-engine.md`](specs/scenario-engine.md) — scenarios, sessions, ref layout, request=commit format, lifecycle, gitsheets mapping
- [`specs/facade.md`](specs/facade.md) — the dual-mode seam, parity model, git exposure, E2E harness

## Recipe

[`docs/recipe.md`](docs/recipe.md) walks the whole pattern — git-as-world-state, the dual-mode seam, request=commit, clone-the-running-server, and the five uses above — with every command run against this repo's demo world and pasted verbatim, not invented.

## Plans

The build is decomposed as a dependency DAG in [`plans/`](plans/) — start at [`plans/README.md`](plans/README.md). Each plan freezes to `done` as the durable record of what got built.

## Demo world

The template ships a small runnable example (`plans/demo-world.md`) — a delivery-desk
domain (`fixtures/.gitsheets/{couriers,orders,notifications,clock}.toml`) with two
scenarios (`standard-day`, `rush-hour`) and a handful of routes
(`src/routes/{session,orders,couriers}.ts`) demonstrating every load-bearing concept: a
`dual` route, `offline-only` routes, an `online-only` route, and a non-trivial state
machine (an order moving `pending -> accepted -> in-progress -> completed`) implemented
entirely as plain handler code over records — see `specs/facade.md` § Offline mode's
all-state-in-records discipline.

```sh
bun install
bun run dev              # starts the facade on :3001 (see .env.example)

# in another shell:
scripts/demo.sh          # login -> drive the state machine -> clone the session
```

`scripts/demo.sh` accepts `BASE_URL`, `SCENARIO`, `ORDER_ID`, and (to exercise the
git-exposure clone below rather than a direct `git clone` of the runtime repo)
`GIT_EXPOSURE_TOKEN` as environment overrides — try `SCENARIO=rush-hour
ORDER_ID=order-2002 scripts/demo.sh` to see the divergent scenario's `409 no couriers
available` response.

## Git exposure: debugging a session from the command line

The facade mounts a read-only git smart-HTTP endpoint over the runtime repository (`src/plugins/git-http.ts`; see [`specs/facade.md`](specs/facade.md) § Git exposure). It advertises exactly three ref prefixes — `refs/fixtures/baseline/*`, `refs/sessions/*`, and pinned-session tags (`refs/tags/sessions/*/pinned`) — and serves fetch/clone only; there is no push path, at any layer.

Given a session key (returned to the client at login, or found in a bug report), fetch its complete causal history — every request, response, and record mutation, traceable through the baseline to the exact application version:

```sh
# Configure the deployment's operator token once (never put it in the URL).
export GIT_EXPOSURE_TOKEN=...

git init debug-session && cd debug-session
git -c http.extraHeader="Authorization: Bearer $GIT_EXPOSURE_TOKEN" \
  fetch https://<deployment-host>/git refs/sessions/<session-key>:refs/heads/session

# Pure session history — trunk/baseline commits never pollute this walk.
git log --first-parent refs/heads/session

# Every record mutation, with the request that caused it. Name the fetched
# ref explicitly — a freshly `git init`ed repo has no HEAD to blame from.
git blame refs/heads/session -- <sheet-root>/<record-path>

# Provenance: the session's fork point is the one commit in --first-parent
# history with two parents (specs/scenario-engine.md § Session lifecycle);
# its second parent is the scenario baseline this session forked from.
FORK=$(git log --first-parent --format=%H refs/heads/session | \
  while read -r c; do [ "$(git cat-file -p "$c" | grep -c '^parent ')" = 2 ] && echo "$c" && break; done)
git log --first-parent "$FORK^2"   # the baseline lineage, down to the exact app version
git log --format='%H %(trailers:key=Scenario-name,valueonly)' -1 "$FORK"  # scenario identity, from the ref alone
```

`GIT_EXPOSURE_TOKEN` gates the endpoint (deny-by-default: an unset or wrong token is refused, never left open — see `.env.example` and `src/plugins/git-http.ts`'s module comment for the full auth-gate and ref-scoping mechanism).
