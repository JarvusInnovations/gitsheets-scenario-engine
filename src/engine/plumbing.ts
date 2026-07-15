// Low-level git plumbing for the runtime store.
//
// DESIGN DECISION (see plans/engine-plugin.md "Key design decision"): the
// fork-DAG construction and boot import are git-plumbing operations —
// a parentless root commit, a merge commit with an explicit tree + trailers,
// deterministic tree overlay/embed — that gitsheets' `repo.transact` does not
// (and should not) directly express: transact builds a private tree by
// *copying a single parent's tree*, not by merging two source trees under
// caller-supplied parents. So boot import and session fork are implemented
// here by shelling out to `git` plumbing commands (`hash-object`, `mktree`,
// `commit-tree`, `update-ref`) via Bun's `$`. gitsheets itself is used only
// for the per-request RECORD mutations (`repo.transact` targeting the
// session ref) — see engine/runtime-store.ts.
//
// Determinism: every commit created here uses a caller-supplied identity and
// timestamp (never `new Date()` / `git config user.*`), so two boots (or two
// processes) of the same fixtures produce byte-identical trees and commits.
import { $ } from "bun";

/** A fixed, deterministic identity for commits the engine itself authors as
 * infrastructure (boot import, session fork) — never a real user. Per
 * specs/scenario-engine.md § Determinism and replay: "no wall-clock or
 * randomness may leak into record content from the engine itself." */
export const ENGINE_IDENTITY = {
  name: "gitsheets-scenario-engine",
  email: "engine@scenario-engine.invalid",
};

/** Git's well-known empty-tree object hash (SHA-1). */
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface TreeEntry {
  mode: "100644" | "100755" | "040000" | "120000";
  type: "blob" | "tree";
  hash: string;
  name: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
  /** ISO-8601 timestamp. Fixed per caller — never wall-clock inside this module. */
  date: string;
}

async function run(
  gitDir: string,
  args: string[],
  input?: string,
  env?: Record<string, string>,
): Promise<string> {
  const cmd =
    input !== undefined
      ? $`git ${args} < ${new Response(input)}`.cwd(gitDir).quiet()
      : $`git ${args}`.cwd(gitDir).quiet();
  if (env) cmd.env({ ...process.env, ...env });
  const result = await cmd;
  return result.stdout.toString().trim();
}

/** Create a bare repository at `gitDir` if one doesn't already exist. Idempotent. */
export async function ensureBareRepo(gitDir: string): Promise<void> {
  const headFile = Bun.file(`${gitDir}/HEAD`);
  if (!(await headFile.exists())) {
    await $`mkdir -p ${gitDir}`.quiet();
    await $`git init --bare -q ${gitDir}`.quiet();
  }
  // Enable reflogs for every ref update, including gitsheets' own internal
  // session-ref updates during sessionTransact — bare repos default reflogs
  // OFF. This gives the session-GC sweep (engine/session-gc.ts) a real
  // wall-clock "when was this ref last touched" signal via `git reflog`,
  // decoupled from the *commit object's* embedded date: fork/boot commits
  // pin their author/committer date to a fixed epoch (see
  // session.ts FORK_IDENTITY_DATE, boot-import.ts BASELINE_IDENTITY) so that
  // e.g. resetSession() can reproduce a byte-identical commit hash — an
  // unused, freshly-forked session would otherwise look eternally expired
  // to a sweep that read the commit's own date instead. Idempotent; safe to
  // run against an already-configured repo.
  await run(gitDir, ["config", "core.logAllRefUpdates", "always"]);
}

/** Hash and write `content` as a blob; returns its object hash. */
export async function writeBlob(gitDir: string, content: string | Buffer): Promise<string> {
  return run(gitDir, ["hash-object", "-w", "--stdin"], content.toString());
}

/** Build a tree object from entries (already-hashed blobs/trees); returns the tree hash. */
export async function makeTree(gitDir: string, entries: TreeEntry[]): Promise<string> {
  if (entries.length === 0) return EMPTY_TREE_HASH;
  const spec = entries.map((e) => `${e.mode} ${e.type} ${e.hash}\t${e.name}`).join("\n") + "\n";
  return run(gitDir, ["mktree"], spec);
}

function identityEnv(
  prefix: "AUTHOR" | "COMMITTER",
  identity: CommitIdentity,
): Record<string, string> {
  return {
    [`GIT_${prefix}_NAME`]: identity.name,
    [`GIT_${prefix}_EMAIL`]: identity.email,
    [`GIT_${prefix}_DATE`]: identity.date,
  };
}

/** Create a commit object (no ref update). Returns the commit hash. */
export async function commitTree(
  gitDir: string,
  treeHash: string,
  opts: {
    parents?: string[];
    message: string;
    author?: CommitIdentity;
    committer?: CommitIdentity;
  },
): Promise<string> {
  const author = opts.author ?? { ...ENGINE_IDENTITY, date: "1970-01-01T00:00:00Z" };
  const committer = opts.committer ?? author;
  const args = ["commit-tree", treeHash];
  for (const parent of opts.parents ?? []) {
    args.push("-p", parent);
  }
  args.push("-F", "-");
  return run(gitDir, args, opts.message, {
    ...identityEnv("AUTHOR", author),
    ...identityEnv("COMMITTER", committer),
  });
}

