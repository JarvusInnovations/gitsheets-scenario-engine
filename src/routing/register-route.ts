// The one registration path for a dual-mode-facade route. Centralizes the
// rule from specs/facade.md § Mode model: "offline routes flow through the
// request=commit wrapper (fastify.runRequestCommit); online routes take the
// adapter path (no commit)" — so individual route files never have to get
// that dispatch right themselves.
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchema,
  RouteGenericInterface,
} from "fastify";
import type { Transaction } from "gitsheets";
import type { RequestCommitOutcome } from "../engine/request-commit.ts";
import { createEchoAdapter, type OnlineAdapter } from "./adapters.ts";
import type { RouteMode } from "./types.ts";

export interface ModeRouteOptions<T extends RouteGenericInterface = RouteGenericInterface> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  mode: RouteMode;
  /** Links to the scenario behaviors that define this route — required, and must mirror the route's parity-ledger entry (see registry/, validated at boot by validate-registry.ts). */
  behaviors: string[];
  /** One response schema for both backends — see schema-parity.ts. */
  schema?: FastifySchema;
  /** Required unless mode is "online-only". Runs inside fastify.runRequestCommit — read-only handlers naturally produce no commit via gitsheets' no-op detection. */
  offline?: (
    request: FastifyRequest<T>,
    reply: FastifyReply,
    tx: Transaction,
  ) => Promise<RequestCommitOutcome<unknown>>;
  /** Required unless mode is "offline-only". Never touches gitsheets; no commit. */
  online?: (
    request: FastifyRequest<T>,
    reply: FastifyReply,
    adapter: OnlineAdapter,
  ) => Promise<{ responseCode: number; responseBody: unknown }>;
  /** Passed to `online` as a convenience; a handler is free to ignore it and call its own upstream client instead. */
  adapter?: OnlineAdapter;
}

const NO_ADAPTER_CONFIGURED = createEchoAdapter(() => ({
  responseCode: 501,
  responseBody: { error: "no online adapter configured for this route" },
}));

export function registerModeRoute<T extends RouteGenericInterface = RouteGenericInterface>(
  fastify: FastifyInstance,
  opts: ModeRouteOptions<T>,
): void {
  if (opts.mode !== "online-only" && !opts.offline) {
    throw new Error(
      `route ${opts.method} ${opts.url}: mode "${opts.mode}" requires an offline handler`,
    );
  }
  if (opts.mode !== "offline-only" && !opts.online) {
    throw new Error(
      `route ${opts.method} ${opts.url}: mode "${opts.mode}" requires an online handler`,
    );
  }
  if (opts.behaviors.length === 0) {
    throw new Error(
      `route ${opts.method} ${opts.url}: behaviors must list at least one scenario behavior reference`,
    );
  }

  // Registered WITHOUT the <T> generic — RouteGenericInterface's default
  // (unconstrained Reply) is what keeps reply.code()/the handler's return
  // type simple below. `opts.offline`/`opts.online` still get a properly
  // T-typed `request` via the cast at the top of the handler; only the raw
  // Fastify registration itself stays untyped.
  fastify.route({
    method: opts.method,
    url: opts.url,
    schema: opts.schema,
    // Fastify auto-generates a HEAD route for every GET unless told not to
    // — left on, that shadow route would register with the same
    // `config.mode` and trip the registry-drift check (no ledger entry for
    // a route nobody declared). The ledger tracks the routes the facade
    // actually declares, not Fastify's derived ones.
    exposeHeadRoute: false,
    // The route registry, expressed as route config (specs/facade.md § Stack).
    config: { mode: opts.mode, behaviors: opts.behaviors },
    handler: async (rawRequest, reply) => {
      const request = rawRequest as FastifyRequest<T>;
      // Set by the routing plugin's onRequest hook, which runs after the
      // engine plugin's session-resolution hook — see src/plugins/routing.ts.
      const backend = request.backend;

      if (backend === "offline") {
        if (!request.session) {
          reply.code(400);
          return { error: "missing or invalid session" };
        }
        const outcome = await fastify.runRequestCommit(request, (tx) =>
          opts.offline!(request, reply, tx),
        );
        reply.code(outcome.responseCode);
        return outcome.responseBody;
      }

      if (backend === "online") {
        const outcome = await opts.online!(request, reply, opts.adapter ?? NO_ADAPTER_CONFIGURED);
        reply.code(outcome.responseCode);
        return outcome.responseBody;
      }

      // Unreachable in practice: every route registered through this
      // function always declares `config.mode`, and the routing plugin
      // resolves offline/online for every such route. Guard loudly anyway
      // rather than let an unhandled case fall through silently.
      reply.code(500);
      return { error: "route mode did not resolve to a backend" };
    },
  });
}
