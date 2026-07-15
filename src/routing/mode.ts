// Per-route backend resolution. Pure function, no I/O — see
// src/plugins/routing.ts for where this plugs into the request lifecycle.
import type { Backend, RouteMode } from "./types.ts";

export interface ResolveBackendOptions {
  /** The route's declared config.mode, or undefined for a route outside the registry. */
  routeMode: RouteMode | undefined;
  /**
   * The resolved session's login-time override (ResolvedSession.modeOverride
   * from src/plugins/engine.ts — plain string there since the engine plugin
   * doesn't depend on this module). Anything other than "offline"/"online"
   * is treated as absent.
   */
  sessionBackendOverride?: string;
  /** The deployment's fallback backend for `dual` routes when no session override applies. */
  deploymentDefault: Backend;
}

/**
 * Resolve which backend serves a request, per specs/facade.md § Mode model:
 *
 * - `offline-only` / `online-only` routes are fixed — one backend, always.
 * - `dual` routes use the session's login-time override when present
 *   ("an online deployment hosting training sessions runs those sessions
 *   offline while real traffic proxies online"), else the deployment
 *   default.
 * - Routes with no declared mode (outside the registry) resolve to
 *   `undefined` — the caller decides what that means (register-route.ts
 *   never registers such a route through this path at all).
 */
export function resolveBackend(opts: ResolveBackendOptions): Backend | undefined {
  switch (opts.routeMode) {
    case "offline-only":
      return "offline";
    case "online-only":
      return "online";
    case "dual":
      if (opts.sessionBackendOverride === "offline" || opts.sessionBackendOverride === "online") {
        return opts.sessionBackendOverride;
      }
      return opts.deploymentDefault;
    default:
      return undefined;
  }
}
