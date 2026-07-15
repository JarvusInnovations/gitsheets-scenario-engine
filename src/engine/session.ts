// Session fork (login) and reset — the production-proven two-commit DAG.
// See specs/scenario-engine.md § Session lifecycle.
import * as plumbing from "./plumbing.ts";
import { baselineRef } from "./boot-import.ts";
import { generateSessionKey } from "./session-key.ts";

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionKey: string) {
    super(`session not found: ${sessionKey}`);
    this.name = "SessionNotFoundError";
  }
}

export class ScenarioNotFoundError extends Error {
  constructor(public readonly scenario: string) {
    super(`scenario baseline not found: ${scenario}`);
    this.name = "ScenarioNotFoundError";
  }
}

export function sessionRef(sessionKey: string): string {
  return `refs/sessions/${sessionKey}`;
}

const FORK_IDENTITY_DATE = "1970-01-01T00:00:00Z";

export interface ForkSessionOptions {
  gitDir: string;
  scenario: string;
  appVersion: string;
}

export interface ForkSessionResult {
  sessionKey: string;
  ref: string;
  rootCommitHash: string;
  mergeCommitHash: string;
}

/**
 * Fork a new session from a scenario baseline: a parentless empty-tree root
 * commit (the session's own root), then a merge commit carrying the
 * baseline's tree with parents [sessionRoot, scenarioBaseline] and a
 * Scenario-name: trailer (+ App-Version:). Points refs/sessions/<key> at the
 * merge commit.
 */
export async function forkSession(opts: ForkSessionOptions): Promise<ForkSessionResult> {
  const baselineCommitHash = await plumbing.resolveRef(opts.gitDir, baselineRef(opts.scenario));
  if (!baselineCommitHash) throw new ScenarioNotFoundError(opts.scenario);

  const sessionKey = generateSessionKey();
  return forkSessionAt({ ...opts, sessionKey, baselineCommitHash });
}

/** Fork with a caller-supplied session key and known baseline commit — the shared core of forkSession() and resetSession(). */
async function forkSessionAt(opts: {
  gitDir: string;
  sessionKey: string;
  scenario: string;
  appVersion: string;
  baselineCommitHash: string;
}): Promise<ForkSessionResult> {
  const identity = { ...plumbing.ENGINE_IDENTITY, date: FORK_IDENTITY_DATE };

  const rootCommitHash = await plumbing.commitTree(opts.gitDir, plumbing.EMPTY_TREE_HASH, {
    parents: [],
    message: `initialize session ${opts.sessionKey}`,
    author: identity,
  });

  const baselineTree = await plumbing.treeOf(opts.gitDir, opts.baselineCommitHash);
  const mergeMessage = [
    `fork session ${opts.sessionKey}`,
    "",
    `Scenario-name: ${opts.scenario}`,
    `App-Version: ${opts.appVersion}`,
  ].join("\n");

  const mergeCommitHash = await plumbing.commitTree(opts.gitDir, baselineTree, {
    parents: [rootCommitHash, opts.baselineCommitHash],
    message: mergeMessage,
    author: identity,
  });

  const ref = sessionRef(opts.sessionKey);
  await plumbing.updateRef(opts.gitDir, ref, mergeCommitHash, null);

  return { sessionKey: opts.sessionKey, ref, rootCommitHash, mergeCommitHash };
}

/**
 * Read a session's scenario identity back from its ref alone (no side
 * state): resolve the ref to the merge commit and parse its Scenario-name
 * trailer. Per spec: "the engine recovers scenario identity by reading
 * trailers from the log, never from side state."
 */
export async function resolveSessionScenario(gitDir: string, sessionKey: string): Promise<string> {
  const ref = sessionRef(sessionKey);
  const tip = await plumbing.resolveRef(gitDir, ref);
  if (!tip) throw new SessionNotFoundError(sessionKey);

  // The merge (fork) commit is the session's second first-parent-log entry
  // (index 0 is the most recent commit on the ref, which may be a later
  // request commit; walk first-parent history to the fork merge — the only
  // commit in first-parent history with two parents).
  for (const commitHash of await plumbing.firstParentLog(gitDir, ref)) {
    const parents = await plumbing.parentsOf(gitDir, commitHash);
    if (parents.length === 2) {
      const trailers = await plumbing.commitTrailers(gitDir, commitHash);
      const scenario = trailers["Scenario-name"];
      if (!scenario)
        throw new Error(
          `fork commit ${commitHash} for session ${sessionKey} is missing Scenario-name trailer`,
        );
      return scenario;
    }
  }
  throw new Error(`no fork (merge) commit found in first-parent history of session ${sessionKey}`);
}

/**
 * Reset a session: delete its ref and re-fork it from the same scenario at
 * the *current* baseline. Cheap — nothing else references session refs.
 */
export async function resetSession(opts: {
  gitDir: string;
  sessionKey: string;
  appVersion: string;
}): Promise<ForkSessionResult> {
  const scenario = await resolveSessionScenario(opts.gitDir, opts.sessionKey);
  const baselineCommitHash = await plumbing.resolveRef(opts.gitDir, baselineRef(scenario));
  if (!baselineCommitHash) throw new ScenarioNotFoundError(scenario);

  await plumbing.deleteRef(opts.gitDir, sessionRef(opts.sessionKey));

  return forkSessionAt({
    gitDir: opts.gitDir,
    sessionKey: opts.sessionKey,
    scenario,
    appVersion: opts.appVersion,
    baselineCommitHash,
  });
}