/**
 * Point `ref` at `newHash`. When `oldHash` is given, the update is a
 * compare-and-swap: git rejects it if `ref` doesn't currently hold that
 * value (surfaces as a thrown error — the caller's CAS-race backstop).
 * When `oldHash` is explicitly `null`, the ref must not already exist.
 */
export async function updateRef(
  gitDir: string,
  ref: string,
  newHash: string,
  oldHash?: string | null,
): Promise<void> {
  const args = ["update-ref", ref, newHash];
  if (oldHash === null) {
    args.push("0".repeat(40)); // git's "ref must not already exist" CAS sentinel
  } else if (oldHash !== undefined) {
    args.push(oldHash);
  }
  await run(gitDir, args);
}

/** Delete `ref`. No-op (does not throw) if it doesn't exist. */
export async function deleteRef(gitDir: string, ref: string): Promise<void> {
  const exists = await resolveRef(gitDir, ref);
  if (!exists) return;
  await run(gitDir, ["update-ref", "-d", ref]);
}

/** Resolve `ref` to a commit hash, or `null` if it doesn't exist. */
export async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  try {
    return await run(gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/** The tree hash a commit points at. */
export async function treeOf(gitDir: string, commitHash: string): Promise<string> {
  return run(gitDir, ["rev-parse", "--verify", `${commitHash}^{tree}`]);
}

/** First-parent commit hashes from `ref` back to its root, newest first. */
export async function firstParentLog(gitDir: string, ref: string): Promise<string[]> {
  const out = await run(gitDir, ["log", "--first-parent", "--format=%H", ref]);
  return out.length > 0 ? out.split("\n") : [];
}

/** Raw commit message (subject + body + trailers) for a commit. */
export async function commitMessage(gitDir: string, commitHash: string): Promise<string> {
  return run(gitDir, ["log", "-1", "--format=%B", commitHash]);
}

/** Parsed trailers (last value wins per key) for a commit, via `git interpret-trailers`. */
export async function commitTrailers(
  gitDir: string,
  commitHash: string,
): Promise<Record<string, string>> {
  const message = await commitMessage(gitDir, commitHash);
  const out = await run(gitDir, ["interpret-trailers", "--parse"], message);
  const trailers: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    trailers[key] = value;
  }
  return trailers;
}

/** The parent commit hashes of `commitHash`, in order. */
export async function parentsOf(gitDir: string, commitHash: string): Promise<string[]> {
  const out = await run(gitDir, ["log", "-1", "--format=%P", commitHash]);
  return out.length > 0 ? out.split(" ").filter(Boolean) : [];
}

/** The exact author identity (name, email, ISO date) recorded on a commit. */
export async function authorOf(gitDir: string, commitHash: string): Promise<CommitIdentity> {
  const out = await run(gitDir, ["log", "-1", "--format=%an%x00%ae%x00%aI", commitHash]);
  const [name, email, date] = out.split("\0");
  return {
    name: name ?? ENGINE_IDENTITY.name,
    email: email ?? ENGINE_IDENTITY.email,
    date: date ?? "1970-01-01T00:00:00Z",
  };
}

/** The exact committer identity (name, email, ISO date) recorded on a commit. */
export async function committerOf(gitDir: string, commitHash: string): Promise<CommitIdentity> {
  const out = await run(gitDir, ["log", "-1", "--format=%cn%x00%ce%x00%cI", commitHash]);
  const [name, email, date] = out.split("\0");
  return {
    name: name ?? ENGINE_IDENTITY.name,
    email: email ?? ENGINE_IDENTITY.email,
    date: date ?? "1970-01-01T00:00:00Z",
  };
}

/** Full ref names under `prefix` (e.g. `refs/sessions/`), or `[]` if none exist. */
export async function listRefs(gitDir: string, prefix: string): Promise<string[]> {
  const out = await run(gitDir, ["for-each-ref", "--format=%(refname)", prefix]);
  return out.length > 0 ? out.split("\n") : [];
}

/**
 * The real wall-clock ISO-8601 timestamp `ref` was last updated, read from
 * its reflog (see ensureBareRepo's `core.logAllRefUpdates` comment for why
 * this — not the tip commit's embedded date — is the right signal for
 * "session last active"). Falls back to the tip commit's committer date if
 * the ref has no reflog entry (e.g. a ref that predates
 * `core.logAllRefUpdates` being enabled on this repo). Returns `null` if the
 * ref doesn't resolve at all.
 */
export async function refLastUpdatedAt(gitDir: string, ref: string): Promise<string | null> {
  try {
    const out = await run(gitDir, ["reflog", "show", "--date=iso-strict", "-1", ref]);
    const match = out.match(/@\{([^}]+)\}:/);
    if (match?.[1]) return match[1];
  } catch {
    // No reflog (or no entries) for this ref — fall through to the
    // commit-date fallback below.
  }
  const commitHash = await resolveRef(gitDir, ref);
  if (!commitHash) return null;
  return (await committerOf(gitDir, commitHash)).date;
}
