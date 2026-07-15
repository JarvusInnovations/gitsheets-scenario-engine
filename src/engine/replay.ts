// Deterministic replay harness. See specs/scenario-engine.md § Determinism
// and replay:
//
//   "Replay harness: given a session ref, re-execute its request log
//   (parsed from commit messages) against a fresh fork and diff the
//   resulting trees. Divergence = behavior change; this doubles as a
//   regression test between facade versions."
//
// Parses a session's ordered request log from first-parent commit history
// (oldest -> newest, skipping the parentless session root and the
// two-parent fork/merge commit — see session.ts / specs/scenario-engine.md
// § Session lifecycle), re-executes each request against a FRESH fork of
// the same baseline scenario, and diffs the resulting tree hash at every
// step against the original commit's tree. Byte-identical trees at every
// step means deterministic; the first divergence is a behavior change.
//
// PARSEABILITY FINDING (plans/session-lifecycle-tooling.md "Risks/unknowns"
// — "Request-log parsing fidelity from commit messages"): the request=commit
// message format built by request-commit.ts (subject line + fenced
// ```json Request:/Response: blocks + trailers) DOES round-trip cleanly for
// replay — parseSessionLog below reconstructs method/path/request body
// exactly via regex extraction of the two fenced blocks, with no ambiguity
// against the trailer block (trailers are always the message's last
// paragraph; the fenced JSON is never mistaken for one — see
// runtime-store.ts#appendTrailers and the regex below). No structured
// machine-readable payload convention beyond the fences turned out to be
// necessary. The one thing this parser deliberately does NOT support is
// EVENT commits (non-request mutations, specs/scenario-engine.md § Request
// = commit "Non-request mutations") — there is no generic re-invocation
// path for those yet (no route/handler registry maps an event name back to
// code), so parseSessionLog surfaces them as steps but replaySession throws
// UnsupportedReplayStepError if one is actually encountered, rather than
// silently skipping (skipping would make "deterministic: true" a lie about
// a log replay didn't actually fully cover).
//
// Fastify-agnostic by design: this module knows how to parse the message
// format and diff trees, but delegates *executing* a parsed request back to
// the caller via `executeStep`. See engine/replay-fastify.ts for the
// fastify.inject()-based executor this app actually uses.
import * as plumbing from "./plumbing.ts";
import { sessionRef, resolveSessionScenario } from "./session.ts";
import type { RuntimeStore } from "./runtime-store.ts";

export type ReplayStep =
  | {
      kind: "request";
      commitHash: string;
      method: string;
      path: string;
      requestBody: unknown;
      /** Best-effort — parsed from the Response-Code trailer if present. Informational only; not used in the tree diff. */
      originalResponseCode?: string;
    }
  | {
      kind: "event";
      commitHash: string;
      eventName: string;
    };

export interface ParsedSessionLog {
  scenario: string;
  /** Oldest -> newest, excluding the session root and fork/merge commits. */
  steps: ReplayStep[];
}

export class UnparseableCommitError extends Error {
  constructor(public readonly commitHash: string) {
    super(
      `commit ${commitHash} in first-parent session history is neither the root/fork commit ` +
        "nor a parseable request=commit/EVENT message — replay cannot reconstruct the request log " +
        "(see specs/scenario-engine.md § Request = commit for the expected shape)",
    );
    this.name = "UnparseableCommitError";
  }
}

export class UnsupportedReplayStepError extends Error {
  constructor(public readonly step: ReplayStep) {
    super(
      `replay does not support re-executing a "${step.kind}" commit (${step.commitHash}` +
        (step.kind === "event" ? `, EVENT ${step.eventName}` : "") +
        ") — no generic re-invocation path exists for non-request mutations yet",
    );
    this.name = "UnsupportedReplayStepError";
  }
}

const REQUEST_FENCE_RE = /Request:\n```json\n([\s\S]*?)\n```/;
const RESPONSE_CODE_TRAILER_RE = /^Response-Code:\s*(\S+)\s*$/m;

