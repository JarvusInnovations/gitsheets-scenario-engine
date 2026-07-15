# Spec: Dual-mode API facade

## Rule

The facade presents **one API surface** with two interchangeable backends per route: **offline** (the scenario engine) and **online** (proxy/adapt to real upstream services). Clients cannot tell which mode served them except by declared headers; switching modes never changes the API contract. This is what lets a frontend team build against scenarios while a backend team builds the real services to the same contract, converging gradually.

## Stack

The facade is **Fastify** (5.x, Node ≥ 20). This is prescribed, not suggested — the template ships working Fastify code, and the spec's structural concepts map onto Fastify primitives:

- The **scenario engine binds as a Fastify plugin** (`fastify-plugin`): decorates the instance with the engine/store, decorates requests with the resolved session — a **session-scoped `Repository` handle**, so gitsheets' commit-time auto-refresh stays session-local (see the scenario-engine spec's gitsheets mapping) — and registers the session-resolution `onRequest` hook and the request=commit wrapping around handler execution.
- The **route registry entries attach as route config** (`config.lensMode`-style route options: `offline-only` | `online-only` | `dual`), so mode resolution happens per-route in a hook rather than in handler code, and the registry file is validated against the actually-registered routes at boot (drift between ledger and code fails startup).
- **Serializer parity** between modes uses Fastify's per-route response schemas — one schema serializes both backends' responses, which is itself a contract-conformance check.

## Mode model

- **Mode is resolved per route, not per deployment.** A route registry declares each route's status: `offline-only` (exists only as scenario behavior — the executable spec for unbuilt backend work), `online-only` (pass-through), or `dual` (both implemented; runtime selection).
- **Runtime selection** for `dual` routes: deployment default, overridable per session at login (an online deployment hosting training sessions runs those sessions offline while real traffic proxies online).
- **The parity ledger is the registry itself** — a reviewable file (a gitsheet, naturally) tracking each route's status with links to the scenario behaviors that define it. "Backend caught up" = a PR flipping `offline-only` → `dual`, reviewed against the scenario's recorded request/response pairs.

## Offline mode

- Route handlers read/write the session's world through typed sheet APIs inside the request's transaction (the session-scoped `repo.transact` handler exposes `tx.sheet(name)`; `openStore` layers Standard Schema validators — Zod/Valibot/ArkType — over the in-core JSON Schema for typed handler code). See the scenario-engine spec.
- Behavior beyond CRUD — state machines, validations, simulated side effects (push notification records, event feeds) — lives in plain handler code operating on records. The discipline: **all state lands in records**; anything in process memory is a bug (it breaks clone/replay fidelity).
- Responses are shaped by the same serializers as online mode; contract tests run against both.

## Online mode

- Handlers proxy to upstream services through per-service adapters (auth injection, shape mapping, version selection). No gitsheets involvement; no commits.
- A deployment may enable **shadow capture**: online responses recorded (redacted per policy) as candidate fixture material for new scenarios — the cheapest way to grow scenario coverage from real traffic.

## Git exposure

- The facade mounts a git smart-HTTP endpoint (`git-http-backend` or equivalent) serving the engine's repository read-only, gated by the deployment's operator auth.
- Advertised refs: `refs/fixtures/baseline/*`, `refs/sessions/*` (and pinned-session tags). A developer debugging a field report fetches the session ref and has the complete causal history — requests, responses, and every record mutation — locally, traceable through the baseline commit to the exact application version.
- Write access is never exposed; all mutation flows through the API.

## E2E harness

- Tests declare their scenario, log in (fork), exercise the API via **`fastify.inject()`** — no sockets, no ports, fully parallel — and assert on **both** surfaces: HTTP responses *and* resulting session commits/records (e.g. "the accept flow produced exactly 2 commits; `orders/1234` reached `state=accepted`; the notification record exists"). A thin over-the-wire smoke tier keeps `inject` honest.
- Session isolation makes parallel test workers trivial — one session each, no cleanup beyond ref deletion.
- CI needs the repo checkout and node only: fixtures are in the tree, so tests always exercise **the fixture state of the commit under test** — no databases, no network, no staging environment, no fixture-version skew.
- Test recordings (video/logs) attach naturally: the session ref *is* the state recording; bundle it (`git bundle`) as a CI artifact alongside media.

## Fixtures as shippable data

- Scenario fixtures live in the application source tree (`fixtures/` — see the scenario-engine spec) and therefore ship inside every build artifact automatically; the engine's boot import builds the runtime baselines from them deterministically. An offline deployment boots with zero external fetches, and a deployed instance's scenarios are exactly its code version's scenarios — never newer, never staler.

## Agent-sandbox profile

The same server, used for agent development/evaluation rather than app development, with three conventions added:

- **Fork-per-agent-run**: each evaluation run gets a session; N candidate agents run against identical forks of the same scenario.
- **Judgment by diff**: an agent run's outcome is the tree diff + commit log of its session — score it by comparing against a reference session or via evaluator records (see the evaluation-corpus pattern) written to a separate judging sheet.
- **Deterministic replay** (scenario-engine spec) gives regression evals: replay a prior run's requests against a new agent/facade version and diff.

## Template deliverables (implementation phase, once specs settle)

1. Facade skeleton (Fastify 5.x) with the engine plugin, route registry as route config, mode resolution, session + request=commit hooks, and git exposure.
2. A small demo world: 3–4 sheets, 2 scenarios, a handful of dual/offline-only routes.
3. E2E harness wired into CI as the living example.
4. Replay tool + session GC sweep.
5. Recipe page for the gitsheets docs site (JarvusInnovations/gitsheets#231).
