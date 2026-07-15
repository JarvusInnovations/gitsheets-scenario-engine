// The demo world's non-trivial state machine: an order moves
// pending -> accepted -> in-progress -> completed entirely through plain
// handler code operating on records (specs/facade.md § Offline mode:
// "Behavior beyond CRUD... lives in plain handler code operating on
// records. The discipline: all state lands in records; anything in process
// memory is a bug — it breaks clone/replay fidelity."). Every transition:
//
//   - reads its own tick from the `clock` sheet (never Date.now()/a
//     module-level counter — see advanceClock() below and contrast with
//     src/tests/support/nondeterministic-routes.ts, the deliberate
//     counter-example),
//   - derives every id it writes (notification ids) from record fields
//     already in the transaction, never Math.random(),
//   - and emits a `notifications` record as its simulated side effect,
//
// so a clone of the session's runtime repo (or a replaySession() re-run —
// see src/engine/replay.ts) reproduces the exact same tree at every step.
import type { FastifyPluginAsync } from "fastify";
import type { Transaction } from "gitsheets";
import { registerModeRoute } from "../routing/register-route.ts";
import { createEchoAdapter } from "../routing/adapters.ts";

export interface OrderRecord {
  id: string;
  item: string;
  status: "pending" | "accepted" | "in-progress" | "completed" | "canceled";
  priority: "standard" | "rush";
  courier_id?: string;
  created_tick: number;
  updated_tick: number;
  [key: string]: unknown;
}

interface CourierRecord {
  id: string;
  name: string;
  status: "available" | "busy" | "offline";
  [key: string]: unknown;
}

interface NotificationRecord {
  id: string;
  order_id: string;
  channel: "push" | "sms" | "email";
  message: string;
  tick: number;
  [key: string]: unknown;
}

interface ClockRecord {
  id: string;
  tick: number;
  [key: string]: unknown;
}

/**
 * Advance the session's simulated clock by one tick and return the new
 * value — the one sanctioned source of "now" for record content
 * (specs/scenario-engine.md § Determinism and replay: "simulated time is a
 * record ... advanced by requests/events").
 */
async function advanceClock(tx: Transaction): Promise<number> {
  const sheet = tx.sheet<ClockRecord>("clock");
  const current = await sheet.queryFirst({ id: "clock" });
  const tick = (current?.tick ?? 0) + 1;
  await sheet.upsert({ id: "clock", tick });
  return tick;
}

/** Record a simulated push-notification side effect for an order transition. Id is derived from the order + tick — deterministic, not random. */
async function notify(
  tx: Transaction,
  order: OrderRecord,
  tick: number,
  message: string,
): Promise<void> {
  await tx.sheet<NotificationRecord>("notifications").upsert({
    id: `${order.id}-${tick}`,
    order_id: order.id,
    channel: "push",
    message,
    tick,
  });
}

/**
 * Shared response shape for GET /orders/:id (a `dual` route) — the
 * serializer-parity demo (specs/facade.md § Stack: "one schema serializes
 * both backends' responses, which is itself a contract-conformance check").
 */
export const orderViewSchema = {
  type: "object",
  required: ["id", "status", "source"],
  properties: {
    id: { type: "string" },
    item: { type: "string" },
    status: { type: "string" },
    priority: { type: "string" },
    courier_id: { type: "string" },
    source: { type: "string", enum: ["offline", "online"] },
  },
  additionalProperties: false,
} as const;

