# Recipe: git as the world-state engine for a dual-mode API facade

This page walks the scenario-engine pattern end to end, using the demo world
shipped in this repo (`fixtures/`, `src/routes/`, `scripts/demo.sh`) as the
worked example. Every command below was run against this repo's `main`
branch; every commit hash, session key, and response body is copy-pasted
from real output, not invented. If you want to reproduce any of it:

```sh
bun install
bun run dev              # starts the facade on :3001
scripts/demo.sh          # in another shell
```

See [`specs/scenario-engine.md`](../specs/scenario-engine.md) and
[`specs/facade.md`](../specs/facade.md) for the normative spec this recipe
narrates; this page is the tour, not the source of truth.

## The pattern in one sentence

The facade serves one API surface with two interchangeable backends per
route — **offline**, where git-backed [gitsheets](https://github.com/JarvusInnovations/gitsheets)
records *are* the world state, and **online**, where it proxies to real
upstream services — and every mutating offline request becomes exactly one
commit, so a session's entire history (requests, responses, record changes)
is a clonable git ref.

That one idea carries five uses this recipe covers at the end: E2E testing,
contract-first parallel development, training environments, time-travel
debugging, and agent sandboxes.

## Git as world-state

The demo world is a small delivery desk: couriers, orders, notifications,
and a simulated clock, declared as gitsheets sheets in
[`fixtures/.gitsheets/`](../fixtures/.gitsheets/). Two scenarios overlay
different starting states on top of a shared base
([`fixtures/base/`](../fixtures/base/)):

- `standard-day` — a full three-courier roster, two pending orders.
- `rush-hour` — two of the three couriers already `busy`
  ([`fixtures/scenarios/rush-hour/couriers/`](../fixtures/scenarios/rush-hour/couriers/)),
  so the second of two pending rush orders has nowhere to go.

At boot, the engine imports each scenario's fixtures (base underlaid by the
scenario overlay, with `fixtures/.gitsheets/` embedded into the tree) into
one baseline commit per scenario, at `refs/fixtures/baseline/<scenario>`.
Every login forks a **session** off one of those baselines onto its own ref,
`refs/sessions/<key>`, outside `refs/heads/` so it never shows up in an
ordinary branch listing. Nothing about a session lives anywhere but that
ref: no in-memory state, no database row. Clone the ref and you have the
complete, replayable session.

## The dual-mode seam

Each route declares its mode — `offline-only`, `online-only`, or `dual` — as
route config, and a **parity ledger**
([`registry/routes/`](../registry/routes/), itself a gitsheet) tracks that
status with links to the scenario behaviors defining it. A boot-time check
fails startup if a route's registered mode drifts from its ledger entry
(`src/routing/validate-registry.ts`).

The demo world's ledger has six entries. `GET /orders/:id` is the one
`dual` route — [`registry/routes/get-order.toml`](../registry/routes/get-order.toml):

```toml
id = "get-order"
method = "GET"
path = "/orders/:id"
mode = "dual"
behaviors = ["demo-world: order-lookup"]
notes = "Dual-mode order lookup; offline reads the session's orders sheet, online echoes a stub upstream shape. Both branches satisfy orderViewSchema (src/routes/orders.ts) — the serializer-parity demo."
```

Its handler ([`src/routes/orders.ts`](../src/routes/orders.ts)) has two
branches — one reading the session's `orders` sheet, one echoing a stub
upstream — but both shape their response to the same Fastify schema
(`orderViewSchema`), so the same test can assert on either backend and a
client can't tell which one answered except by the `source` field the demo
deliberately includes:

```sh
$ curl -s http://127.0.0.1:3001/orders/order-1001 -H "x-session-key: $SESSION_KEY" | jq .
{
  "id": "order-1001",
  "status": "pending",
  "source": "offline",
  "item": "wireless-mouse",
  "priority": "standard"
}
```

The other five entries split `offline-only` (the order state machine's three
transitions plus its notifications readback — routes that exist only as
scenario behavior, because no real backend implements them yet) and
`online-only` (`GET /couriers/:id/upstream`, a pass-through stub with no
session and no commit). "Backend caught up" is a PR that flips a ledger
entry's `mode` from `offline-only` to `dual`, reviewed against the
scenario's recorded request/response pairs — see
[`registry/README.md`](../registry/README.md).

## Request = commit

