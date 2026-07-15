// Session lifecycle: TTL sweep + pin/unpin retention. See
// specs/scenario-engine.md § Session lifecycle (Expire/GC):
//
//   "Expire/GC — sessions are leases: a TTL since last commit, enforced by
//   a sweep that deletes expired refs. Deleted session history becomes
//   unreachable and is reclaimed by normal git GC. Retention overrides
//   (e.g. keep a session pinned for debugging) are a tag:
//   refs/tags/sessions/<key>/pinned."
//
// This module only ever deletes refs (refs/sessions/<key> and, on unpin,
// the retention tag) — it never touches objects. Reclaiming the unreachable
// commits/trees/blobs left behind is normal `git gc`'s job, run on whatever
// cadence the deployment configures for the runtime repo (out of scope
// here; see specs/scenario-engine.md § gitsheets 2.x mapping,
// "Ephemeral-ref GC cost").
//
// "Last commit" for TTL purposes is read via plumbing.refLastUpdatedAt
// (the ref's reflog), NOT the tip commit's embedded committer date — see
// that function's doc comment and plumbing.ensureBareRepo's
// core.logAllRefUpdates comment for why: fork commits pin their date to a
// fixed epoch for hash-reproducibility (session.ts FORK_IDENTITY_DATE), so
// an unused, freshly-forked session's tip commit always carries a
// 1970-01-01 date and would look eternally expired to a sweep that read it
// directly.
import * as plumbing from "./plumbing.ts";
import { sessionRef } from "./session.ts";

const SESSION_REF_PREFIX = "refs/sessions/";

/** The retention tag ref for a session key. Presence exempts the session from the TTL sweep. */
export function pinnedTagRef(sessionKey: string): string {
  return `refs/tags/sessions/${sessionKey}/pinned`;
}

export class SessionGcNotFoundError extends Error {
  constructor(public readonly sessionKey: string) {
    super(`session not found: ${sessionKey}`);
    this.name = "SessionGcNotFoundError";
  }
}

async function listSessionKeys(gitDir: string): Promise<string[]> {
  const refs = await plumbing.listRefs(gitDir, SESSION_REF_PREFIX);
  return refs.map((ref) => ref.slice(SESSION_REF_PREFIX.length));
}

/** Whether `sessionKey` currently carries the pinned retention tag. */
export async function isPinned(gitDir: string, sessionKey: string): Promise<boolean> {
  return (await plumbing.resolveRef(gitDir, pinnedTagRef(sessionKey))) !== null;
}

/**
 * Create (or refresh, if already pinned) the retention tag at the session
 * ref's current tip. Idempotent — safe to call repeatedly, e.g. to move the
 * pin forward as a debugging session keeps accumulating commits.
 */
export async function pinSession(gitDir: string, sessionKey: string): Promise<void> {
  const commitHash = await plumbing.resolveRef(gitDir, sessionRef(sessionKey));
  if (!commitHash) throw new SessionGcNotFoundError(sessionKey);
  await plumbing.updateRef(gitDir, pinnedTagRef(sessionKey), commitHash);
}

/** Remove the retention tag. No-op if the session isn't pinned. */
export async function unpinSession(gitDir: string, sessionKey: string): Promise<void> {
  await plumbing.deleteRef(gitDir, pinnedTagRef(sessionKey));
}

export interface SweepOptions {
  gitDir: string;
  /** Sessions whose ref hasn't been updated in at least this many ms are swept. */
  ttlMs: number;
  /** Injectable "now" (epoch ms) for deterministic tests; defaults to the real clock. */
  now?: () => number;
}

export interface SweepResult {
  /** Session keys whose ref was deleted this sweep. */
  swept: string[];
  /** Session keys that were expired but skipped because they carry the pinned tag. */
  skippedPinned: string[];
  /** Session keys that are not yet expired. */
  retained: string[];
}

/**
 * Delete `refs/sessions/<key>` for every session whose ref has gone
 * untouched for at least `ttlMs`, skipping any that carry the pinned
 * retention tag. Never deletes objects — only refs (see module doc).
 */
export async function sweepExpiredSessions(opts: SweepOptions): Promise<SweepResult> {
  const now = (opts.now ?? Date.now)();
  const keys = await listSessionKeys(opts.gitDir);
  const result: SweepResult = { swept: [], skippedPinned: [], retained: [] };

  for (const key of keys) {
    const ref = sessionRef(key);
    const lastUpdated = await plumbing.refLastUpdatedAt(opts.gitDir, ref);
    if (!lastUpdated) {
      // Listed by for-each-ref but unresolvable/no timestamp — leave it
      // alone rather than guess; a real anomaly here is worth investigating,
      // not silently sweeping.
      result.retained.push(key);
      continue;
    }

    const age = now - Date.parse(lastUpdated);
    if (age < opts.ttlMs) {
      result.retained.push(key);
      continue;
    }

    if (await isPinned(opts.gitDir, key)) {
      result.skippedPinned.push(key);
      continue;
    }

    await plumbing.deleteRef(opts.gitDir, ref);
    result.swept.push(key);
  }

  return result;
}
