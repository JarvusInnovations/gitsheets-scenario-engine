import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";

import envPlugin from "./plugins/env.ts";
import healthRoutes from "./routes/health.ts";

// This is the seam later plans build on: the scenario engine registers here
// as a fastify-plugin decorating the instance with the engine/store and the
// session-resolution hook (see specs/scenario-engine.md, specs/facade.md).
// Nothing engine-specific lives here yet — just the bare frame.
export const app: FastifyPluginAsync = async (fastify) => {
  // 1. Environment configuration first — everything else may read fastify.config
  await fastify.register(envPlugin);

  fastify.log.level = fastify.config.LOG_LEVEL;

  // 2. CORS
  await fastify.register(cors, {
    origin: fastify.config.NODE_ENV === "production" ? false : true,
    credentials: true,
  });

  // 3. Routes
  await fastify.register(healthRoutes);
};

export default fp(app, "5.x");
