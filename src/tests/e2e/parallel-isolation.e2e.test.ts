// Parallel isolation, per plans/e2e-harness.md § Validation: "Parallel
// workers with per-session isolation, no cross-test cleanup beyond ref
// deletion." Two layers are in play, and this file proves the harder one:
//
//   1. CROSS-FILE isolation — structural, not tested here. Every e2e test
//      file calls `buildTestApp()` in its own `beforeEach` (src/tests/helpers.ts),
//      which mints a fresh `mkdtempSync` runtime repo per call. Bun test
//      files run as independent module instances, so concurrent test FILES
//      (Bun's own worker parallelism) never share a gitDir, full stop — see
//      helpers.ts's module doc.
//   2. WITHIN one runtime store — the harder case, exercised below.
//      engine/runtime-store.ts's module doc flags a real, deliberate
//      trade-off: every session's commit phase serializes through ONE
//      process-wide AsyncMutex (RuntimeStore#sessionTransact), because
//      gitsheets' own per-instance mutex doesn't hold across a single
//      shared Repository the way "one handle per session" would need. This
//      test proves that serialization is invisible from the outside:
//      concurrent sessions, driven through fully-interleaved requests, each
//      land their own commits on their own ref with zero cross-session
//      bleed, even though every commit physically passes through the same
//      mutex one at a time.
import { afterEach, beforeEach, describe, expect } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers.ts";
import { e2eTest, loginInject, type E2ESession } from "./harness.ts";
import * as plumbing from "../../engine/plumbing.ts";
import type { OrderRecord } from "../../routes/orders.ts";

let fastify: FastifyInstance;

beforeEach(async () => {
  fastify = await buildTestApp();
});

afterEach(async () => {
  await fastify.close();
});

const WORKER_COUNT = 8;
// Every commit these workers produce serializes through RuntimeStore's
// single process-wide AsyncMutex (see engine/runtime-store.ts's module
// doc), so WORKER_COUNT * 3 sequential commits is real, measured wall-clock
// time, not just parallel scheduling overhead — comfortably under bun:test's
// 5000ms default in isolation, but `bun test --parallel` runs N files
// concurrently as separate OS processes competing for the same CPU, which
// can push a busy CI runner past the default. A generous explicit timeout
// keeps this test about isolation, not about winning a race with the clock.
const TIMEOUT_MS = 20_000;

describe("e2e harness: N concurrent sessions against one runtime store", () => {
  e2eTest(
    "each worker's accept -> start -> complete flow lands on its own ref, untouched by the others",
    async () => {
      // Fork all sessions concurrently first — exercises concurrent forkSession()
      // calls (each its own root + merge commit pair) racing the same gitDir.
      const sessions: E2ESession[] = await Promise.all(
        Array.from({ length: WORKER_COUNT }, () => loginInject(fastify, "standard-day")),
      );

      // Every session key (and therefore every refs/sessions/<key>) must be
      // unique — the harness's isolation guarantee starts here.
      const sessionKeys = sessions.map((s) => s.sessionKey);
      expect(new Set(sessionKeys).size).toBe(WORKER_COUNT);

      // Now drive every worker's full state machine fully interleaved:
      // Promise.all across workers, sequential within a worker (accept must
      // land before start can). Each worker targets order-1001 — the SAME
      // order id in every session, which is exactly the point: these are
      // independent forks of the same baseline, so "the same order id" in
      // two different sessions must never collide.
      const results = await Promise.all(
        sessions.map(async (session) => {
          const before = await session.commitCount();

          const accept = await session.request({
            method: "POST",
            url: "/orders/order-1001/accept",
          });
          expect(accept.statusCode).toBe(200);
          const accepted = accept.json<OrderRecord>();

          const start = await session.request({ method: "POST", url: "/orders/order-1001/start" });
          expect(start.statusCode).toBe(200);

          const complete = await session.request({
            method: "POST",
            url: "/orders/order-1001/complete",
          });
          expect(complete.statusCode).toBe(200);

          const after = await session.commitCount();
          return { session, before, after, courierId: accepted.courier_id };
        }),
      );

      for (const { session, before, after, courierId } of results) {
        // Exactly 3 commits per worker — no extra commits leaked in from
        // another worker's concurrent writes, none missing either.
        expect(after).toBe(before + 3);

        const order = await session.record<OrderRecord>("orders", { id: "order-1001" });
        expect(order).toMatchObject({ status: "completed", courier_id: courierId });

        const notifications = await session.records("notifications", { order_id: "order-1001" });
        expect(notifications).toHaveLength(3);
      }

      // Belt-and-suspenders: every worker's final tip COMMIT HASH is
      // distinct — the meaningful check (unlike the sessionKey/ref-string
      // check above, which is trivially unique by construction). If two
      // sessions had somehow aliased the same ref under the shared
      // AsyncMutex, two entries here would collide.
      const tipHashes = await Promise.all(
        sessions.map((session) => plumbing.resolveRef(session.gitDir, session.ref)),
      );
      expect(tipHashes.every((hash) => hash !== null)).toBe(true);
      expect(new Set(tipHashes).size).toBe(WORKER_COUNT);
    },
    TIMEOUT_MS,
  );

  e2eTest(
    "deleting one worker's ref (session end-of-life) leaves every other worker's session intact",
    async () => {
      // "No cross-test cleanup beyond ref deletion" (plans/e2e-harness.md §
      // Validation) — proves the OTHER half: deleting a session ref is a
      // fully self-contained operation with no effect on sibling sessions
      // sharing the same runtime store.
      const sessions = await Promise.all(
        Array.from({ length: WORKER_COUNT }, () => loginInject(fastify, "standard-day")),
      );
      for (const session of sessions) {
        const accept = await session.request({ method: "POST", url: "/orders/order-1001/accept" });
        expect(accept.statusCode).toBe(200);
      }

      const [doomed, ...survivors] = sessions;
      if (!doomed) throw new Error("expected at least one session");
      await plumbing.deleteRef(fastify.engine.gitDir, doomed.ref);

      expect(await plumbing.resolveRef(fastify.engine.gitDir, doomed.ref)).toBeNull();
      for (const session of survivors) {
        expect(await plumbing.resolveRef(fastify.engine.gitDir, session.ref)).toMatch(
          /^[0-9a-f]{40}$/,
        );
        const order = await session.record<OrderRecord>("orders", { id: "order-1001" });
        expect(order).toMatchObject({ status: "accepted" });
      }
    },
    TIMEOUT_MS,
  );
});