Every mutating offline request runs as one gitsheets transaction and lands
as one commit on the session ref. Forking `rush-hour` and accepting
`order-2001` (the courier roster's only available driver) produces this
commit, fetched straight off the runtime repo:

````
$ git --git-dir=var/runtime.git cat-file -p d853cec
tree 0f7ecc6135819421ca50f907a3197a79440f06a2
parent 87183fd0f3aa3097bbfb1918a3f773ed3994af13
author gitsheets-scenario-engine <engine@scenario-engine.invalid> 1784088948 -0400
committer gitsheets-scenario-engine <engine@scenario-engine.invalid> 1784088948 -0400

POST /orders/order-2001/accept

Request:
```json
null
```

Response:

```json
{
  "created_tick": 0,
  "id": "order-2001",
  "item": "replacement-charger",
  "priority": "rush",
  "status": "accepted",
  "updated_tick": 1,
  "courier_id": "alex"
}
```

Session: mrlkhuuf-2-wkk36mnr
Scenario: rush-hour
Request-Id: req-g
User-Agent: curl/8.5.0
Host: 127.0.0.1:3001
Response-Code: 200
````

The first line is `<METHOD> <path>`; the body carries the request and
response payloads; the trailers are the machine-readable analysis surface
(`Session`, `Scenario`, `Request-Id`, `Response-Code`, and whatever
`User-Agent`/`Host` were on the wire). `git blame` on any record answers
"which request changed this" directly (see below).

Accepting the *second* rush order in the same session — with no couriers
left — 409s and produces **no commit**:

```sh
$ curl -s -X POST http://127.0.0.1:3001/orders/order-2002/accept -H "x-session-key: $SESSION_KEY" | jq .
{
  "error": "no couriers available"
}
```

```
$ git --git-dir=var/runtime.git log --first-parent --format='%h %s' refs/sessions/mrlkhuuf-2-wkk36mnr
d853cec POST /orders/order-2001/accept
87183fd fork session mrlkhuuf-2-wkk36mnr
cea01d4 initialize session mrlkhuuf-2-wkk36mnr
```

Rejected transitions don't silently land as no-op commits — a request that
doesn't change the world doesn't get a git object. This is asserted
directly in the e2e suite (see below).

The fork itself is a two-commit shape, load-bearing rather than cosmetic: a
parentless root unique to the session, then a merge commit whose two
parents are `[sessionRoot, scenarioBaseline]`:

```
$ git --git-dir=var/runtime.git cat-file -p 87183fd
tree 57af57cceb8b71db8424e99c15705cf316e0a272
parent cea01d49727603a5dc0daada270fea2c16be1f9b
parent e6522d3d756e032f3ca03be975dbaca70e4f59ca
author gitsheets-scenario-engine <engine@scenario-engine.invalid> 0 +0000
committer gitsheets-scenario-engine <engine@scenario-engine.invalid> 0 +0000

fork session mrlkhuuf-2-wkk36mnr

Scenario-name: rush-hour
App-Version: 0.0.0-dev
```

`git log --first-parent` from the session ref walks pure session
history — the baseline's own commits never pollute it — while the second
parent is a real DAG edge back to the exact scenario the session forked
from, recovered from the ref's own log with no side state (see
[`specs/scenario-engine.md`](../specs/scenario-engine.md) § Session
lifecycle).

## Clone-the-running-server

The facade mounts a read-only git smart-HTTP endpoint over the runtime
repository ([`src/plugins/git-http.ts`](../src/plugins/git-http.ts)),
advertising exactly `refs/fixtures/baseline/*`, `refs/sessions/*`, and
pinned-session tags — gated by a bearer token that fails closed when unset.
Given a session key, fetch its complete causal history from a live
deployment, no shell access required:

```sh
$ export GIT_EXPOSURE_TOKEN=demo-token-xyz
$ git init -q debug-session && cd debug-session
$ git -c http.extraHeader="Authorization: Bearer $GIT_EXPOSURE_TOKEN" \
    fetch -q http://127.0.0.1:3001/git refs/sessions/mrlkjbvv-0-2cbzkxqr:refs/heads/session
$ git log --first-parent --format='%h %s' refs/heads/session
ded7427 POST /orders/order-1001/complete
8b5eb42 POST /orders/order-1001/start
ee041b3 POST /orders/order-1001/accept
1ba83eb fork session mrlkjbvv-0-2cbzkxqr
bb0fbb3 initialize session mrlkjbvv-0-2cbzkxqr
```

That's a real fetch against a running `bun run dev` process — `scripts/demo.sh`
does the same thing when you set `GIT_EXPOSURE_TOKEN` before running it,
using `clone --mirror` instead of a single-ref fetch.

