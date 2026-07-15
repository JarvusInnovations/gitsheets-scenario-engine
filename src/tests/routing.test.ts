import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  scaffoldFixtures,
  scaffoldRegistry,
  type RegistryEntryFixture,
} from "./helpers.ts";
import { registerRoutingDemoRoutes, catalogItemSchema } from "./support/routing-demo-routes.ts";
import { resolveBackend } from "../routing/mode.ts";
import { diffRegistry } from "../routing/validate-registry.ts";
import { readRegistry } from "../routing/registry-store.ts";
import { assertMatchesResponseSchema } from "../routing/schema-parity.ts";
import { SESSION_HEADER } from "../plugins/engine.ts";
import * as plumbing from "../engine/plumbing.ts";

const DEMO_LEDGER: RegistryEntryFixture[] = [
  {
    id: "post-catalog-slug-mark-legacy",
    method: "POST",
    path: "/catalog/:slug/mark-legacy",
    mode: "offline-only",
    behaviors: ["registry-demo: mark-legacy"],
  },
  {
    id: "get-catalog-slug-upstream",
    method: "GET",
    path: "/catalog/:slug/upstream",
    mode: "online-only",
    behaviors: ["registry-demo: upstream-lookup"],
  },
  {
    id: "get-catalog-slug",
    method: "GET",
    path: "/catalog/:slug",
    mode: "dual",
    behaviors: ["registry-demo: catalog-lookup"],
  },
  // The demo world's routes (src/routes/orders.ts, src/routes/couriers.ts)
  // are permanent app.ts routes now, not test-injected ones — every
  // buildTestApp() call in this describe block boots the WHOLE app, so its
  // scaffolded registry must carry these too or the boot-time drift check
  // (this very mechanism) correctly flags them as missing. Mirrors
  // registry/routes/*.toml verbatim (method/path/mode is all diffRegistry
  // checks).
  {
    id: "get-order",
    method: "GET",
    path: "/orders/:id",
    mode: "dual",
    behaviors: ["demo-world: order-lookup"],
  },
  {
    id: "get-order-notifications",
    method: "GET",
    path: "/orders/:id/notifications",
    mode: "offline-only",
    behaviors: ["demo-world: order-notifications"],
  },
  {
    id: "post-order-accept",
    method: "POST",
    path: "/orders/:id/accept",
    mode: "offline-only",
    behaviors: ["demo-world: order-accept"],
  },
  {
    id: "post-order-start",
    method: "POST",
    path: "/orders/:id/start",
    mode: "offline-only",
    behaviors: ["demo-world: order-start"],
  },
  {
    id: "post-order-complete",
    method: "POST",
    path: "/orders/:id/complete",
    mode: "offline-only",
    behaviors: ["demo-world: order-complete"],
  },
  {
    id: "get-courier-upstream",
    method: "GET",
    path: "/couriers/:id/upstream",
    mode: "online-only",
    behaviors: ["demo-world: courier-upstream-lookup"],
  },
];

describe("resolveBackend (pure)", () => {
  test("offline-only and online-only are fixed regardless of session/deployment", () => {
    expect(
      resolveBackend({
        routeMode: "offline-only",
        sessionBackendOverride: "online",
        deploymentDefault: "online",
      }),
    ).toBe("offline");
    expect(
      resolveBackend({
        routeMode: "online-only",
        sessionBackendOverride: "offline",
        deploymentDefault: "offline",
      }),
    ).toBe("online");
  });

  test("dual falls back to the deployment default with no session override", () => {
    expect(resolveBackend({ routeMode: "dual", deploymentDefault: "offline" })).toBe("offline");
    expect(resolveBackend({ routeMode: "dual", deploymentDefault: "online" })).toBe("online");
  });

  test("dual honors a valid session override over the deployment default", () => {
    expect(
      resolveBackend({
        routeMode: "dual",
        sessionBackendOverride: "online",
        deploymentDefault: "offline",
      }),
    ).toBe("online");
  });

  test("an invalid/garbage session override is ignored", () => {
    expect(
      resolveBackend({
        routeMode: "dual",
        sessionBackendOverride: "bogus",
        deploymentDefault: "offline",
      }),
    ).toBe("offline");
  });

  test("no declared mode resolves to undefined", () => {
    expect(resolveBackend({ routeMode: undefined, deploymentDefault: "offline" })).toBeUndefined();
  });
});

