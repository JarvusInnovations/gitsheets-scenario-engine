// Dual-mode routing types + Fastify module augmentation.
// See specs/facade.md § Stack, § Mode model:
//   "The route registry entries attach as route config (config.lensMode-style
//   route options: offline-only | online-only | dual), so mode resolution
//   happens per-route in a hook rather than in handler code, and the
//   registry file is validated against the actually-registered routes at
//   boot (drift between ledger and code fails startup)."
export type RouteMode = "offline-only" | "online-only" | "dual";

/** Which backend actually serves a request — resolved from RouteMode + session + deployment default. See mode.ts. */
export type Backend = "offline" | "online";

/**
 * One row of the parity ledger (registry/routes/<id>.toml — a real gitsheet,
 * see registry-import.ts). Mirrors a route's `config.mode` in code; the
 * boot-time check in validate-registry.ts fails startup if the two diverge.
 */
export interface RegistryEntry {
  id: string;
  method: string;
  path: string;
  mode: RouteMode;
  /** Links to the scenario behaviors that define this route (specs/facade.md § Mode model: "the parity ledger... tracking each route's status with links to the scenario behaviors that define it"). */
  behaviors: string[];
  notes?: string;
  [key: string]: unknown;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Declares this route as part of the dual-mode facade and which backend(s)
     * it supports. Routes without `mode` (e.g. /health) sit outside the
     * offline/online model entirely and are ignored by the boot-time
     * registry-drift check — see validate-registry.ts.
     */
    mode?: RouteMode;
    /** Mirrored into the route's parity-ledger entry; validated for presence at registration (see register-route.ts). */
    behaviors?: string[];
  }

  interface FastifyRequest {
    /**
     * Resolved by the routing plugin's onRequest hook (registered after the
     * engine plugin's session-resolution hook — see src/plugins/routing.ts):
     * which backend serves *this* request. Undefined for routes outside the
     * registry (no declared `config.mode`).
     */
    backend?: Backend;
  }
}
