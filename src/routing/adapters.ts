// The online-mode seam (specs/facade.md § Online mode): "Handlers proxy to
// upstream services through per-service adapters (auth injection, shape
// mapping, version selection). No gitsheets involvement; no commits."
//
// Only a thin interface + a stub/echo implementation ship in this plan —
// per plans/dual-mode-routing.md: "Online adapters can be stubs at this
// stage — the point is the seam and the ledger, not real upstreams."
//
// Deferred, documented seam: shadow capture ("online responses recorded
// (redacted per policy) as candidate fixture material for new scenarios").
// A real adapter implementation is the natural place to hook it in — record
// the OnlineAdapterResult before returning it — but no capture/storage
// exists yet.
import type { FastifyRequest } from "fastify";

export interface OnlineAdapterContext {
  request: FastifyRequest;
}

export interface OnlineAdapterResult<TResponse = unknown> {
  responseCode: number;
  responseBody: TResponse;
}

export interface OnlineAdapter<TResponse = unknown> {
  call(ctx: OnlineAdapterContext): Promise<OnlineAdapterResult<TResponse>>;
}

/**
 * Wrap a plain function as an OnlineAdapter. The "echo" framing matches this
 * plan's scope: real per-service adapters (auth injection, shape mapping,
 * version selection against an actual upstream) are future work — this is
 * the seam they'll implement, exercised end-to-end with canned/echoed data
 * for now.
 */
export function createEchoAdapter<TResponse = unknown>(
  responder: (
    ctx: OnlineAdapterContext,
  ) => OnlineAdapterResult<TResponse> | Promise<OnlineAdapterResult<TResponse>>,
): OnlineAdapter<TResponse> {
  return { call: async (ctx) => responder(ctx) };
}
