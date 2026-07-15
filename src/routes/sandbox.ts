// The agent-sandbox profile (specs/facade.md § Agent-sandbox profile,
// plans/agent-sandbox-profile.md): "the same server, used for agent
// development/evaluation rather than app development." Three thin
// conventions layered over the existing engine + replay harness — no
// parallel framework:
//
//   - POST /sandbox/runs    — fork-per-run: mint N isolated sessions from
//                              one scenario in a single call.
//   - POST /sandbox/judge   — judgment by diff: score a run session against
//                              a reference session's tree + commit log.
//   - GET  /sandbox/judgments — read back accumulated evaluator records.
//   - POST /sandbox/regression — replay-based regression eval: reuse
//                              engine/replay.ts to re-execute a prior run's
//                              request log on THIS running facade version.
//
// NOT registered through registerModeRoute — deliberately, and for the same
// reason POST /session/login isn't (see src/routes/session.ts): these are
// sandbox/runtime *infrastructure* for evaluating agents against the
// scenario engine, not dual-mode facade business routes with an
// offline/online split. They have no parity-ledger entry (registry/) either
// — see registry/README.md's documented exemption for /health and
// /session/login, which this extends.
import type { FastifyPluginAsync } from "fastify";
import { ScenarioNotFoundError, SessionNotFoundError } from "../engine/runtime-store.ts";
import { judgeRun, listJudgments, ScenarioMismatchError } from "../engine/judging.ts";
import { replaySession } from "../engine/replay.ts";
import { fastifyInjectExecutor } from "../engine/replay-fastify.ts";

interface ForkRunsBody {
  scenario: string;
  count: number;
  modeOverride?: "offline" | "online";
}

interface JudgeBody {
  runSession: string;
  referenceSession: string;
  notes?: string;
}

interface RegressionBody {
  sessionKey: string;
}

const sandboxRoutes: FastifyPluginAsync = async (fastify) => {
  // Fork-per-run: mint N isolated sessions from the SAME scenario in one
  // call, so N candidate agents (or N runs of one agent) all start from
  // byte-identical world state (specs/facade.md § Agent-sandbox profile:
  // "each evaluation run gets a session; N candidate agents run against
  // identical forks of the same scenario"). The forks run concurrently:
  // each fastify.engine.fork() call writes its own distinct ref via git
  // plumbing (session.ts's forkSessionAt uses commit-tree/update-ref, not
  // gitsheets' transact), so there's no shared mutable state for parallel
  // calls to race — contrast with RECORD-mutating commits, which serialize
  // through RuntimeStore's write mutex (see runtime-store.ts's module
  // comment).
  fastify.post<{ Body: ForkRunsBody }>(
    "/sandbox/runs",
    {
      schema: {
        body: {
          type: "object",
          required: ["scenario", "count"],
          properties: {
            scenario: { type: "string", minLength: 1 },
            count: { type: "integer", minimum: 1, maximum: 100 },
            modeOverride: { type: "string", enum: ["offline", "online"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { scenario, count, modeOverride } = request.body;
      try {
        const forks = await Promise.all(
          Array.from({ length: count }, () => fastify.engine.fork(scenario, { modeOverride })),
        );
        reply.code(201);
        return { scenario, runs: forks.map((fork) => ({ sessionKey: fork.sessionKey })) };
      } catch (err) {
        if (err instanceof ScenarioNotFoundError) {
          reply.code(404);
          return { error: "scenario not found", scenario };
        }
        throw err;
      }
    },
  );

  // Judgment by diff: score `runSession`'s outcome against
  // `referenceSession` — their final trees' changed paths plus first-parent
  // commit-log length — and persist the verdict as an evaluator record in
  // the judgments sheet (specs/facade.md § Agent-sandbox profile: "score it
  // by comparing against a reference session... written to a separate
  // judging sheet"). See engine/judging.ts for why that sheet lives outside
  // any session's own tree. A reference session used across many judged
  // runs should be pinned (fastify.sessionGc.pin — see
  // engine/session-gc.ts) so the TTL sweep never reclaims it out from under
  // in-flight judging.
  fastify.post<{ Body: JudgeBody }>(
    "/sandbox/judge",
    {
      schema: {
        body: {
          type: "object",
          required: ["runSession", "referenceSession"],
          properties: {
            runSession: { type: "string", minLength: 1 },
            referenceSession: { type: "string", minLength: 1 },
            notes: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { runSession, referenceSession, notes } = request.body;
      try {
        const judgment = await judgeRun(fastify.engine, {
          runSessionKey: runSession,
          referenceSessionKey: referenceSession,
          notes,
        });
        reply.code(201);
        return judgment;
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          reply.code(404);
          return { error: "session not found", sessionKey: err.sessionKey };
        }
        if (err instanceof ScenarioMismatchError) {
          reply.code(400);
          return {
            error: "scenario mismatch",
            runScenario: err.runScenario,
            referenceScenario: err.referenceScenario,
          };
        }
        throw err;
      }
    },
  );

  // Evaluator-record readback — lets a harness poll accumulated verdicts,
  // e.g. after fanning N runs (POST /sandbox/runs) through POST
  // /sandbox/judge against one pinned reference session.
  fastify.get<{ Querystring: { runSession?: string } }>("/sandbox/judgments", async (request) => {
    const judgments = await listJudgments(fastify.engine, {
      runSessionKey: request.query.runSession,
    });
    return { judgments };
  });

  // Regression evals: reuse the deterministic replay harness
  // (engine/replay.ts, built for session-lifecycle-tooling) to re-execute a
  // prior run's request log against a FRESH fork of the same scenario, on
  // THIS running facade version, diffing the resulting tree at every step
  // (specs/facade.md § Agent-sandbox profile: "replay a prior run's
  // requests against a new agent/facade version and diff"). A non-empty
  // `divergentSteps` means this version's behavior has drifted from the
  // recorded run — the regression signal.
  fastify.post<{ Body: RegressionBody }>(
    "/sandbox/regression",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessionKey"],
          properties: { sessionKey: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { sessionKey } = request.body;
      try {
        const result = await replaySession(
          fastify.engine,
          sessionKey,
          fastifyInjectExecutor(fastify),
        );
        return {
          sessionKey: result.sessionKey,
          scenario: result.scenario,
          replaySessionKey: result.replaySessionKey,
          deterministic: result.deterministic,
          divergentSteps: result.divergences.map((divergence) => ({
            index: divergence.index,
            path: divergence.step.kind === "request" ? divergence.step.path : undefined,
          })),
        };
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          reply.code(404);
          return { error: "session not found", sessionKey: err.sessionKey };
        }
        throw err;
      }
    },
  );
};

export default sandboxRoutes;
