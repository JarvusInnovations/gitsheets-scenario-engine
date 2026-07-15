// The demo world (plans/demo-world.md): exercises the shipped fixtures
// (fixtures/base + fixtures/scenarios/{standard-day,rush-hour}) and routes
// (src/routes/{session,orders,couriers}.ts) as the running app actually
// serves them — no scratch fixtures/registry overrides here, unlike
// engine.test.ts / routing.test.ts, which deliberately test the generic
// mechanism in isolation from real content. This suite is the mechanism's
// worked example: "booting the demo imports both scenarios deterministically"
// (plans/demo-world.md § Validation), the order state machine's commit
// sequence + terminal record state, and the all-state-in-records discipline
// proven via a clone + replay.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers.ts";
import { SESSION_HEADER } from "../plugins/engine.ts";
import { runBootImport, baselineRef } from "../engine/boot-import.ts";
import * as plumbing from "../engine/plumbing.ts";
import { replaySession } from "../engine/replay.ts";
import { fastifyInjectExecutor } from "../engine/replay-fastify.ts";
import type { OrderRecord } from "../routes/orders.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dir, "../../fixtures");

let fastify: FastifyInstance;

beforeEach(async () => {
  // No env overrides: boots against the real fixtures/ and registry/ trees
  // this plan ships — the point is proving the SHIPPED demo world works,
  // not a scaffolded stand-in.
  fastify = await buildTestApp();
});

afterEach(async () => {
  await fastify.close();
});

describe("boot: both scenarios import deterministically", () => {
  test("standard-day and rush-hour each produce a baseline ref", async () => {
    const gitDir = fastify.engine.gitDir;
    expect(await plumbing.resolveRef(gitDir, baselineRef("standard-day"))).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(await plumbing.resolveRef(gitDir, baselineRef("rush-hour"))).toMatch(/^[0-9a-f]{40}$/);
  });

  test("two independent boots of the shipped fixtures agree byte-for-byte on both scenarios", async () => {
    const gitDirA = path.join(mkdtempSync(path.join(tmpdir(), "demo-boot-a-")), "runtime.git");
    const gitDirB = path.join(mkdtempSync(path.join(tmpdir(), "demo-boot-b-")), "runtime.git");

    const resultA = await runBootImport({ gitDir: gitDirA, fixturesRoot: FIXTURES_ROOT });
    const resultB = await runBootImport({ gitDir: gitDirB, fixturesRoot: FIXTURES_ROOT });

    expect([...resultA.baselines.keys()].sort()).toEqual(["rush-hour", "standard-day"]);
    expect(resultA.baselines.get("standard-day")).toBe(resultB.baselines.get("standard-day")!);
    expect(resultA.baselines.get("rush-hour")).toBe(resultB.baselines.get("rush-hour")!);
  });
});

describe("login (POST /session/login)", () => {
  test("forks a session from a named scenario and returns its key", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.sessionKey).toMatch(/^[a-z0-9-]+$/);
    expect(body.scenario).toBe("standard-day");

    // The returned key is immediately usable on SESSION_HEADER.
    const read = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: body.sessionKey },
    });
    expect(read.statusCode).toBe(200);
  });

  test("an unknown scenario is rejected with 404", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "no-such-scenario" },
    });
    expect(response.statusCode).toBe(404);
  });

  test("a login-time modeOverride pins a dual route's backend for the session", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day", modeOverride: "online" },
    });
    const { sessionKey } = login.json();

    const response = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(response.json()).toMatchObject({ source: "online" });
  });
});

describe("GET /orders/:id (dual)", () => {
  test("offline (deployment default) reads the session's world", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    const { sessionKey } = login.json();

    const response = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "order-1001",
      status: "pending",
      priority: "standard",
      source: "offline",
    });
  });

  test("an unknown order 404s", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    const { sessionKey } = login.json();

    const response = await fastify.inject({
      method: "GET",
      url: "/orders/no-such-order",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /couriers/:id/upstream (online-only)", () => {
  test("proxies without a session and without touching the runtime store", async () => {
    const response = await fastify.inject({ method: "GET", url: "/couriers/alex/upstream" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "alex", source: "online" });
  });
});

describe("the order state machine: accept -> start -> complete", () => {
  test("produces exactly three commits and reaches terminal record state", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    const { sessionKey } = login.json();
    const fork = { sessionKey, ref: `refs/sessions/${sessionKey}` };
    const gitDir = fastify.engine.gitDir;

    const beforeLog = await plumbing.firstParentLog(gitDir, fork.ref);

    const accept = await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/accept",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json() as OrderRecord;
    expect(accepted.status).toBe("accepted");
    expect(accepted.courier_id).toBeDefined();

    const start = await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/start",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(start.statusCode).toBe(200);
    expect((start.json() as OrderRecord).status).toBe("in-progress");

    const complete = await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/complete",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(complete.statusCode).toBe(200);
    const completed = complete.json() as OrderRecord;
    expect(completed.status).toBe("completed");

    // Exactly one commit per transition — request = commit
    // (specs/scenario-engine.md § Request = commit).
    const afterLog = await plumbing.firstParentLog(gitDir, fork.ref);
    expect(afterLog.length).toBe(beforeLog.length + 3);

    // Terminal record state, read straight off the session ref.
    const courierId = accepted.courier_id!;
    const finalOrder = await fastify.engine.sessionRead(sessionKey, (tx) =>
      tx.sheet<OrderRecord>("orders").queryFirst({ id: "order-1001" }),
    );
    expect(finalOrder).toMatchObject({ status: "completed", courier_id: courierId });

    const courier = await fastify.engine.sessionRead(sessionKey, (tx) =>
      tx.sheet("couriers").queryFirst({ id: courierId }),
    );
    expect(courier).toMatchObject({ status: "available" }); // freed back up on completion

    const notifications = await fastify.engine.sessionRead(sessionKey, (tx) =>
      tx.sheet("notifications").queryAll({ order_id: "order-1001" }),
    );
    expect(notifications).toHaveLength(3); // one per transition
  });

  test("transitions out of order are rejected with 409, not silently accepted", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    const { sessionKey } = login.json();

    // order-1001 starts pending — starting it before accept is a state
    // violation.
    const response = await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/start",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: "pending" });
  });

  test("GET /orders/:id/notifications lists the emitted side effects", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    const { sessionKey } = login.json();

    await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/accept",
      headers: { [SESSION_HEADER]: sessionKey },
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/orders/order-1001/notifications",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(response.statusCode).toBe(200);
    const { notifications } = response.json();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ order_id: "order-1001", channel: "push" });
  });
});