const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  // dual: runtime selection between the scenario engine and a (stubbed)
  // upstream order service. Both branches shape their body to
  // orderViewSchema.
  registerModeRoute(fastify, {
    method: "GET",
    url: "/orders/:id",
    mode: "dual",
    behaviors: ["demo-world: order-lookup"],
    schema: { response: { 200: orderViewSchema } },
    offline: async (request, _reply, tx) => {
      const { id } = request.params as { id: string };
      const order = await tx.sheet<OrderRecord>("orders").queryFirst({ id });
      if (!order) return { responseCode: 404, responseBody: { error: "order not found" } };
      return {
        responseCode: 200,
        responseBody: {
          id: order.id,
          item: order.item,
          status: order.status,
          priority: order.priority,
          courier_id: order.courier_id,
          source: "offline" as const,
        },
      };
    },
    // Online mode is the stub seam specs/facade.md § Online mode describes
    // — no real order-management upstream exists in this template yet. The
    // echo satisfies the SAME schema as the offline branch, which is the
    // point of the demo.
    adapter: createEchoAdapter(({ request }) => {
      const { id } = request.params as { id: string };
      return {
        responseCode: 200,
        responseBody: { id, status: "pending", priority: "standard", source: "online" as const },
      };
    }),
    online: async (request, _reply, adapter) => adapter.call({ request }),
  });

  // offline-only: "exists only as scenario behavior — the executable spec
  // for unbuilt backend work" (specs/facade.md § Mode model). Lists the
  // notification side effects the state machine below emitted.
  registerModeRoute(fastify, {
    method: "GET",
    url: "/orders/:id/notifications",
    mode: "offline-only",
    behaviors: ["demo-world: order-notifications"],
    offline: async (request, _reply, tx) => {
      const { id } = request.params as { id: string };
      const notifications = await tx
        .sheet<NotificationRecord>("notifications")
        .queryAll({ order_id: id });
      return { responseCode: 200, responseBody: { notifications } };
    },
  });

  // State machine step 1/3: pending -> accepted. Assigns the first
  // available courier; 409s if none are free (the rush-hour scenario
  // exercises this).
  registerModeRoute(fastify, {
    method: "POST",
    url: "/orders/:id/accept",
    mode: "offline-only",
    behaviors: ["demo-world: order-accept"],
    offline: async (request, _reply, tx) => {
      const { id } = request.params as { id: string };
      const orders = tx.sheet<OrderRecord>("orders");
      const order = await orders.queryFirst({ id });
      if (!order) return { responseCode: 404, responseBody: { error: "order not found" } };
      if (order.status !== "pending") {
        return {
          responseCode: 409,
          responseBody: { error: "order is not pending", status: order.status },
        };
      }
      const couriers = tx.sheet<CourierRecord>("couriers");
      const courier = await couriers.queryFirst({ status: "available" });
      if (!courier) {
        return { responseCode: 409, responseBody: { error: "no couriers available" } };
      }
      const tick = await advanceClock(tx);
      const updatedOrder: OrderRecord = {
        ...order,
        status: "accepted",
        courier_id: courier.id,
        updated_tick: tick,
      };
      await orders.upsert(updatedOrder);
      await couriers.upsert({ ...courier, status: "busy" });
      await notify(tx, updatedOrder, tick, `order ${order.id} accepted by ${courier.name}`);
      return { responseCode: 200, responseBody: updatedOrder };
    },
  });

  // State machine step 2/3: accepted -> in-progress.
  registerModeRoute(fastify, {
    method: "POST",
    url: "/orders/:id/start",
    mode: "offline-only",
    behaviors: ["demo-world: order-start"],
    offline: async (request, _reply, tx) => {
      const { id } = request.params as { id: string };
      const orders = tx.sheet<OrderRecord>("orders");
      const order = await orders.queryFirst({ id });
      if (!order) return { responseCode: 404, responseBody: { error: "order not found" } };
      if (order.status !== "accepted") {
        return {
          responseCode: 409,
          responseBody: { error: "order is not accepted", status: order.status },
        };
      }
      const tick = await advanceClock(tx);
      const updatedOrder: OrderRecord = { ...order, status: "in-progress", updated_tick: tick };
      await orders.upsert(updatedOrder);
      await notify(tx, updatedOrder, tick, `order ${order.id} is in progress`);
      return { responseCode: 200, responseBody: updatedOrder };
    },
  });

  // State machine step 3/3: in-progress -> completed. Frees the assigned
  // courier back to `available`.
  registerModeRoute(fastify, {
    method: "POST",
    url: "/orders/:id/complete",
    mode: "offline-only",
    behaviors: ["demo-world: order-complete"],
    offline: async (request, _reply, tx) => {
      const { id } = request.params as { id: string };
      const orders = tx.sheet<OrderRecord>("orders");
      const order = await orders.queryFirst({ id });
      if (!order) return { responseCode: 404, responseBody: { error: "order not found" } };
      if (order.status !== "in-progress") {
        return {
          responseCode: 409,
          responseBody: { error: "order is not in progress", status: order.status },
        };
      }
      const tick = await advanceClock(tx);
      const updatedOrder: OrderRecord = { ...order, status: "completed", updated_tick: tick };
      await orders.upsert(updatedOrder);
      if (order.courier_id) {
        const couriers = tx.sheet<CourierRecord>("couriers");
        const courier = await couriers.queryFirst({ id: order.courier_id });
        if (courier) await couriers.upsert({ ...courier, status: "available" });
      }
      await notify(tx, updatedOrder, tick, `order ${order.id} completed`);
      return { responseCode: 200, responseBody: updatedOrder };
    },
  });
};

export default ordersRoutes;
