// Judgment by diff (specs/facade.md § Agent-sandbox profile): score an
// agent-run session's outcome against a reference session's tree diff +
// commit log, persisting the verdict as an evaluator record in a judging
// sheet that is deliberately kept OUT of any session's own tree — a run
// diffed against a reference must never be polluted by the act of recording
// its own verdict, and a verdict must outlive the sessions it judges
// (sessions are TTL'd/GC'd — see engine/session-gc.ts — but
// refs/judging/records is not).
//
// This is the *sandbox/runtime* half of the evaluation-corpus pattern
// (gitsheets recipe #229, cross-linked from plans/agent-sandbox-profile.md
// "Risks/unknowns") — the corpus/schema half (what a scenario/rubric record
// looks like) belongs to that recipe; this module owns minting isolated
// forks (see src/routes/sandbox.ts), scoring a run by diff, and persisting
// the verdict.
//
// DESIGN NOTE — mirrors src/routing/registry-store.ts: reuses the engine's
// ONE shared gitsheets Repository instance (store.repo) directly rather than
// RuntimeStore#sessionTransact (which exists to make the request=commit
// reword step atomic — irrelevant here, judging never rewords). Two
// separate Repository instances racing transact() against the same gitDir
// throw instead of queueing (see runtime-store.ts's module comment); going
// through store.repo.transact(...) funnels through gitsheets' own
// per-instance mutex, so this safely interleaves with concurrent
// session/registry reads and writes on the same instance.
import path from "node:path";
import { readFile } from "node:fs/promises";
import * as plumbing from "./plumbing.ts";
import { writeFileMapAsTree } from "./fixtures.ts";
import { sessionRef, resolveSessionScenario } from "./session.ts";
import type { RuntimeStore } from "./runtime-store.ts";

/** Non-refs/heads/ ref, like session and registry refs — see runtime-store.ts's module comment for why repo.transact's `parent`/`branch` must be passed explicitly for these. */
export const JUDGING_REF = "refs/judging/records";

const JUDGING_IDENTITY: plumbing.CommitIdentity = {
  ...plumbing.ENGINE_IDENTITY,
  date: "1970-01-01T00:00:00Z",
};

export class ScenarioMismatchError extends Error {
  constructor(
    public readonly runScenario: string,
    public readonly referenceScenario: string,
  ) {
    super(
      `cannot judge across scenarios: run session was forked from "${runScenario}", ` +
        `reference session was forked from "${referenceScenario}"`,
    );
    this.name = "ScenarioMismatchError";
  }
}

export interface JudgmentRecord {
  id: string;
  run_session: string;
  reference_session: string;
  scenario: string;
  matches: boolean;
  changed_paths: string[];
  run_commit_count: number;
  reference_commit_count: number;
  notes?: string;
  [key: string]: unknown;
}

/**
 * Ensure refs/judging/records exists, seeded with ONLY the judgments sheet's
 * schema (no records) — idempotent, and a no-op once the ref exists.
 * Contrast with src/routing/registry-import.ts, which intentionally
 * re-overwrites its ledger deterministically on every boot: the parity
 * ledger is source-tree fixture content, but judgments are live runtime
 * data written by /sandbox/judge, so re-running this after the first write
 * must never touch the ref again.
 */
export async function ensureJudgingRef(gitDir: string, fixturesRoot: string): Promise<void> {
  const existing = await plumbing.resolveRef(gitDir, JUDGING_REF);
  if (existing) return;

  const schemaBytes = await readFile(path.join(fixturesRoot, ".gitsheets", "judgments.toml"));
  const treeHash = await writeFileMapAsTree(
    gitDir,
    new Map([[".gitsheets/judgments.toml", schemaBytes]]),
  );
  const commitHash = await plumbing.commitTree(gitDir, treeHash, {
    parents: [],
    message: "judging: initialize",
    author: JUDGING_IDENTITY,
  });

  try {
    await plumbing.updateRef(gitDir, JUDGING_REF, commitHash, null);
  } catch (err) {
    // Concurrent first-writers can race this CAS; if the ref now resolves at
    // all, some process won the race (the initialize commit's content is
    // fixed by the shipped schema file, so any winner is equivalent) — not a
    // real failure.
    const now = await plumbing.resolveRef(gitDir, JUDGING_REF);
    if (!now) throw err;
  }
}

