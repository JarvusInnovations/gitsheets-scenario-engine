// The agent-sandbox profile (plans/agent-sandbox-profile.md,
// specs/facade.md § Agent-sandbox profile): fork-per-run, judgment-by-diff,
// and replay-based regression evals as a thin layer over the SAME engine
// the demo world already exercises (src/tests/demo-world.test.ts) — most of
// this suite boots against the real fixtures/registry trees (no scratch
// overrides), the same way demo-world.test.ts does, since fork-per-run and
// judgment-by-diff are meaningless without real world state (orders,
// couriers) to diverge over.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp, scaffoldFixtures } from "./helpers.ts";
import { registerNondeterministicRoutes } from "./support/nondeterministic-routes.ts";
import { SESSION_HEADER } from "../plugins/engine.ts";
import * as plumbing from "../engine/plumbing.ts";
import { sweepExpiredSessions } from "../engine/session-gc.ts";

let fastify: FastifyInstance;

beforeEach(async () => {
  // No env overrides: proves the shipped demo world + shipped
  // fixtures/.gitsheets/judgments.toml work together, not a scaffolded
  // stand-in. A successful buildTestApp() here is itself proof the
  // boot-time registry-drift check (src/plugins/routing.ts) still passes
  // with /sandbox/* registered — those routes declare no config.mode, so
  // they're outside the parity ledger's purview (see registry/README.md's
  // documented exemption, extended to /sandbox/* alongside /session/login
  // and /health).
  fastify = await buildTestApp();
});

afterEach(async () => {
  await fastify.close();
});

async function login(scenario: string): Promise<string> {
  const response = await fastify.inject({
    method: "POST",
    url: "/session/login",
    payload: { scenario },
  });
  return response.json().sessionKey as string;
}

describe("boot: /sandbox/* routes exist outside the dual-mode facade", () => {
  test("registered without requiring parity-ledger entries", () => {
    expect(fastify.hasRoute({ method: "POST", url: "/sandbox/runs" })).toBe(true);
    expect(fastify.hasRoute({ method: "POST", url: "/sandbox/judge" })).toBe(true);
    expect(fastify.hasRoute({ method: "GET", url: "/sandbox/judgments" })).toBe(true);
    expect(fastify.hasRoute({ method: "POST", url: "/sandbox/regression" })).toBe(true);
  });
});

describe("POST /sandbox/runs — fork-per-run", () => {
  test("mints N isolated sessions from one scenario in a single call", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/runs",
      payload: { scenario: "standard-day", count: 3 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.scenario).toBe("standard-day");
    expect(body.runs).toHaveLength(3);

    const sessionKeys = body.runs.map((r: { sessionKey: string }) => r.sessionKey);
    expect(new Set(sessionKeys).size).toBe(3); // every fork is a distinct session

    // Every fork starts from identical baseline world state.
    for (const sessionKey of sessionKeys) {
      const read = await fastify.inject({
        method: "GET",
        url: "/orders/order-1001",
        headers: { [SESSION_HEADER]: sessionKey },
      });
      expect(read.json()).toMatchObject({ id: "order-1001", status: "pending" });
    }
  });

  test("N parallel runs get isolated forks: mutating one does not leak into another", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/runs",
      payload: { scenario: "standard-day", count: 2 },
    });
    const [runA, runB] = response.json().runs as { sessionKey: string }[];

    await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/accept",
      headers: { [SESSION_HEADER]: runA!.sessionKey },
    });

    const readA = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: runA!.sessionKey },
    });
    expect(readA.json()).toMatchObject({ status: "accepted" });

    // run B's fork is untouched by run A's mutation — no cross-run
    // interference despite both forking the same scenario.
    const readB = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: runB!.sessionKey },
    });
    expect(readB.json()).toMatchObject({ status: "pending" });
  });

  test("an unknown scenario is rejected with 404", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/runs",
      payload: { scenario: "no-such-scenario", count: 2 },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /sandbox/judge — judgment by diff", () => {
  test("two untouched forks of the same scenario judge as an exact match", async () => {
    const runSession = await login("standard-day");
    const referenceSession = await login("standard-day");

    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession, referenceSession },
    });
    expect(response.statusCode).toBe(201);
    const judgment = response.json();
    expect(judgment).toMatchObject({
      id: `${runSession}--${referenceSession}`,
      run_session: runSession,
      reference_session: referenceSession,
      scenario: "standard-day",
      matches: true,
      changed_paths: [],
    });
    expect(judgment.run_commit_count).toBe(judgment.reference_commit_count);
  });

  test("a run that diverges from its reference is scored with the changed paths", async () => {
    const runSession = await login("standard-day");
    const referenceSession = await login("standard-day");

    await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/accept",
      headers: { [SESSION_HEADER]: runSession },
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession, referenceSession },
    });
    expect(response.statusCode).toBe(201);
    const judgment = response.json();
    expect(judgment.matches).toBe(false);
    expect(judgment.changed_paths).toContain("orders/order-1001.toml");
    expect(judgment.run_commit_count).toBe(judgment.reference_commit_count + 1);
  });

  test("the verdict is persisted in a separate judging sheet — GET /sandbox/judgments reads it back", async () => {
    const runSession = await login("standard-day");
    const referenceSession = await login("standard-day");

    await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession, referenceSession, notes: "smoke judgment" },
    });

    const response = await fastify.inject({
      method: "GET",
      url: `/sandbox/judgments?runSession=${runSession}`,
    });
    expect(response.statusCode).toBe(200);
    const { judgments } = response.json();
    expect(judgments).toHaveLength(1);
    expect(judgments[0]).toMatchObject({
      run_session: runSession,
      reference_session: referenceSession,
      notes: "smoke judgment",
    });

    // The record lives on its own persistent ref, not inside either
    // session's tree — judging must never pollute the trees it diffs.
    const judgingTip = await plumbing.resolveRef(fastify.engine.gitDir, "refs/judging/records");
    expect(judgingTip).toMatch(/^[0-9a-f]{40}$/);
  });

  test("re-judging the same pair upserts the existing record rather than duplicating it", async () => {
    const runSession = await login("standard-day");
    const referenceSession = await login("standard-day");

    await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession, referenceSession },
    });
    await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession, referenceSession, notes: "second pass" },
    });

    const response = await fastify.inject({
      method: "GET",
      url: `/sandbox/judgments?runSession=${runSession}`,
    });
    const { judgments } = response.json();
    expect(judgments).toHaveLength(1);
    expect(judgments[0]).toMatchObject({ notes: "second pass" });
  });

  test("judging against an unknown session 404s", async () => {
    const referenceSession = await login("standard-day");
    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession: "no-such-session", referenceSession },
    });
    expect(response.statusCode).toBe(404);
  });

  test("judging across mismatched scenarios 400s", async () => {
    const runSession = await login("standard-day");
    const referenceSession = await login("rush-hour");

    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/judge",
      payload: { runSession, referenceSession },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      runScenario: "standard-day",
      referenceScenario: "rush-hour",
    });
  });
});