From there, ordinary git answers ordinary debugging questions. Which
request last touched a record:

```sh
$ git blame refs/heads/session -- orders/order-1001.toml
ee041b39 (gitsheets-scenario-engine 2026-07-15 00:16:57 -0400 1) courier_id = "alex"
ee041b39 (gitsheets-scenario-engine 2026-07-15 00:16:57 -0400 2) created_tick = 0
^cfaeb21 (gitsheets-scenario-engine 1970-01-01 00:00:00 +0000 3) id = "order-1001"
^cfaeb21 (gitsheets-scenario-engine 1970-01-01 00:00:00 +0000 4) item = "wireless-mouse"
^cfaeb21 (gitsheets-scenario-engine 1970-01-01 00:00:00 +0000 5) priority = "standard"
ded7427d (gitsheets-scenario-engine 2026-07-15 00:16:57 -0400 6) status = "completed"
ded7427d (gitsheets-scenario-engine 2026-07-15 00:16:57 -0400 7) updated_tick = 3
```

(Note the ref: without one, `git blame` has no `HEAD` to walk from in a
freshly-initialized repo that only has `refs/heads/session` — the README's
git-exposure walkthrough has been corrected to pass the ref explicitly.)

And provenance — which scenario, at which app version, a session forked
from — recovers entirely from the ref's own log, via the fork commit's
second parent and its trailer:

```sh
$ FORK=$(git log --first-parent --format=%H refs/heads/session | \
    while read -r c; do [ "$(git cat-file -p "$c" | grep -c '^parent ')" = 2 ] && echo "$c" && break; done)
$ git log --first-parent "$FORK^2"
commit cfaeb2153616579d953018bd0f7aacd855e7e592
Author: gitsheets-scenario-engine <engine@scenario-engine.invalid>
Date:   Thu Jan 1 00:00:00 1970 +0000

    baseline: standard-day
$ git log --format='%H %(trailers:key=Scenario-name,valueonly)' -1 "$FORK"
1ba83ebcb5aa8dedf3535bb2b6d19e012845776c standard-day
```

See [`README.md`](../README.md) § Git exposure for the full command
sequence and the auth-gate details.

## The five uses

### 1. Infrastructure-free E2E testing

The e2e harness ([`src/tests/e2e/harness.ts`](../src/tests/e2e/harness.ts))
logs in over `fastify.inject()` (no sockets, no ports, fully parallel) and
asserts on **both** surfaces — the HTTP response and the resulting session
commits/records. Its worked example
([`src/tests/e2e/state-machine.e2e.test.ts`](../src/tests/e2e/state-machine.e2e.test.ts))
drives the same accept → start → complete flow shown above and checks the
commit count at each step:

```ts
const accept = await session.request({ method: "POST", url: "/orders/order-1002/accept" });
expect(accept.statusCode).toBe(200);
expect(await session.commitCount()).toBe(before + 1); // exactly one commit for one transition

const acceptNotifications = await session.records("notifications", { order_id: "order-1002" });
expect(acceptNotifications).toHaveLength(1); // the notification record exists
```

Run against this repo:

```
$ bun test src/tests/e2e/state-machine.e2e.test.ts
bun test v1.3.14 (0d9b296a)

 3 pass
 0 fail
 23 expect() calls
Ran 3 tests across 1 file. [2.83s]
```

CI needs the checkout and a Bun install, nothing else — fixtures live in the
tree, so tests always exercise the fixture state of the commit under test
(`.github/workflows/ci.yml`). A failing test bundles every session it
touched to `var/e2e-artifacts` (`src/tests/e2e/bundle.ts`) before rethrowing,
uploaded as a CI artifact — the session ref *is* the recording.

### 2. Contract-first parallel development

The parity ledger is what makes this concrete rather than aspirational.
`GET /orders/:id/notifications` and the three accept/start/complete routes
are `offline-only` in the demo world — they exist only as scenario
behavior, an executable spec a backend team builds toward. "Caught up" is a
PR that flips one ledger entry to `dual`, reviewed against the scenario's
recorded request/response pairs, same as `get-order.toml` already is. A
frontend team never blocks on that PR landing; it builds against the
scenario today.

### 3. Training environments

`POST /session/login` accepts a `modeOverride` that pins a session to
`offline` or `online` regardless of the deployment's default for `dual`
routes (`src/routes/session.ts`, `specs/facade.md` § Mode model) — an
online production deployment can run a training session against the
scenario engine while real traffic proxies online in the same process, with
zero risk of a trainee's actions touching upstream systems. The e2e
harness's `loginInject(fastify, scenario, { modeOverride })` exercises the
same knob for tests.

