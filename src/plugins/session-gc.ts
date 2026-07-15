// Wires the session TTL sweep (src/engine/session-gc.ts) into the fastify
// lifecycle: runs it on a configurable interval and decorates the instance
// with a small pin/unpin/sweep API for operational use (e.g. an admin route
// or CLI a later plan adds — this plugin only provides the mechanics). See
// specs/scenario-engine.md § Session lifecycle (Expire/GC).
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import {
  isPinned,
  pinSession,
  sweepExpiredSessions,
  unpinSession,
  type SweepResult,
} from "../engine/session-gc.ts";

export interface SessionGcApi {
  /** Run one sweep now (also invoked automatically on SESSION_GC_INTERVAL_MS). */
  sweep(): Promise<SweepResult>;
  /** Tag a session as pinned — exempt from the TTL sweep until unpinned. */
  pin(sessionKey: string): Promise<void>;
  /** Remove a session's pinned tag, making it eligible for the TTL sweep again. */
  unpin(sessionKey: string): Promise<void>;
  isPinned(sessionKey: string): Promise<boolean>;
}

declare module "fastify" {
  interface FastifyInstance {
    sessionGc: SessionGcApi;
  }
}

const sessionGcPlugin: FastifyPluginAsync = async (fastify) => {
  const gitDir = fastify.config.RUNTIME_REPO_PATH;
  const ttlMs = fastify.config.SESSION_TTL_MS;

  const sweep = async (): Promise<SweepResult> => {
    const result = await sweepExpiredSessions({ gitDir, ttlMs });
    if (result.swept.length > 0 || result.skippedPinned.length > 0) {
      fastify.log.info(
        { swept: result.swept, skippedPinned: result.skippedPinned },
        "session GC sweep",
      );
    }
    return result;
  };

  const api: SessionGcApi = {
    sweep,
    pin: (sessionKey) => pinSession(gitDir, sessionKey),
    unpin: (sessionKey) => unpinSession(gitDir, sessionKey),
    isPinned: (sessionKey) => isPinned(gitDir, sessionKey),
  };

  fastify.decorate("sessionGc", api);

  // Bun/Node timers both expose unref(); guard defensively in case a future
  // runtime swap doesn't. Unref'd so the sweep interval alone never keeps
  // the process alive (tests close the app without an explicit shutdown
  // signal, relying on nothing but this plugin's onClose to stop the timer
  // — see below).
  const timer = setInterval(() => {
    sweep().catch((err) => fastify.log.error(err, "session GC sweep failed"));
  }, fastify.config.SESSION_GC_INTERVAL_MS);
  timer.unref?.();

  fastify.addHook("onClose", (_instance, done) => {
    clearInterval(timer);
    done();
  });
};

export default fp(sessionGcPlugin, "5.x");
