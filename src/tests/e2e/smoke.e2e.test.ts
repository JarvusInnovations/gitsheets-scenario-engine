// The over-the-wire smoke tier, per specs/facade.md § E2E harness: "A thin
// over-the-wire smoke tier keeps `inject` honest." `fastify.inject()` never
// opens a socket — it drives route handlers in-process (see
// src/tests/git-http.test.ts's module doc, which hit this same limitation
// for git's smart-HTTP protocol) — so a suite that ONLY uses inject could
// silently depend on inject-only behavior (header casing, body framing,
// content-type negotiation, connection handling) that diverges over a real
// socket. This file re-runs a thin slice of the state machine flow through
// `harness.ts`'s `socketClient()` against a real `fastify.listen()` socket,
// via plain `fetch()` — no git protocol needed here (contrast
// git-http.test.ts, which needs the real `git` CLI specifically), so
// `fetch()` is enough to prove the wire path.
//
// Deliberately thin: full behavioral coverage (every status code, every
// scenario) stays in the inject-based suites (state-machine.e2e.test.ts,
// demo-world.test.ts) where it's cheap and fully parallel; this file only
// re-covers the one thing only a socket can prove.
import { afterEach, beforeEach, describe, expect } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers.ts";
import { e2eTest, login, socketClient } from "./harness.ts";
import type { OrderRecord } from "../../routes/orders.ts";

let fastify: FastifyInstance;
let baseUrl: string;

beforeEach(async () => {
  fastify = await buildTestApp();
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real TCP socket address from fastify.listen");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await fastify.close();
});

describe("smoke: the demo world over a real socket", () => {
  e2eTest("login -> accept -> read, over fetch() against a listening socket", async () => {
    const client = socketClient(baseUrl);
    const session = await login(client, fastify, "standard-day");
    const before = await session.commitCount();

    const accept = await session.request({ method: "POST", url: "/orders/order-1001/accept" });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json<OrderRecord>();
    expect(accepted).toMatchObject({ id: "order-1001", status: "accepted" });

    const read = await session.request({ method: "GET", url: "/orders/order-1001" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: "order-1001", status: "accepted", source: "offline" });

    // Both surfaces, exactly as the inject tier asserts — proving the smoke
    // tier isn't just a thinner copy of inject behavior but the SAME
    // dual-surface contract over a different transport.
    expect(await session.commitCount()).toBe(before + 1);
    const record = await session.record<OrderRecord>("orders", { id: "order-1001" });
    expect(record).toMatchObject({ status: "accepted", courier_id: accepted.courier_id });
  });

  e2eTest("an unauthenticated request (no session header) 400s over the wire", async () => {
    const response = await fetch(`${baseUrl}/orders/order-1001/notifications`);
    // No SESSION_HEADER attached — registerDemoRoutes-style routes 400 on a
    // missing session; the shipped orders route (offline-only, wrapped by
    // registerModeRoute) resolves no session and 4xx's rather than serving
    // world state to an unauthenticated caller.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
