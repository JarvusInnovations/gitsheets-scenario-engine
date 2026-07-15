import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp, scaffoldFixtures } from "./helpers.ts";
import { registerDemoRoutes } from "./support/demo-routes.ts";
import { registerNondeterministicRoutes } from "./support/nondeterministic-routes.ts";
import { SESSION_HEADER } from "../plugins/engine.ts";
import { runEventCommit } from "../engine/request-commit.ts";
import * as plumbing from "../engine/plumbing.ts";
import { parseSessionLog, replaySession, UnsupportedReplayStepError } from "../engine/replay.ts";
import { fastifyInjectExecutor } from "../engine/replay-fastify.ts";

let fixtures: { root: string; scenario: string };
let fastify: FastifyInstance;

beforeEach(async () => {
  fixtures = scaffoldFixtures();
  fastify = await buildTestApp({
    env: { FIXTURES_PATH: fixtures.root },
    registerRoutes: async (app) => {
      await registerDemoRoutes(app);
      await registerNondeterministicRoutes(app);
    },
  });
});

afterEach(async () => {
  await fastify.close();
});

describe("parseSessionLog", () => {
  test("reconstructs method, path, and request body from a request=commit message, skipping root/fork commits", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });

    const log = await parseSessionLog(fastify.engine.gitDir, fork.sessionKey);

    expect(log.scenario).toBe(fixtures.scenario);
    expect(log.steps).toHaveLength(1);
    expect(log.steps[0]).toMatchObject({
      kind: "request",
      method: "POST",
      path: "/examples/alpha/touch",
      requestBody: null, // demo route's touch handler reads no body
      originalResponseCode: "200",
    });
  });

  test("orders steps oldest -> newest across multiple requests", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });
    await fastify.inject({
      method: "POST",
      url: "/examples/beta/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });

    const log = await parseSessionLog(fastify.engine.gitDir, fork.sessionKey);
    expect(log.steps.map((s) => (s.kind === "request" ? s.path : s.kind))).toEqual([
      "/examples/alpha/touch",
      "/examples/beta/touch",
    ]);
  });

  test("EVENT commits are parsed as event steps", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    await runEventCommit(
      fastify.engine,
      { sessionKey: fork.sessionKey, scenario: fixtures.scenario, eventName: "advance-clock" },
      async (tx) => {
        const sheet = tx.sheet<{ slug: string; touches?: number }>("examples");
        const existing = await sheet.queryFirst({ slug: "alpha" });
        await sheet.upsert({ ...existing!, touches: (existing?.touches ?? 0) + 1 });
      },
    );

    const log = await parseSessionLog(fastify.engine.gitDir, fork.sessionKey);
    expect(log.steps).toEqual([
      { kind: "event", commitHash: expect.any(String), eventName: "advance-clock" },
    ]);
  });
});

describe("replaySession", () => {
  test("replaying a recorded session against a fresh fork reproduces byte-identical trees", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });
    await fastify.inject({
      method: "POST",
      url: "/examples/beta/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });

    const result = await replaySession(
      fastify.engine,
      fork.sessionKey,
      fastifyInjectExecutor(fastify),
    );

    expect(result.deterministic).toBe(true);
    expect(result.divergences).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.replaySessionKey).not.toBe(fork.sessionKey);

    // Belt-and-suspenders: the two sessions' final tip trees also match,
    // not just the per-step diff.
    const originalTip = await plumbing.resolveRef(fastify.engine.gitDir, fork.ref);
    const replayTip = await plumbing.resolveRef(fastify.engine.gitDir, result.replayRef);
    const originalTree = await plumbing.treeOf(fastify.engine.gitDir, originalTip!);
    const replayTree = await plumbing.treeOf(fastify.engine.gitDir, replayTip!);
    expect(replayTree).toBe(originalTree);
  });

  test("an EVENT commit in the log is rejected — no generic re-invocation path yet", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    await runEventCommit(
      fastify.engine,
      { sessionKey: fork.sessionKey, scenario: fixtures.scenario, eventName: "advance-clock" },
      async (tx) => {
        const sheet = tx.sheet<{ slug: string; touches?: number }>("examples");
        const existing = await sheet.queryFirst({ slug: "alpha" });
        await sheet.upsert({ ...existing!, touches: (existing?.touches ?? 0) + 1 });
      },
    );

    await expect(
      replaySession(fastify.engine, fork.sessionKey, fastifyInjectExecutor(fastify)),
    ).rejects.toThrow(UnsupportedReplayStepError);
  });

  describe("determinism guard", () => {
    test("a clock leak into record content is caught as a replay divergence", async () => {
      const fork = await fastify.engine.fork(fixtures.scenario);
      await fastify.inject({
        method: "POST",
        url: "/examples/alpha/stamp-now",
        headers: { [SESSION_HEADER]: fork.sessionKey },
      });

      // Ensure real wall-clock time actually advances between the original
      // request and the replay — Date.now() has ms resolution, so this
      // margin makes a colliding timestamp for the nondeterministic route
      // effectively impossible.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await replaySession(
        fastify.engine,
        fork.sessionKey,
        fastifyInjectExecutor(fastify),
      );

      expect(result.deterministic).toBe(false);
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0]?.step).toMatchObject({ path: "/examples/alpha/stamp-now" });
      expect(result.divergences[0]?.originalTreeHash).not.toBe(
        result.divergences[0]?.replayedTreeHash,
      );
    });
  });
});