function parseCommitMessage(commitHash: string, message: string): ReplayStep {
  const subject = message.split("\n", 1)[0] ?? "";

  const eventMatch = subject.match(/^EVENT (.+)$/);
  if (eventMatch?.[1]) {
    return { kind: "event", commitHash, eventName: eventMatch[1] };
  }

  const requestMatch = subject.match(/^(\S+) (\S.*)$/);
  const requestFence = message.match(REQUEST_FENCE_RE);
  if (!requestMatch || !requestFence?.[1]) {
    throw new UnparseableCommitError(commitHash);
  }

  let requestBody: unknown;
  try {
    requestBody = JSON.parse(requestFence[1]);
  } catch {
    throw new UnparseableCommitError(commitHash);
  }

  return {
    kind: "request",
    commitHash,
    method: requestMatch[1]!,
    path: requestMatch[2]!,
    requestBody,
    originalResponseCode: message.match(RESPONSE_CODE_TRAILER_RE)?.[1],
  };
}

/**
 * Parse a session's ordered request/event log from first-parent history.
 * Skips the parentless session root and the two-parent fork/merge commit —
 * those are DAG scaffolding (specs/scenario-engine.md § Session lifecycle),
 * not requests. Throws UnparseableCommitError if a single-parent commit in
 * the history isn't shaped like a request=commit or EVENT commit.
 */
export async function parseSessionLog(
  gitDir: string,
  sessionKey: string,
): Promise<ParsedSessionLog> {
  const ref = sessionRef(sessionKey);
  const scenario = await resolveSessionScenario(gitDir, sessionKey);
  const commitsNewestFirst = await plumbing.firstParentLog(gitDir, ref);

  const steps: ReplayStep[] = [];
  for (const commitHash of [...commitsNewestFirst].reverse()) {
    const parents = await plumbing.parentsOf(gitDir, commitHash);
    if (parents.length !== 1) continue; // root (0 parents) or fork/merge (2 parents)
    const message = await plumbing.commitMessage(gitDir, commitHash);
    steps.push(parseCommitMessage(commitHash, message));
  }

  return { scenario, steps };
}

export interface ExecuteStepResult {
  /** The replay session ref's tip commit hash after this step ran. */
  tipCommitHash: string;
}

export type ExecuteStep = (
  step: Extract<ReplayStep, { kind: "request" }>,
  replaySessionKey: string,
) => Promise<ExecuteStepResult>;

export interface ReplayDivergence {
  index: number;
  step: ReplayStep;
  originalTreeHash: string;
  replayedTreeHash: string;
}

export interface ReplayResult {
  sessionKey: string;
  scenario: string;
  replaySessionKey: string;
  replayRef: string;
  steps: ReplayStep[];
  divergences: ReplayDivergence[];
  /** True iff every step reproduced a byte-identical tree. */
  deterministic: boolean;
}

/**
 * Re-execute `sessionKey`'s request log against a FRESH fork of the same
 * baseline scenario, diffing the resulting tree at every step against the
 * original. `executeStep` is the caller-supplied driver that actually
 * invokes a parsed request (see module doc for why this module stays
 * Fastify-agnostic).
 */
export async function replaySession(
  store: RuntimeStore,
  sessionKey: string,
  executeStep: ExecuteStep,
): Promise<ReplayResult> {
  const gitDir = store.gitDir;
  const { scenario, steps } = await parseSessionLog(gitDir, sessionKey);

  const originalTrees = await Promise.all(
    steps.map((step) => plumbing.treeOf(gitDir, step.commitHash)),
  );

  const fork = await store.fork(scenario);
  const divergences: ReplayDivergence[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "event") {
      throw new UnsupportedReplayStepError(step);
    }

    const { tipCommitHash } = await executeStep(step, fork.sessionKey);
    const replayedTree = await plumbing.treeOf(gitDir, tipCommitHash);
    const originalTree = originalTrees[i]!;
    if (replayedTree !== originalTree) {
      divergences.push({
        index: i,
        step,
        originalTreeHash: originalTree,
        replayedTreeHash: replayedTree,
      });
    }
  }

  return {
    sessionKey,
    scenario,
    replaySessionKey: fork.sessionKey,
    replayRef: fork.ref,
    steps,
    divergences,
    deterministic: divergences.length === 0,
  };
}
