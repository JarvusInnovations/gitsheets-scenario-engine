// The dual-mode routing plugin (specs/facade.md § Stack, § Mode model):
// imports the route parity ledger as a gitsheet, resolves each request's
// backend (offline vs online) before the handler runs, and fails boot on
// drift between the ledger and the routes actually registered in code.
//
// Depends on the engine plugin (session resolution, runRequestCommit) —
// register this AFTER enginePlugin in app.ts, per plans/dual-mode-routing.md
// "needs 2" (engine-plugin).
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { runRegistryImport } from "../routing/registry-import.ts";
import { readRegistry } from "../routing/registry-store.ts";
import { diffRegistry, type RegisteredRoute } from "../routing/validate-registry.ts";
import { resolveBackend } from "../routing/mode.ts";
import "../routing/types.ts"; // Fastify module augmentation (config.mode, request.backend)

const routingPlugin: FastifyPluginAsync = async (fastify) => {
  await runRegistryImport({
    gitDir: fastify.engine.gitDir,
    registryRoot: fastify.config.REGISTRY_PATH,
  });

  // Collected as every route in the app registers (this hook, once added,
  // fires for routes registered by any plugin afterward — see Fastify's
  // onRoute application hook) and checked against the ledger once the whole
  // app is ready to register routes.
  const registered: RegisteredRoute[] = [];
  fastify.addHook("onRoute", (routeOptions) => {
    const mode = routeOptions.config?.mode;
    if (!mode) return; // routes outside the dual-mode facade (e.g. /health) opt out by omitting config.mode
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      registered.push({ method, path: routeOptions.path, mode });
    }
  });

  fastify.addHook("onRequest", (request, _reply, done) => {
    request.backend = resolveBackend({
      routeMode: request.routeOptions.config.mode,
      sessionBackendOverride: request.session?.modeOverride,
      deploymentDefault: fastify.config.DEFAULT_DUAL_MODE,
    });
    done();
  });

  fastify.addHook("onReady", async () => {
    const ledger = await readRegistry(fastify.engine);
    const drift = diffRegistry(registered, ledger);
    if (drift.length > 0) {
      throw new Error(
        `route registry drift between code and the parity ledger (${fastify.config.REGISTRY_PATH}/):\n  ${drift.join("\n  ")}`,
      );
    }
  });
};

export default fp(routingPlugin, "5.x");