describe("diffRegistry (pure)", () => {
  test("agreement produces no drift", () => {
    const drift = diffRegistry(
      [{ method: "GET", path: "/x", mode: "dual" }],
      [{ id: "x", method: "GET", path: "/x", mode: "dual", behaviors: ["b"] }],
    );
    expect(drift).toEqual([]);
  });

  test("a registered route missing from the ledger is drift", () => {
    const drift = diffRegistry([{ method: "GET", path: "/x", mode: "dual" }], []);
    expect(drift).toEqual([
      'GET /x: registered in code with mode "dual" but has no parity ledger entry',
    ]);
  });

  test("a stale ledger entry with no matching route is drift", () => {
    const drift = diffRegistry(
      [],
      [{ id: "x", method: "GET", path: "/x", mode: "dual", behaviors: ["b"] }],
    );
    expect(drift).toEqual(['GET /x: ledger entry (mode "dual") has no matching registered route']);
  });

  test("a mode mismatch between code and ledger is drift", () => {
    const drift = diffRegistry(
      [{ method: "GET", path: "/x", mode: "online-only" }],
      [{ id: "x", method: "GET", path: "/x", mode: "dual", behaviors: ["b"] }],
    );
    expect(drift).toEqual(['GET /x: code declares mode "online-only" but the ledger says "dual"']);
  });
});

describe("boot-time registry↔routes drift check", () => {
  let fixtures: { root: string; scenario: string };

  beforeEach(() => {
    fixtures = scaffoldFixtures();
  });

  test("a ledger that agrees with the registered routes boots cleanly", async () => {
    const registry = scaffoldRegistry(DEMO_LEDGER);
    const fastify = await buildTestApp({
      env: { FIXTURES_PATH: fixtures.root, REGISTRY_PATH: registry.root },
      registerRoutes: registerRoutingDemoRoutes,
    });
    await fastify.close();
  });

  test("a registered route with no ledger entry fails boot", async () => {
    const registry = scaffoldRegistry(DEMO_LEDGER.slice(1)); // drop the offline-only entry
    await expect(
      buildTestApp({
        env: { FIXTURES_PATH: fixtures.root, REGISTRY_PATH: registry.root },
        registerRoutes: registerRoutingDemoRoutes,
      }),
    ).rejects.toThrow(/registry drift/);
  });

  test("a stale ledger entry with no matching route fails boot", async () => {
    const registry = scaffoldRegistry([
      ...DEMO_LEDGER,
      {
        id: "stale-entry",
        method: "DELETE",
        path: "/nowhere",
        mode: "offline-only",
        behaviors: ["orphaned"],
      },
    ]);
    await expect(
      buildTestApp({
        env: { FIXTURES_PATH: fixtures.root, REGISTRY_PATH: registry.root },
        registerRoutes: registerRoutingDemoRoutes,
      }),
    ).rejects.toThrow(/registry drift/);
  });

  test("a mode mismatch between code and ledger fails boot", async () => {
    const mismatched = DEMO_LEDGER.map((e) =>
      e.id === "post-catalog-slug-mark-legacy" ? { ...e, mode: "dual" as const } : e,
    );
    const registry = scaffoldRegistry(mismatched);
    await expect(
      buildTestApp({
        env: { FIXTURES_PATH: fixtures.root, REGISTRY_PATH: registry.root },
        registerRoutes: registerRoutingDemoRoutes,
      }),
    ).rejects.toThrow(/registry drift/);
  });
});

