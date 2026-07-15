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
  /**
   * Per-session backend override for `dual` routes, set at login
   * (specs/facade.md § Mode model: "overridable per session at login for
   * dual routes"). Recorded as a `Mode-Override:` trailer on the fork merge
   * commit — same self-describing-from-the-ref-alone treatment as
   * `Scenario-name:`. Untyped here (plain string) deliberately: session.ts
   * has no business knowing the routing layer's `Backend` union; the
   * routing plugin (src/routing/mode.ts) validates/narrows it on read.
   */
  modeOverride?: string;
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
  modeOverride?: string;
}): Promise<ForkSessionResult> {
  const identity = { ...plumbing.ENGINE_IDENTITY, date: FORK_IDENTITY_DATE };

  const rootCommitHash = await plumbing.commitTree(opts.gitDir, plumbing.EMPTY_TREE_HASH, {
    parents: [],
    message: `initialize session ${opts.sessionKey}`,
    author: identity,
  });

  const baselineTree = await plumbing.treeOf(opts.gitDir, opts.baselineCommitHash);
  const mergeMessageLines = [
    `fork session ${opts.sessionKey}`,
    "",
    `Scenario-name: ${opts.scenario}`,
    `App-Version: ${opts.appVersion}`,
  ];
  // Only present when a login explicitly chose a backend for `dual` routes —
  // absent by default, which preserves the exact merge-commit bytes (and
  // therefore hash) of every existing fork() call site untouched by this.
  if (opts.modeOverride) {
    mergeMessageLines.push(`Mode-Override: ${opts.modeOverride}`);
  }
  const mergeMessage = mergeMessageLines.join("\n");

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
 * Read a session's fork (merge) commit's trailers back from its ref alone
 * (no side state) — the shared core behind resolveSessionScenario() and
 * resolveSessionFork() below. Per spec: "the engine recovers scenario
 * identity by reading trailers from the log, never from side state."
 */
async function forkTrailers(gitDir: string, sessionKey: string): Promise<Record<string, string>> {
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
      return plumbing.commitTrailers(gitDir, commitHash);
    }
  }
  throw new Error(`no fork (merge) commit found in first-parent history of session ${sessionKey}`);
}

/** Read a session's scenario identity back from its ref alone. */
export async function resolveSessionScenario(gitDir: string, sessionKey: string): Promise<string> {
  const trailers = await forkTrailers(gitDir, sessionKey);
  const scenario = trailers["Scenario-name"];
  if (!scenario)
    throw new Error(`fork commit for session ${sessionKey} is missing Scenario-name trailer`);
  return scenario;
}

/**
 * Read a session's scenario identity + optional per-session backend
 * override back from its ref alone in one trailer read (used by the
 * session-resolution onRequest hook, which needs both per request). See
 * ForkSessionOptions.modeOverride for why the override is untyped here.
 */
export async function resolveSessionFork(
  gitDir: string,
  sessionKey: string,
): Promise<{ scenario: string; modeOverride?: string }> {
  const trailers = await forkTrailers(gitDir, sessionKey);
  const scenario = trailers["Scenario-name"];
  if (!scenario)
    throw new Error(`fork commit for session ${sessionKey} is missing Scenario-name trailer`);
  return { scenario, modeOverride: trailers["Mode-Override"] };
}

/**
 * Reset a session: delete its ref and re-fork it from the same scenario (and
 * the same mode override, if any) at the *current* baseline. Cheap — nothing
 * else references session refs.
 */
export async function resetSession(opts: {
  gitDir: string;
  sessionKey: string;
  appVersion: string;
}): Promise<ForkSessionResult> {
  const { scenario, modeOverride } = await resolveSessionFork(opts.gitDir, opts.sessionKey);
  const baselineCommitHash = await plumbing.resolveRef(opts.gitDir, baselineRef(scenario));
  if (!baselineCommitHash) throw new ScenarioNotFoundError(scenario);

  await plumbing.deleteRef(opts.gitDir, sessionRef(opts.sessionKey));

  return forkSessionAt({
    gitDir: opts.gitDir,
    sessionKey: opts.sessionKey,
    scenario,
    appVersion: opts.appVersion,
    baselineCommitHash,
    modeOverride,
  });
}
