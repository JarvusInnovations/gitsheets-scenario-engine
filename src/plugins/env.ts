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
    // Git exposure (see specs/facade.md § Git exposure, src/plugins/git-http.ts):
    // the read-only smart-HTTP mount path, and the operator bearer token that
    // gates it. An unset/empty token means the endpoint refuses every
    // request — deployments opt in explicitly, never by omission.
    GIT_EXPOSURE_PATH: {
      type: "string",
      default: "/git",
    },
    GIT_EXPOSURE_TOKEN: {
      type: "string",
      default: "",
    },
    // Session lifecycle GC — see specs/scenario-engine.md § Session lifecycle
    // (Expire/GC) and src/plugins/session-gc.ts.
    SESSION_TTL_MS: {
      type: "number",
      default: 24 * 60 * 60 * 1000, // 24h
    },
    SESSION_GC_INTERVAL_MS: {
      type: "number",
      default: 5 * 60 * 1000, // 5m
    },
    // Dual-mode routing (specs/facade.md § Mode model, plans/dual-mode-routing.md):
    // the route parity ledger's on-disk root, and the deployment default
    // backend for `dual` routes when a session has no login-time override.
    REGISTRY_PATH: {
      type: "string",
      default: "registry",
    },
    DEFAULT_DUAL_MODE: {
      type: "string",
      enum: ["offline", "online"],
      default: "offline",
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
      GIT_EXPOSURE_PATH: string;
      GIT_EXPOSURE_TOKEN: string;
      SESSION_TTL_MS: number;
      SESSION_GC_INTERVAL_MS: number;
      REGISTRY_PATH: string;
      DEFAULT_DUAL_MODE: "offline" | "online";
    };
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyEnv, {
    schema,
    dotenv: true,
  });
});