describe("mode dispatch end-to-end", () => {
  let fixtures: { root: string; scenario: string };
  let registry: { root: string };
  let fastify: FastifyInstance;

  beforeEach(async () => {
    fixtures = scaffoldFixtures();
    registry = scaffoldRegistry(DEMO_LEDGER);
    fastify = await buildTestApp({
      env: { FIXTURES_PATH: fixtures.root, REGISTRY_PATH: registry.root },
      registerRoutes: registerRoutingDemoRoutes,
    });
  });

  afterEach(async () => {
    await fastify.close();
  });

  test("an offline-only route serves engine behavior and commits", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const beforeLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);

    const response = await fastify.inject({
      method: "POST",
      url: "/catalog/alpha/mark-legacy",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ slug: "alpha", legacy: true });

    const afterLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);
    expect(afterLog.length).toBe(beforeLog.length + 1); // exactly one commit
  });

  test("an offline-only route without a session is rejected before any commit is attempted", async () => {
    const response = await fastify.inject({ method: "POST", url: "/catalog/alpha/mark-legacy" });
    expect(response.statusCode).toBe(400);
  });

  test("an online-only route proxies without a session and without touching the runtime store", async () => {
    const response = await fastify.inject({ method: "GET", url: "/catalog/alpha/upstream" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ slug: "alpha", source: "online" });
  });

  test("a dual route selects offline via the deployment default with no session override", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const response = await fastify.inject({
      method: "GET",
      url: "/catalog/alpha",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ slug: "alpha", source: "offline" });
    assertMatchesResponseSchema(catalogItemSchema, body);
  });

  test("a dual route honors a per-session login-time override to online", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario, { modeOverride: "online" });
    const beforeLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);

    const response = await fastify.inject({
      method: "GET",
      url: "/catalog/alpha",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ slug: "alpha", source: "online", touches: 0 });
    assertMatchesResponseSchema(catalogItemSchema, body);

    // The online branch never touches gitsheets — no commit lands even
    // though a session exists.
    const afterLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);
    expect(afterLog).toEqual(beforeLog);
  });

  test("the SAME response schema validates both an offline and an online response for the dual route", async () => {
    const offlineFork = await fastify.engine.fork(fixtures.scenario);
    const onlineFork = await fastify.engine.fork(fixtures.scenario, { modeOverride: "online" });

    const offlineBody = (
      await fastify.inject({
        method: "GET",
        url: "/catalog/alpha",
        headers: { [SESSION_HEADER]: offlineFork.sessionKey },
      })
    ).json();
    const onlineBody = (
      await fastify.inject({
        method: "GET",
        url: "/catalog/alpha",
        headers: { [SESSION_HEADER]: onlineFork.sessionKey },
      })
    ).json();

    expect(offlineBody.source).toBe("offline");
    expect(onlineBody.source).toBe("online");
    assertMatchesResponseSchema(catalogItemSchema, offlineBody);
    assertMatchesResponseSchema(catalogItemSchema, onlineBody);
  });

  test("a dual route falls back to an online deployment default with no session at all", async () => {
    const onlineDefaultFastify = await buildTestApp({
      env: {
        FIXTURES_PATH: fixtures.root,
        REGISTRY_PATH: registry.root,
        DEFAULT_DUAL_MODE: "online",
      },
      registerRoutes: registerRoutingDemoRoutes,
    });
    try {
      const response = await onlineDefaultFastify.inject({ method: "GET", url: "/catalog/alpha" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ slug: "alpha", source: "online", touches: 0 });
    } finally {
      await onlineDefaultFastify.close();
    }
  });

  test("the parity ledger is a real, queryable gitsheet", async () => {
    const entries = await readRegistry(fastify.engine);
    expect(entries).toHaveLength(DEMO_LEDGER.length);
    const bySlug = new Map(entries.map((e) => [e.id, e]));
    expect(bySlug.get("get-catalog-slug")).toMatchObject({
      method: "GET",
      path: "/catalog/:slug",
      mode: "dual",
      behaviors: ["registry-demo: catalog-lookup"],
    });
    expect(bySlug.get("post-catalog-slug-mark-legacy")).toMatchObject({ mode: "offline-only" });
    expect(bySlug.get("get-catalog-slug-upstream")).toMatchObject({ mode: "online-only" });
  });
});
