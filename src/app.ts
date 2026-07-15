import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";

import envPlugin from "./plugins/env.ts";
import enginePlugin from "./plugins/engine.ts";
import gitHttpPlugin from "./plugins/git-http.ts";
import healthRoutes from "./routes/health.ts";

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

  // 4. Routes
  await fastify.register(healthRoutes);

  // 5. Git exposure — read-only smart-HTTP endpoint over the runtime repo
  // (see specs/facade.md § Git exposure, src/plugins/git-http.ts). Not
  // fp-wrapped upstream: its content-type parser and operator-auth gate
  // are encapsulated to this prefix only.
  await fastify.register(gitHttpPlugin, { prefix: fastify.config.GIT_EXPOSURE_PATH });
};

export default fp(app, "5.x");
