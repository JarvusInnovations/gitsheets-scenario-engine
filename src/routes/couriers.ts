// online-only: pass-through to a courier-roster upstream that doesn't exist
// in this template yet — the seam register-route.ts's dispatch wires up
// (specs/facade.md § Online mode), exercised here with an echo stub. No
// session required, no gitsheets involvement, no commit — mirrors
// src/tests/support/routing-demo-routes.ts's GET /catalog/:slug/upstream.
import type { FastifyPluginAsync } from "fastify";
import { registerModeRoute } from "../routing/register-route.ts";
import { createEchoAdapter } from "../routing/adapters.ts";

const couriersRoutes: FastifyPluginAsync = async (fastify) => {
  registerModeRoute(fastify, {
    method: "GET",
    url: "/couriers/:id/upstream",
    mode: "online-only",
    behaviors: ["demo-world: courier-upstream-lookup"],
    adapter: createEchoAdapter(({ request }) => {
      const { id } = request.params as { id: string };
      return {
        responseCode: 200,
        responseBody: { id, status: "available", source: "online" as const },
      };
    }),
    online: async (request, _reply, adapter) => adapter.call({ request }),
  });
};

export default couriersRoutes;
