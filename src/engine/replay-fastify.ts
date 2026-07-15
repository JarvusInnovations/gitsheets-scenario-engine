// The Fastify-specific replay executor: drives a parsed request step by
// injecting an HTTP request against a running app instance (with routes
// already registered), targeting the fresh replay session. Kept separate
// from engine/replay.ts, which is deliberately Fastify-agnostic — see that
// module's doc comment for why.
import type { FastifyInstance, InjectOptions } from "fastify";
import { SESSION_HEADER } from "../plugins/engine.ts";
import { sessionRef } from "./session.ts";
import * as plumbing from "./plumbing.ts";
import type { ExecuteStep, ExecuteStepResult, ReplayStep } from "./replay.ts";

/**
 * Build an `ExecuteStep` that replays a request via `fastify.inject()`
 * against `fastify`'s already-registered routes, presenting the replay
 * session's key on `SESSION_HEADER`. The request body is whatever
 * `parseSessionLog` reconstructed from the original commit's `Request:`
 * fence.
 */
export function fastifyInjectExecutor(fastify: FastifyInstance): ExecuteStep {
  return async (
    step: Extract<ReplayStep, { kind: "request" }>,
    replaySessionKey: string,
  ): Promise<ExecuteStepResult> => {
    const injectOptions: InjectOptions = {
      method: step.method as InjectOptions["method"],
      url: step.path,
      headers: { [SESSION_HEADER]: replaySessionKey },
    };
    if (step.requestBody !== null && step.requestBody !== undefined) {
      injectOptions.headers = { ...injectOptions.headers, "content-type": "application/json" };
      injectOptions.payload = step.requestBody;
    }

    await fastify.inject(injectOptions);

    const gitDir = fastify.engine.gitDir;
    const tipCommitHash = await plumbing.resolveRef(gitDir, sessionRef(replaySessionKey));
    if (!tipCommitHash) {
      throw new Error(`replay session ${replaySessionKey}'s ref disappeared mid-replay`);
    }
    return { tipCommitHash };
  };
}