describe("rush-hour: the divergent scenario", () => {
  test("only one courier is free — the second rush order can't be accepted", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "rush-hour" },
    });
    const { sessionKey } = login.json();

    const first = await fastify.inject({
      method: "POST",
      url: "/orders/order-2001/accept",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ courier_id: "alex" }); // the only available courier

    const second = await fastify.inject({
      method: "POST",
      url: "/orders/order-2002/accept",
      headers: { [SESSION_HEADER]: sessionKey },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "no couriers available" });
  });
});

describe("all-state-in-records: clone + replay reproduces a demo session exactly", () => {
  test("replaying the state-machine flow against a fresh fork yields byte-identical trees at every step", async () => {
    const login = await fastify.inject({
      method: "POST",
      url: "/session/login",
      payload: { scenario: "standard-day" },
    });
    const { sessionKey } = login.json();

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
    await fastify.inject({
      method: "POST",
      url: "/orders/order-1001/complete",
      headers: { [SESSION_HEADER]: sessionKey },
    });

    const result = await replaySession(fastify.engine, sessionKey, fastifyInjectExecutor(fastify));

    expect(result.deterministic).toBe(true);
    expect(result.divergences).toEqual([]);
    expect(result.steps).toHaveLength(3);

    // Belt-and-suspenders: the two sessions' final tip trees also match, not
    // just the per-step diff.
    const gitDir = fastify.engine.gitDir;
    const originalTip = await plumbing.resolveRef(gitDir, `refs/sessions/${sessionKey}`);
    const replayTip = await plumbing.resolveRef(gitDir, result.replayRef);
    const originalTree = await plumbing.treeOf(gitDir, originalTip!);
    const replayTree = await plumbing.treeOf(gitDir, replayTip!);
    expect(replayTree).toBe(originalTree);
  });

  test("cloning the session over the git-exposure endpoint materializes the identical tree — nothing lives outside records", async () => {
    // A separate, real-socket app instance (git needs an actual TCP
    // listener — `fastify.inject()` never opens one; see
    // src/tests/git-http.test.ts, whose pattern this mirrors), with git
    // exposure enabled, so the clone goes through the SAME read-only
    // smart-HTTP path a developer debugging a field report would use
    // (specs/facade.md § Git exposure) rather than reaching into the
    // runtime gitDir directly.
    const TOKEN = "demo-world-clone-probe-token";
    const exposedApp = await buildTestApp({ env: { GIT_EXPOSURE_TOKEN: TOKEN } });
    try {
      await exposedApp.listen({ port: 0, host: "127.0.0.1" });
      const address = exposedApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real TCP socket address from fastify.listen");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const login = await exposedApp.inject({
        method: "POST",
        url: "/session/login",
        payload: { scenario: "standard-day" },
      });
      const { sessionKey } = login.json();
      const sessionRef = `refs/sessions/${sessionKey}`;

      await exposedApp.inject({
        method: "POST",
        url: "/orders/order-1001/accept",
        headers: { [SESSION_HEADER]: sessionKey },
      });

      const originalTip = await plumbing.resolveRef(exposedApp.engine.gitDir, sessionRef);
      if (!originalTip) throw new Error("expected the session ref to resolve after accept");
      const originalTree = await plumbing.treeOf(exposedApp.engine.gitDir, originalTip);

      const clientDir = mkdtempSync(path.join(tmpdir(), "demo-session-clone-"));
      const init = Bun.spawn({ cmd: ["git", "init", "-q", "."], cwd: clientDir });
      expect(await init.exited).toBe(0);
      const fetch = Bun.spawn({
        cmd: [
          "git",
          "-c",
          `http.extraHeader=Authorization: Bearer ${TOKEN}`,
          "fetch",
          "-q",
          `${baseUrl}/git`,
          `${sessionRef}:refs/heads/clone-probe`,
        ],
        cwd: clientDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const fetchErr = await new Response(fetch.stderr).text();
      expect(await fetch.exited, fetchErr).toBe(0);

      const clonedTree = await plumbing.treeOf(clientDir, "refs/heads/clone-probe^{tree}");
      expect(clonedTree).toBe(originalTree);

      // The clone reads back the exact order the accept transition wrote —
      // no side channel, no process memory, just the tree.
      const catFile = Bun.spawn({
        cmd: ["git", "show", `refs/heads/clone-probe:orders/order-1001.toml`],
        cwd: clientDir,
        stdout: "pipe",
      });
      const cloned = await new Response(catFile.stdout).text();
      expect(await catFile.exited).toBe(0);
      expect(cloned).toContain('status = "accepted"');
    } finally {
      await exposedApp.close();
    }
  });
});