export interface JudgeRunOptions {
  runSessionKey: string;
  referenceSessionKey: string;
  notes?: string;
}

/**
 * Score `runSessionKey`'s outcome against `referenceSessionKey`: diff their
 * final trees (every sheet — orders, couriers, notifications, clock —
 * changed paths are the evidence) and compare first-parent commit-log
 * length, then persist the verdict as a record in the judgments sheet,
 * keyed deterministically by the session pair (never randomly) so
 * re-judging the same pair upserts rather than accumulates duplicates.
 * Throws SessionNotFoundError (from session.ts, re-exported by
 * runtime-store.ts) if either session doesn't exist, or
 * ScenarioMismatchError if they were forked from different scenarios —
 * comparing runs against a reference only makes sense against the same
 * starting world state.
 */
export async function judgeRun(
  store: RuntimeStore,
  opts: JudgeRunOptions,
): Promise<JudgmentRecord> {
  const gitDir = store.gitDir;

  const [runScenario, referenceScenario] = await Promise.all([
    resolveSessionScenario(gitDir, opts.runSessionKey),
    resolveSessionScenario(gitDir, opts.referenceSessionKey),
  ]);
  if (runScenario !== referenceScenario) {
    throw new ScenarioMismatchError(runScenario, referenceScenario);
  }

  const runRef = sessionRef(opts.runSessionKey);
  const referenceRef = sessionRef(opts.referenceSessionKey);

  // Both refs are guaranteed to resolve — resolveSessionScenario above would
  // have thrown SessionNotFoundError otherwise.
  const [runTip, referenceTip, runLog, referenceLog] = await Promise.all([
    plumbing.resolveRef(gitDir, runRef),
    plumbing.resolveRef(gitDir, referenceRef),
    plumbing.firstParentLog(gitDir, runRef),
    plumbing.firstParentLog(gitDir, referenceRef),
  ]);
  const [runTree, referenceTree] = await Promise.all([
    plumbing.treeOf(gitDir, runTip!),
    plumbing.treeOf(gitDir, referenceTip!),
  ]);

  const diff = await plumbing.diffTrees(gitDir, referenceTree, runTree);

  const record: JudgmentRecord = {
    id: `${opts.runSessionKey}--${opts.referenceSessionKey}`,
    run_session: opts.runSessionKey,
    reference_session: opts.referenceSessionKey,
    scenario: runScenario,
    matches: diff.length === 0,
    changed_paths: diff.map((d) => d.path).sort(),
    run_commit_count: runLog.length,
    reference_commit_count: referenceLog.length,
    ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
  };

  await ensureJudgingRef(gitDir, store.fixturesRoot);
  await store.repo.transact(
    {
      parent: JUDGING_REF,
      branch: JUDGING_REF,
      message: `judge: ${record.id}`,
      author: plumbing.ENGINE_IDENTITY,
      committer: plumbing.ENGINE_IDENTITY,
    },
    (tx) => tx.sheet<JudgmentRecord>("judgments").upsert(record),
  );

  return record;
}

export interface ListJudgmentsFilter {
  runSessionKey?: string;
}

/**
 * Read back accumulated evaluator records — a harness's readback path after
 * fanning N runs through judgeRun() against one (possibly pinned, see
 * engine/session-gc.ts) reference session. Returns `[]` if no judgment has
 * ever been recorded (the judging ref doesn't exist yet) rather than
 * requiring a caller to know to call ensureJudgingRef first.
 */
export async function listJudgments(
  store: RuntimeStore,
  filter: ListJudgmentsFilter = {},
): Promise<JudgmentRecord[]> {
  const exists = await plumbing.resolveRef(store.gitDir, JUDGING_REF);
  if (!exists) return [];

  const result = await store.repo.transact(
    { parent: JUDGING_REF, branch: JUDGING_REF, message: "(read-only)" },
    async (tx) =>
      filter.runSessionKey
        ? tx.sheet<JudgmentRecord>("judgments").queryAll({ run_session: filter.runSessionKey })
        : tx.sheet<JudgmentRecord>("judgments").queryAll(),
  );
  if (result.commitHash !== null) {
    // A "read" produced a commit — programming error, not a normal outcome.
    // Mirrors RuntimeStore#sessionRead's and readRegistry's same guard.
    throw new Error(
      `listJudgments produced a commit (${result.commitHash}) — the judgments read must not mutate`,
    );
  }
  return result.value;
}
