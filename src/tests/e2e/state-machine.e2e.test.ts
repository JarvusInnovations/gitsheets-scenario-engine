// The e2e harness's own worked example, per specs/facade.md § E2E harness's
// example verbatim: "the accept flow produced exactly 2 commits;
// `orders/1234` reached `state=accepted`; the notification record exists."
// Exercises the SHIPPED demo world (fixtures/, no scaffolded overrides —
// same discipline as src/tests/demo-world.test.ts) via the harness
// (harness.ts) instead of hand-rolled fastify.inject() calls, so this file
// doubles as the harness's usage example other e2e suites copy from.
//
// Deliberately drives order-1002 (standard-day's *other* pending order,
// priority "rush") rather than order-1001 — demo-world.test.ts already
// covers order-1001 exhaustively; this file's job is proving the harness,
// not re-covering the same fixture record.
import { afterEach, beforeEach, describe, expect } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers.ts";
import { e2eTest, loginInject } from "./harness.ts";
import type { OrderRecord } from "../../routes/orders.ts";

let fastify: FastifyInstance;

beforeEach(async () => {
  // No env overrides — the real, shipped fixtures/ tree, per
  // specs/facade.md § E2E harness: "tests always exercise the fixture state
  // of the commit under test."
  fastify = await buildTestApp();
});

afterEach(async () => {
  await fastify.close();
});

describe("e2e harness: accept -> start -> complete (standard-day, order-1002)", () => {
  e2eTest("each transition is exactly one commit; both surfaces agree at every step", async () => {
    const session = await loginInject(fastify, "standard-day");
    const before = await session.commitCount();

    // --- accept ---
    const accept = await session.request({ method: "POST", url: "/orders/order-1002/accept" });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json<OrderRecord>();
    expect(accepted).toMatchObject({ id: "order-1002", status: "accepted" });
    expect(accepted.courier_id).toBeDefined();

    expect(await session.commitCount()).toBe(before + 1); // "the accept flow produced exactly 1 commit"

    const acceptedRecord = await session.record<OrderRecord>("orders", { id: "order-1002" });
    expect(acceptedRecord).toMatchObject({ status: "accepted", courier_id: accepted.courier_id });

    const acceptNotifications = await session.records("notifications", { order_id: "order-1002" });
    expect(acceptNotifications).toHaveLength(1); // "the notification record exists"

    // --- start ---
    const start = await session.request({ method: "POST", url: "/orders/order-1002/start" });
    expect(start.statusCode).toBe(200);
    expect(start.json<OrderRecord>().status).toBe("in-progress");
    expect(await session.commitCount()).toBe(before + 2);

    // --- complete ---
    const complete = await session.request({ method: "POST", url: "/orders/order-1002/complete" });
    expect(complete.statusCode).toBe(200);
    expect(complete.json<OrderRecord>().status).toBe("completed");
    expect(await session.commitCount()).toBe(before + 3); // exactly 3 commits for 3 transitions

    // Terminal record state, read straight off the session ref (not the
    // HTTP response) — the record-surface half of the assertion.
    const finalOrder = await session.record<OrderRecord>("orders", { id: "order-1002" });
    expect(finalOrder).toMatchObject({ status: "completed", courier_id: accepted.courier_id });

    const courier = await session.record("couriers", { id: accepted.courier_id });
    expect(courier).toMatchObject({ status: "available" }); // freed back up on completion

    const notifications = await session.records("notifications", { order_id: "order-1002" });
    expect(notifications).toHaveLength(3); // one per transition
  });

  e2eTest("an out-of-order transition 409s and produces no commit", async () => {
    const session = await loginInject(fastify, "standard-day");
    const before = await session.commitCount();

    // order-1002 starts pending — completing it before accept/start is a
    // state violation, and per specs/scenario-engine.md § Request = commit
    // a rejected transition must not silently land as a no-op commit either.
    const response = await session.request({ method: "POST", url: "/orders/order-1002/complete" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: "pending" });
    expect(await session.commitCount()).toBe(before);
  });
});

describe("e2e harness: rush-hour divergence", () => {
  e2eTest("the second rush order 409s once the roster is exhausted", async () => {
    const session = await loginInject(fastify, "rush-hour");

    const first = await session.request({ method: "POST", url: "/orders/order-2001/accept" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ courier_id: "alex" }); // the only available courier

    const second = await session.request({ method: "POST", url: "/orders/order-2002/accept" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "no couriers available" });

    // Confirmed on the record surface too, not just the HTTP response.
    const order2002 = await session.record<OrderRecord>("orders", { id: "order-2002" });
    expect(order2002).toMatchObject({ status: "pending" });
  });
});
