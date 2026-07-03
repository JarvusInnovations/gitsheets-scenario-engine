# Spec: Dual-mode API facade

## Rule

The facade presents **one API surface** with two interchangeable backends per route: **offline** (the scenario engine) and **online** (proxy/adapt to real upstream services). Clients cannot tell which mode served them except by declared headers; switching modes never changes the API contract. This is what lets a frontend team build against scenarios while a backend team builds the real services to the same contract, converging gradually.

## Mode model

- **Mode is resolved per route, not per deployment.** A route registry declares each route's status: `offline-only` (exists only as scenario behavior — the executable spec for unbuilt backend work), `online-only` (pass-through), or `dual` (both implemented; runtime selection).
- **Runtime selection** for `dual` routes: deployment default, overridable per session at login (an online deployment hosting training sessions runs those sessions offline while real traffic proxies online).
- **The parity ledger is the registry itself** — a reviewable file (a gitsheet, naturally) tracking each route's status with links to the scenario behaviors that define it. "Backend caught up" = a PR flipping `offline-only` → `dual`, reviewed against the scenario's recorded request/response pairs.

## Offline mode

- Route handlers read/write the session's world through typed sheet APIs inside the request's transaction (see scenario-engine spec).
- Behavior beyond CRUD — state machines, validations, simulated side effects (push notification records, event feeds) — lives in plain handler code operating on records. The discipline: **all state lands in records**; anything in process memory is a bug (it breaks clone/replay fidelity).
- Responses are shaped by the same serializers as online mode; contract tests run against both.

## Online mode

- Handlers proxy to upstream services through per-service adapters (auth injection, shape mapping, version selection). No gitsheets involvement; no commits.
- A deployment may enable **shadow capture**: online responses recorded (redacted per policy) as candidate fixture material for new scenarios — the cheapest way to grow scenario coverage from real traffic.

## Git exposure

- The facade mounts a git smart-HTTP endpoint (`git-http-backend` or equivalent) serving the engine's repository read-only, gated by the deployment's operator auth.
- Advertised refs: `refs/heads/fixtures`, `refs/sessions/*` (and pinned-session tags). A developer debugging a field report runs `git clone --single-branch --branch <session>` and has the complete causal history — requests, responses, and every record mutation — locally.
- Write access is never exposed; all mutation flows through the API.

## E2E harness

- Tests declare their scenario, log in (fork), exercise the API, and assert on **both** surfaces: HTTP responses *and* resulting session commits/records (e.g. "the accept flow produced exactly 2 commits; `orders/1234` reached `state=accepted`; the notification record exists").
- Session isolation makes parallel test workers trivial — one session each, no cleanup beyond ref deletion.
- CI needs the repo and the facade binary only: no databases, no network, no staging environment.
- Test recordings (video/logs) attach naturally: the session ref *is* the state recording; bundle it (`git bundle`) as a CI artifact alongside media.

## Fixtures as shippable data

- Scenario fixtures travel with the application: CI packages the fixtures branch (optionally composed/projected from multiple sources) as a git bundle inside the deployable artifact, so an offline deployment boots with zero external fetches.

## Agent-sandbox profile

The same server, used for agent development/evaluation rather than app development, with three conventions added:

- **Fork-per-agent-run**: each evaluation run gets a session; N candidate agents run against identical forks of the same scenario.
- **Judgment by diff**: an agent run's outcome is the tree diff + commit log of its session — score it by comparing against a reference session or via evaluator records (see the evaluation-corpus pattern) written to a separate judging sheet.
- **Deterministic replay** (scenario-engine spec) gives regression evals: replay a prior run's requests against a new agent/facade version and diff.

## Template deliverables (implementation phase, once specs settle)

1. Facade skeleton (Node/Fastify or equivalent) with the route registry, mode resolution, session middleware, request=commit middleware, and git exposure.
2. A small demo world: 3–4 sheets, 2 scenarios, a handful of dual/offline-only routes.
3. E2E harness wired into CI as the living example.
4. Replay tool + session GC sweep.
5. Recipe page for the gitsheets docs site (JarvusInnovations/gitsheets#231).
