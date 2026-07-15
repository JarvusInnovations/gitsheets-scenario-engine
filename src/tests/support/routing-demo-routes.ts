// Throwaway routes exercising the dual-mode routing mechanism end-to-end —
// one of each mode (offline-only / online-only / dual), mirroring
// support/demo-routes.ts's role for the engine plugin. Not part of the
// shipped app; registered directly by tests. Reuses the "examples" sheet
// shape scaffoldFixtures() already sets up.
import type { FastifyInstance } from "fastify";
import { registerModeRoute } from "../../routing/register-route.ts";
import { createEchoAdapter } from "../../routing/adapters.ts";

interface ExampleRecord {
  slug: string;
  source?: string;
  touches?: number;
  legacy?: boolean;
  [key: string]: unknown;
}

/** The ONE response schema a `dual` route declares — serializes both backends' responses. See src/routing/schema-parity.ts. */
export const catalogItemSchema = {
  type: "object",
  required: ["slug", "source"],
  properties: {
    slug: { type: "string" },
    source: { type: "string", enum: ["offline", "online"] },
    touches: { type: "number" },
  },
  additionalProperties: false,
} as const;

export async function registerRoutingDemoRoutes(fastify: FastifyInstance): Promise<void> {
  // offline-only: "exists only as scenario behavior — the executable spec
  // for unbuilt backend work" (specs/facade.md § Mode model). Mutates a
  // record, so it commits.
  registerModeRoute(fastify, {
    method: "POST",
    url: "/catalog/:slug/mark-legacy",
    mode: "offline-only",
    behaviors: ["registry-demo: mark-legacy"],
    offline: async (request, _reply, tx) => {
      const { slug } = request.params as { slug: string };
      const sheet = tx.sheet<ExampleRecord>("examples");
      const existing = await sheet.queryFirst({ slug });
      if (!existing) {
        return { responseCode: 404, responseBody: { error: "not found" } };
      }
      const updated: ExampleRecord = { ...existing, legacy: true };
      await sheet.upsert(updated);
      return { responseCode: 200, responseBody: updated };
    },
  });

  // online-only: pass-through, no session required, no commit — the adapter
  // is the whole handler.
  registerModeRoute(fastify, {
    method: "GET",
    url: "/catalog/:slug/upstream",
    mode: "online-only",
    behaviors: ["registry-demo: upstream-lookup"],
    adapter: createEchoAdapter(({ request }) => {
      const { slug } = request.params as { slug: string };
      return { responseCode: 200, responseBody: { slug, source: "online" as const } };
    }),
    online: async (request, _reply, adapter) => adapter.call({ request }),
  });

  // dual: runtime selection (deployment default, session override). Both
  // branches shape their body to catalogItemSchema — the serializer-parity
  // demo.
  registerModeRoute(fastify, {
    method: "GET",
    url: "/catalog/:slug",
    mode: "dual",
    behaviors: ["registry-demo: catalog-lookup"],
    schema: { response: { 200: catalogItemSchema } },
    offline: async (request, _reply, tx) => {
      const { slug } = request.params as { slug: string };
      const record = await tx.sheet<ExampleRecord>("examples").queryFirst({ slug });
      if (!record) {
        return { responseCode: 404, responseBody: { error: "not found" } };
      }
      return {
        responseCode: 200,
        responseBody: {
          slug: record.slug,
          source: "offline" as const,
          touches: record.touches ?? 0,
        },
      };
    },
    adapter: createEchoAdapter(({ request }) => {
      const { slug } = request.params as { slug: string };
      return { responseCode: 200, responseBody: { slug, source: "online" as const, touches: 0 } };
    }),
    online: async (request, _reply, adapter) => adapter.call({ request }),
  });
}
