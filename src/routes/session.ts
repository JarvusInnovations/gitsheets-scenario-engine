// The demo/e2e client's entry point: forks a session from a named scenario
// and returns the session key the client presents on SESSION_HEADER for
// every subsequent request (specs/scenario-engine.md § Session lifecycle,
// "Fork (login)").
//
// NOT registered through registerModeRoute — deliberately. That helper's
// offline dispatch (src/routing/register-route.ts) requires
// `request.session` to already be resolved before it will invoke a route's
// `offline` handler; login is what *creates* the session a later request's
// SESSION_HEADER resolves, so there is no session yet to check. Login is
// infrastructure for reaching the dual-mode facade, not a route the facade
// itself serves — the same exemption /health already has (see
// registry/README.md: "Routes outside the dual-mode facade ... don't
// declare config.mode"). It therefore has no parity-ledger entry either.
import type { FastifyPluginAsync } from "fastify";
import { ScenarioNotFoundError } from "../engine/runtime-store.ts";

interface LoginBody {
  scenario: string;
  /**
   * Per-session backend override for `dual` routes (specs/facade.md § Mode
   * model: "overridable per session at login"). Forwarded verbatim to
   * RuntimeStore#fork; validated/narrowed by the routing plugin on read
   * (src/routing/mode.ts), not here.
   */
  modeOverride?: "offline" | "online";
}

const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>(
    "/session/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["scenario"],
          properties: {
            scenario: { type: "string", minLength: 1 },
            modeOverride: { type: "string", enum: ["offline", "online"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { scenario, modeOverride } = request.body;
      try {
        const fork = await fastify.engine.fork(scenario, { modeOverride });
        reply.code(201);
        return { sessionKey: fork.sessionKey, scenario, modeOverride };
      } catch (err) {
        if (err instanceof ScenarioNotFoundError) {
          reply.code(404);
          return { error: "scenario not found", scenario };
        }
        throw err;
      }
    },
  );
};

export default sessionRoutes;
