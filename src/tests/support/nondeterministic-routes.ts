// A deliberately buggy route used ONLY to prove the replay harness's
// divergence detection (src/tests/replay.test.ts "determinism guards"
// describe block): it leaks Date.now() into record content, violating
// specs/scenario-engine.md § Determinism and replay ("no wall-clock or
// randomness may leak into record content from the engine itself"). Since
// the handler ignores its request body and writes the real clock into the
// record regardless, replaying the exact same request at a later wall-clock
// time must produce a different tree than the original commit — that
// mismatch is exactly what the replay diff exists to catch. Not part of the
// shipped app; not part of the determinism-guards static allowlist test
// either (src/tests/determinism-guards.test.ts scopes to src/engine and
// src/plugins only) — this file's whole purpose is to BE the violation.
import type { FastifyInstance } from "fastify";

interface StampRecord {
  slug: string;
  stampedAt?: number;
  [key: string]: unknown;
}

export async function registerNondeterministicRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { slug: string } }>(
    "/examples/:slug/stamp-now",
    async (request, reply) => {
      if (!request.session) {
        reply.code(400);
        return { error: "missing or invalid session" };
      }
      const outcome = await fastify.runRequestCommit<StampRecord | { error: string }>(
        request,
        async (tx) => {
          const sheet = tx.sheet<StampRecord>("examples");
          const existing = await sheet.queryFirst({ slug: request.params.slug });
          if (!existing) {
            return { responseCode: 404, responseBody: { error: "not found" } };
          }
          // BUG, deliberate: real wall clock leaking into record content
          // instead of an advanced `clock` sheet record per
          // specs/scenario-engine.md § Determinism and replay.
          const updated: StampRecord = { ...existing, stampedAt: Date.now() };
          await sheet.upsert(updated);
          return { responseCode: 200, responseBody: updated };
        },
      );
      reply.code(outcome.responseCode);
      return outcome.responseBody;
    },
  );
}