describe("POST /sandbox/regression — replay-based regression evals", () => {
  test("replaying a deterministic prior run against this facade version shows no divergence", async () => {
    const sessionKey = await login("standard-day");
    await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/accept",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/start",
      headers: { [SESSION_HEADER]: sessionKey },
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/regression",
      payload: { sessionKey },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ sessionKey, scenario: "standard-day", deterministic: true });
    expect(body.divergentSteps).toEqual([]);
    expect(body.replaySessionKey).not.toBe(sessionKey);
  });

  test("a behavior change between facade versions is caught as a divergence", async () => {
    // A separate app instance carrying the deliberately nondeterministic
    // route (src/tests/support/nondeterministic-routes.ts — the same
    // clock-leak violation src/tests/replay.test.ts's "determinism guard"
    // exercises directly against engine/replay.ts) — this test proves the
    // SAME detection is reachable through the /sandbox/regression HTTP
    // convention, standing in for "a new agent/facade version" whose
    // behavior has drifted from a recorded run.
    const fixtures = scaffoldFixtures();
    const regressionApp = await buildTestApp({
      env: { FIXTURES_PATH: fixtures.root },
      registerRoutes: (app) => registerNondeterministicRoutes(app),
    });
    try {
      const login = await regressionApp.inject({
        method: "POST",
        url: "/session/login",
        payload: { scenario: fixtures.scenario },
      });
      const { sessionKey } = login.json();
      await regressionApp.inject({
        method: "POST",
        url: "/examples/alpha/stamp-now",
        headers: { [SESSION_HEADER]: sessionKey },
      });

      // Ensure real wall-clock time actually advances between the original
      // request and the replay (Date.now() has ms resolution).
      await new Promise((resolve) => setTimeout(resolve, 20));

      const response = await regressionApp.inject({
        method: "POST",
        url: "/sandbox/regression",
        payload: { sessionKey },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.deterministic).toBe(false);
      expect(body.divergentSteps).toHaveLength(1);
      expect(body.divergentSteps[0]).toMatchObject({
        index: 0,
        path: "/examples/alpha/stamp-now",
      });
    } finally {
      await regressionApp.close();
    }
  });

  test("replaying an unknown session 404s", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/sandbox/regression",
      payload: { sessionKey: "no-such-session" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("reference sessions can be pinned against the TTL sweep", () => {
  test("a pinned reference session survives a sweep that reclaims its unpinned candidate runs", async () => {
    const runsResponse = await fastify.inject({
      method: "POST",
      url: "/sandbox/runs",
      payload: { scenario: "standard-day", count: 1 },
    });
    const [reference] = runsResponse.json().runs as { sessionKey: string }[];

    const candidatesResponse = await fastify.inject({
      method: "POST",
      url: "/sandbox/runs",
      payload: { scenario: "standard-day", count: 2 },
    });
    const candidates = candidatesResponse.json().runs as { sessionKey: string }[];

    await fastify.sessionGc.pin(reference!.sessionKey);
    expect(await fastify.sessionGc.isPinned(reference!.sessionKey)).toBe(true);

    const sweep = await sweepExpiredSessions({
      gitDir: fastify.engine.gitDir,
      ttlMs: 1000,
      now: () => Date.now() + 6 * 60 * 60 * 1000,
    });

    expect(sweep.skippedPinned).toEqual([reference!.sessionKey]);
    expect(sweep.swept.sort()).toEqual(candidates.map((c) => c.sessionKey).sort());

    // The reference session's world is still readable after the sweep; the
    // candidates' refs are gone.
    const referenceRead = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: reference!.sessionKey },
    });
    expect(referenceRead.statusCode).toBe(200);

    const candidateRead = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: candidates[0]!.sessionKey },
    });
    expect(candidateRead.statusCode).toBe(400); // no resolved session — its ref was swept
  });
});
