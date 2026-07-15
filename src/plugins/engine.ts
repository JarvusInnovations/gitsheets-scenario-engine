// The scenario engine, bound as a fastify-plugin. Per specs/facade.md §
// Stack: decorates the instance with the engine/store, decorates requests
// with the resolved session, and registers the session-resolution
// `onRequest` hook. Route-level mode resolution (offline/online/dual) and
// the route registry are a separate, later plan — this plugin only provides
// the mechanics those routes will build on.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { RuntimeStore, SessionNotFoundError } from "../engine/runtime-store.ts";
import {
  runRequestCommit,
  type RequestCommitContext,
  type RequestCommitOutcome,
} from "../engine/request-commit.ts";
import type { Transaction } from "gitsheets";

/** Header a client presents its session key on. See specs/scenario-engine.md § Runtime store and ref layout: "Keys are returned to the client at login and presented on subsequent requests." */
export const SESSION_HEADER = "x-session-key";

export interface ResolvedSession {
  key: string;
  scenario: string;
}

declare module "fastify" {
  interface FastifyInstance {
    engine: RuntimeStore;
    /** Run `handler` inside one commit on the current request's session, per specs/scenario-engine.md § Request = commit. Throws if the request has no resolved session. */
    runRequestCommit<T>(
      request: FastifyRequest,
      handler: (tx: Transaction) => Promise<RequestCommitOutcome<T>>,
    ): Promise<RequestCommitOutcome<T>>;
  }
  interface FastifyRequest {
    /** Set by the session-resolution onRequest hook when SESSION_HEADER names a live session. Undefined otherwise — routes that require a session must check for it themselves (mode/route-registry enforcement is a later plan). */
    session?: ResolvedSession;
  }
}

const enginePlugin: FastifyPluginAsync = async (fastify) => {
  const store = new RuntimeStore({
    gitDir: fastify.config.RUNTIME_REPO_PATH,
    fixturesRoot: fastify.config.FIXTURES_PATH,
    appVersion: fastify.config.APP_VERSION,
    appCommitHash: fastify.config.APP_COMMIT_HASH,
  });
  await store.boot();

  fastify.decorate("engine", store);

  fastify.decorate("runRequestCommit", async function runRequestCommitDecorator<
    T,
  >(request: FastifyRequest, handler: (tx: Transaction) => Promise<RequestCommitOutcome<T>>): Promise<
    RequestCommitOutcome<T>
  > {
    const session = request.session;
    if (!session) {
      throw new Error(
        `request ${request.id} has no resolved session — route requires ${SESSION_HEADER}`,
      );
    }
    const ctx: RequestCommitContext = {
      method: request.method,
      path: request.url,
      sessionKey: session.key,
      scenario: session.scenario,
      requestId: request.id,
      userAgent: request.headers["user-agent"],
      host: request.headers.host,
    };
    return runRequestCommit(store, ctx, request.body, handler);
  });

  // Session resolution — callback-style per .claude/skills/jarvus-fastify's
  // documented gotcha (async hooks that reply.send() and return do not
  // reliably short-circuit under Bun's .inject()). This hook never sends a
  // reply itself: an absent/invalid session header just leaves
  // request.session undefined, and it's each route's job to require one.
  fastify.addHook("onRequest", (request, _reply, done) => {
    const header = request.headers[SESSION_HEADER];
    const sessionKey = Array.isArray(header) ? header[0] : header;
    if (!sessionKey) {
      done();
      return;
    }
    store
      .sessionExists(sessionKey)
      .then(async (exists) => {
        if (!exists) {
          done();
          return;
        }
        const scenario = await store.sessionScenario(sessionKey);
        request.session = { key: sessionKey, scenario };
        done();
      })
      .catch((err) => {
        if (err instanceof SessionNotFoundError) {
          done();
          return;
        }
        done(err as Error);
      });
  });
};

export default fp(enginePlugin, "5.x");
