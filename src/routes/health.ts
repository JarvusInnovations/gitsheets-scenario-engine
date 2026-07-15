import type { FastifyPluginAsync } from "fastify";

// The seam later plans register the engine plugin into. Keep this minimal:
// no engine, no sheets, no scenario resolution — just proof the process is up.
const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, _reply) => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });
};

export default healthRoutes;
