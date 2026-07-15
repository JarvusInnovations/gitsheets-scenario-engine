// Throwaway routes for exercising the engine plugin end-to-end (per
// plans/engine-plugin.md: "build a tiny throwaway route in a test... you
// only need enough of a fixture + route to exercise the engine"). Not part
// of the shipped app — registered directly by tests.
import type { FastifyInstance } from "fastify";

interface ExampleRecord {
  slug: string;
  source?: string;
  touches?: number;
  [key: string]: unknown;
}

export async function registerDemoRoutes(fastify: FastifyInstance): Promise<void> {
  // Read-only: goes through sessionRead, relying on gitsheets' no-op
  // detection to guarantee no commit lands for a plain GET.
  fastify.get<{ Params: { slug: string } }>("/examples/:slug", async (request, reply) => {
    if (!request.session) {
      reply.code(400);
      return { error: "missing or invalid session" };
    }
    const record = await fastify.engine.sessionRead(request.session.key, async (tx) => {
      return tx.sheet<ExampleRecord>("examples").queryFirst({ slug: request.params.slug });
    });
    if (!record) {
      reply.code(404);
      return { error: "not found" };
    }
    return record;
  });

  // Mutating: request = commit. Increments `touches` on the record.
  fastify.post<{ Params: { slug: string } }>("/examples/:slug/touch", async (request, reply) => {
    if (!request.session) {
      reply.code(400);
      return { error: "missing or invalid session" };
    }
    const outcome = await fastify.runRequestCommit<ExampleRecord | { error: string }>(
      request,
      async (tx) => {
        const sheet = tx.sheet<ExampleRecord>("examples");
        const existing = await sheet.queryFirst({ slug: request.params.slug });
        if (!existing) {
          return { responseCode: 404, responseBody: { error: "not found" } };
        }
        const updated: ExampleRecord = { ...existing, touches: (existing.touches ?? 0) + 1 };
        await sheet.upsert(updated);
        return { responseCode: 200, responseBody: updated };
      },
    );
    reply.code(outcome.responseCode);
    return outcome.responseBody;
  });
}