### 4. Time-travel debugging

This is the "clone-the-running-server" section above, applied to a bug
report instead of a demo run: a session key from a bug report is enough to
pull the complete causal log — every request, response, and record
mutation, through the fork's second-parent edge to the exact scenario
baseline the deployed build shipped — onto a laptop with `git fetch`, no
server access beyond the read-only endpoint.

### 5. Agent sandbox

The same server, three thin conventions added
([`src/routes/sandbox.ts`](../src/routes/sandbox.ts)): fork-per-run,
judgment-by-diff, and replay-based regression. All three are real endpoints
on this repo's running server. Forking two runs of `standard-day` and
diverging them — one agent stalls after `start`, the other completes the
order — then judging the stalled run against the completed one as
reference:

```sh
$ curl -s -X POST http://127.0.0.1:3001/sandbox/runs -H 'content-type: application/json' \
    -d '{"scenario":"standard-day","count":2}' | jq -c '.runs'
[{"sessionKey":"mrlkna4m-0-b69lvtzp"},{"sessionKey":"mrlkna4q-1-e39cpbpp"}]

# run A: accept, start (stalls before completion)
# run B: accept, start, complete

$ curl -s -X POST http://127.0.0.1:3001/sandbox/judge -H 'content-type: application/json' \
    -d '{"runSession":"mrlkna4m-0-b69lvtzp","referenceSession":"mrlkna4q-1-e39cpbpp","notes":"agent A stalled before completion"}' | jq .
{
  "id": "mrlkna4m-0-b69lvtzp--mrlkna4q-1-e39cpbpp",
  "run_session": "mrlkna4m-0-b69lvtzp",
  "reference_session": "mrlkna4q-1-e39cpbpp",
  "scenario": "standard-day",
  "matches": false,
  "changed_paths": [
    "clock/clock.toml",
    "couriers/alex.toml",
    "notifications/order-1001-3.toml",
    "orders/order-1001.toml"
  ],
  "run_commit_count": 4,
  "reference_commit_count": 5,
  "notes": "agent A stalled before completion"
}
```

The verdict is a persisted record (`GET /sandbox/judgments` reads it back),
and the diff is exactly the paths the missing `complete` transition would
have touched — `couriers/alex.toml` (never freed), `orders/order-1001.toml`
(never reached `completed`), the third notification. `POST
/sandbox/regression` replays a prior run's request log against a fresh fork
on *this* running facade version and diffs at every step — a regression
signal between facade versions, not just between agents:

```sh
$ curl -s -X POST http://127.0.0.1:3001/sandbox/regression -H 'content-type: application/json' \
    -d '{"sessionKey":"mrlkna4m-0-b69lvtzp"}' | jq .
{
  "sessionKey": "mrlkna4m-0-b69lvtzp",
  "scenario": "standard-day",
  "replaySessionKey": "mrlknho0-2-cx1oxbqk",
  "deterministic": true,
  "divergentSteps": []
}
```

`deterministic: true` and an empty `divergentSteps` mean the replay
reproduced run A's tree exactly — the determinism guarantee
(`specs/scenario-engine.md` § Determinism and replay) making regression
detection possible at all: no wall-clock or randomness leaks into record
content, so the same request log against the same baseline always produces
the same tree.

Judgment-by-diff overlaps with, and is scoped to complement rather than
duplicate, the [evaluation-corpus recipe](https://github.com/JarvusInnovations/gitsheets/issues/229) —
this pattern owns minting and comparing sessions; that one owns
corpus/schema design for evaluator records at scale.

## See also

- [`README.md`](../README.md) — the front door: setup, the demo script, the
  full git-exposure command sequence.
- [`specs/scenario-engine.md`](../specs/scenario-engine.md) — scenarios,
  sessions, ref layout, request=commit format, lifecycle, the gitsheets 2.x
  mapping.
- [`specs/facade.md`](../specs/facade.md) — the dual-mode seam, parity
  model, git exposure, the E2E harness.
- [gitsheets#229](https://github.com/JarvusInnovations/gitsheets/issues/229) —
  the evaluation-corpus recipe (judging-record schema and corpus design).
- [gitsheets#231](https://github.com/JarvusInnovations/gitsheets/issues/231) —
  the umbrella tracker this template implements against.
</content>
