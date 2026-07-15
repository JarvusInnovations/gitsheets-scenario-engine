import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";

import envPlugin from "./plugins/env.ts";
import enginePlugin from "./plugins/engine.ts";
import gitHttpPlugin from "./plugins/git-http.ts";
import sessionGcPlugin from "./plugins/session-gc.ts";
import routingPlugin from "./plugins/routing.ts";
import healthRoutes from "./routes/health.ts";
import sessionRoutes from "./routes/session.ts";
import ordersRoutes from "./routes/orders.ts";
import couriersRoutes from "./routes/couriers.ts";
import sandboxRoutes from "./routes/sandbox.ts";

export const app: FastifyPluginAsync = async (fastify) => {
  // 1. Environment configuration first — everything else may read fastify.config
  await fastify.register(envPlugin);

  fastify.log.level = fastify.config.LOG_LEVEL;

  // 2. CORS
  await fastify.register(cors, {
    origin: fastify.config.NODE_ENV === "production" ? false : true,
    credentials: true,
  });

  // 3. Scenario engine — the runtime store, boot import, and the
  // session-resolution hook (see specs/scenario-engine.md, specs/facade.md).
  await fastify.register(enginePlugin);

  // 3b. Session lifecycle GC — periodic TTL sweep + pin/unpin (see
  // specs/scenario-engine.md § Session lifecycle (Expire/GC)). Depends on
  // the engine plugin for fastify.engine.gitDir's config only; registered
  // after it for readability, no strict ordering requirement otherwise.
  await fastify.register(sessionGcPlugin);

  // 4. Dual-mode routing — the route parity ledger, mode resolution, and the
  // registry↔routes boot-time drift check (specs/facade.md § Mode model,
  // plans/dual-mode-routing.md). Needs the engine plugin's session hook.
  await fastify.register(routingPlugin);

  // 5. Routes — health/session are plain (outside the dual-mode facade, no
  // config.mode, see routes/session.ts); orders/couriers are the demo world
  // (specs/facade.md § Template deliverables item 2, plans/demo-world.md).
  await fastify.register(healthRoutes);
  await fastify.register(sessionRoutes);
  await fastify.register(ordersRoutes);
  await fastify.register(couriersRoutes);

  // 5b. Agent-sandbox profile — fork-per-run, judgment-by-diff, and
  // replay-based regression evals, layered over the same engine (see
  // specs/facade.md § Agent-sandbox profile, src/routes/sandbox.ts). No
  // config.mode, no ledger entry — same infrastructure exemption as
  // session/health above.
  await fastify.register(sandboxRoutes);

  // 6. Git exposure — read-only smart-HTTP endpoint over the runtime repo
  // (see specs/facade.md § Git exposure, src/plugins/git-http.ts). Not
  // fp-wrapped upstream: its content-type parser and operator-auth gate
  // are encapsulated to this prefix only.
  await fastify.register(gitHttpPlugin, { prefix: fastify.config.GIT_EXPOSURE_PATH });
};

export default fp(app, "5.x");
