import fp from "fastify-plugin";
import fastifyEnv from "@fastify/env";

const schema = {
  type: "object",
  required: [],
  properties: {
    PORT: {
      type: "number",
      default: 3001,
    },
    HOST: {
      type: "string",
      default: "0.0.0.0",
    },
    NODE_ENV: {
      type: "string",
      enum: ["development", "production", "test"],
      default: "development",
    },
    LOG_LEVEL: {
      type: "string",
      enum: ["fatal", "error", "warn", "info", "debug", "trace"],
      default: "info",
    },
  },
};

// TypeScript declaration merging for type safety
declare module "fastify" {
  interface FastifyInstance {
    config: {
      PORT: number;
      HOST: string;
      NODE_ENV: "development" | "production" | "test";
      LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    };
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyEnv, {
    schema,
    dotenv: true,
  });
});
