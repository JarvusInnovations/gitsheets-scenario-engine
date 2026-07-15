// Drift check between the routes actually registered in code (via
// `config.mode` — collected as Fastify registers them, see
// src/plugins/routing.ts's onRoute hook) and the parity-ledger gitsheet's
// entries. Pure function: no I/O, easy to unit test in isolation from a
// running Fastify instance.
import type { RegistryEntry, RouteMode } from "./types.ts";

export interface RegisteredRoute {
  method: string;
  path: string;
  mode: RouteMode;
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Compare registered routes against the ledger. Returns a sorted list of
 * human-readable drift problems — empty means the two fully agree. Per
 * specs/facade.md § Mode model: "the registry file is validated against the
 * actually-registered routes at boot (drift between ledger and code fails
 * startup)."
 */
export function diffRegistry(registered: RegisteredRoute[], ledger: RegistryEntry[]): string[] {
  const problems: string[] = [];
  const registeredByKey = new Map(registered.map((r) => [routeKey(r.method, r.path), r]));
  const ledgerByKey = new Map(ledger.map((e) => [routeKey(e.method, e.path), e]));

  for (const [key, route] of registeredByKey) {
    const entry = ledgerByKey.get(key);
    if (!entry) {
      problems.push(
        `${key}: registered in code with mode "${route.mode}" but has no parity ledger entry`,
      );
    } else if (entry.mode !== route.mode) {
      problems.push(
        `${key}: code declares mode "${route.mode}" but the ledger says "${entry.mode}"`,
      );
    }
  }
  for (const [key, entry] of ledgerByKey) {
    if (!registeredByKey.has(key)) {
      problems.push(`${key}: ledger entry (mode "${entry.mode}") has no matching registered route`);
    }
  }
  return problems.sort();
}
