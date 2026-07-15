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
    // Scenario engine: see specs/scenario-engine.md § Runtime store and ref layout.
    RUNTIME_REPO_PATH: {
      type: "string",
      default: "var/runtime.git",
    },
    FIXTURES_PATH: {
      type: "string",
      default: "fixtures",
    },
    APP_VERSION: {
      type: "string",
      default: "0.0.0-dev",
    },
    // Optional: the source-tree commit the running build was built from. When
    // set, boot-import parents each baseline commit on it (a depth-1 bundle of
    // this commit is assumed to already exist as an object in the runtime
    // repo — see plans/engine-plugin.md "Risks/unknowns"). When unset (e.g.
    // local dev, tests), baselines are parentless root commits instead.
    APP_COMMIT_HASH: {
      type: "string",
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
      RUNTIME_REPO_PATH: string;
      FIXTURES_PATH: string;
      APP_VERSION: string;
      APP_COMMIT_HASH?: string;
    };
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyEnv, {
    schema,
    dotenv: true,
  });
});
