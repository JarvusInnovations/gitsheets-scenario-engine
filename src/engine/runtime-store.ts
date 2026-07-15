// The engine's runtime store: a bare git repository holding scenario
// baselines and live sessions, plus the single gitsheets Repository handle
// used for all per-session record transactions.
//
// KEY DESIGN DECISION — a single shared gitsheets `Repository` instance for
// the whole process, not "one handle per session" as
// specs/scenario-engine.md § gitsheets mapping literally suggests.
//
// Verified empirically against gitsheets 2.4.0 (see PR description for the
// probe scripts): `repo.transact` DOES accept a non-`refs/heads/` ref (e.g.
// `refs/sessions/<key>`) via `parent`/`branch`, resolves it correctly, and
// commits/no-ops exactly as documented — the spec's central assumption
// holds. However, the *concurrency* mechanism the spec recommends does not:
// the native core enforces "one open transaction per physical gitDir" as a
// hard *throw* (`TransactionError('transaction_in_progress')`), not a queue,
// when two *different* `Repository` JS instances race a `transact` call
// against the same gitDir — even though `specs/behaviors/transactions.md`
// describes concurrent-but-independent transact calls as queueing "on an
// in-process mutex". Reading the shipped source
// (node_modules/gitsheets/dist/repository.js), that fair queue is a
// per-*instance* JS `Mutex`, not a per-gitDir one — so it only serializes
// calls made through the *same* Repository object. Two fresh instances (as
// "one handle per session" implies opening one per request) hit the core's
// throwing guard instead of queueing, non-deterministically, under any
// concurrent cross-session load.
//
// Using one shared instance restores the documented queueing behavior (its
// mutex now serializes every transact call process-wide, regardless of
// which session ref they target) and sidesteps a second, independent issue:
// `Repository.openSheet()` binds unconditionally to the *literal git `HEAD`
// ref* of the gitDir (see `#resolveReadTree` in repository.js) — never to
// whatever ref a transaction targeted — so it cannot be used for
// session-scoped reads at all regardless of instance-per-session. All
// session data access in this engine therefore goes through
// `repo.transact({ parent: sessionRef, branch: sessionRef }, tx => tx.sheet(...))`
// exclusively (see sessionTransact/sessionRead below), including read-only
// requests — relying on transact's no-op detection (unchanged tree -> no
// commit) to keep reads commit-free, per specs/scenario-engine.md § Request
// = commit ("Read-only requests do not commit by default").
//
// Trade-off this creates: all sessions' commit-phase now serializes through
// one process-wide mutex rather than achieving true git-level parallelism
// across sessions (specs/scenario-engine.md § Concurrency: "Cross-session
// concurrency is unlimited"). Given per-transaction work here is a single
// small sheet write, this is expected to be inexpensive in practice, but it
// is a real, flagged deviation — see plans/engine-plugin.md Notes and the
// PR description for the follow-up.
import { openRepo, type Repository, type Transaction } from "gitsheets";
import * as plumbing from "./plumbing.ts";
import { runBootImport } from "./boot-import.ts";
import {
  forkSession,
  resetSession,
  resolveSessionFork,
  resolveSessionScenario,
  sessionRef,
  SessionNotFoundError,
} from "./session.ts";
import type { ForkSessionResult } from "./session.ts";

export { SessionNotFoundError, ScenarioNotFoundError } from "./session.ts";

export interface RuntimeStoreOptions {
  gitDir: string;
  fixturesRoot: string;
  appVersion: string;
  appCommitHash?: string;
}

export interface SessionTransactResult<T> {
  value: T;
  commitHash: string | null;
}

export interface SessionTransactOptions<T> {
  sessionKey: string;
  /** Commit subject + body, known before the handler runs. */
  message: string;
  trailers?: Record<string, string>;
  /** Authenticated principal; defaults to the engine's own identity for non-request (EVENT) commits. */
  author?: { name: string; email: string };
  handler: (tx: Transaction) => Promise<T>;
  /**
   * Runs after the handler resolves and the transaction has committed (or
   * no-opped). If it returns a value AND a commit was produced, the commit
   * is atomically reworded (same tree, same parent — see reword in
   * plumbing.ts) to the returned message/trailers via a CAS update-ref. Lets
   * callers (e.g. request=commit wrapping) embed response data that's only
   * known after the handler runs, without a second gitsheets transaction.
   */
  finalize?: (
    result: SessionTransactResult<T>,
  ) => { message: string; trailers?: Record<string, string> } | undefined;
}

/**
 * Minimal FIFO async mutex. gitsheets' own per-instance mutex (see the
 * module comment) only guards the `repo.transact` call itself — it releases
 * the instant that call resolves, *before* sessionTransact's post-commit
 * reword step runs. Two concurrent sessionTransact calls on the same
 * Repository would otherwise interleave: call A's transact() commits and
 * releases the gitsheets mutex, call B's transact() immediately starts and
 * advances the session ref again, and call A's reword — which CAS-updates
 * the ref from *its own* pre-reword commit hash — now targets a ref that's
 * already moved out from under it and fails. Wrapping transact+reword as
 * one unit behind this mutex makes them atomic relative to each other.
 */
class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class RuntimeStore {
  readonly gitDir: string;
  readonly fixturesRoot: string;
  readonly appVersion: string;
  readonly appCommitHash: string | undefined;
  #repo: Repository | undefined;
  #booted = false;
  #writeMutex = new AsyncMutex();

  constructor(opts: RuntimeStoreOptions) {
    this.gitDir = opts.gitDir;
    this.fixturesRoot = opts.fixturesRoot;
    this.appVersion = opts.appVersion;
    this.appCommitHash = opts.appCommitHash;
  }

  /** Ensure the bare repo exists and run boot import. Idempotent — safe to call more than once. */
  async boot(): Promise<void> {
    await runBootImport({
      gitDir: this.gitDir,
      fixturesRoot: this.fixturesRoot,
      appCommitHash: this.appCommitHash,
    });
    this.#repo = await openRepo({ gitDir: this.gitDir });
    this.#booted = true;
  }

  get repo(): Repository {
    if (!this.#repo) throw new Error("RuntimeStore.boot() must be called before use");
    return this.#repo;
  }

  get booted(): boolean {
    return this.#booted;
  }

  /**
   * `opts.modeOverride` (specs/facade.md § Mode model): the backend a login
   * pins this session to for `dual` routes, recorded as a trailer on the
   * fork commit. Left undefined, the deployment default applies instead —
   * see src/routing/mode.ts.
   */
  async fork(scenario: string, opts?: { modeOverride?: string }): Promise<ForkSessionResult> {
    return forkSession({
      gitDir: this.gitDir,
      scenario,
      appVersion: this.appVersion,
      modeOverride: opts?.modeOverride,
    });
  }

  async reset(sessionKey: string): Promise<ForkSessionResult> {
    return resetSession({ gitDir: this.gitDir, sessionKey, appVersion: this.appVersion });
  }

  async sessionExists(sessionKey: string): Promise<boolean> {
    return (await plumbing.resolveRef(this.gitDir, sessionRef(sessionKey))) !== null;
  }

  async sessionScenario(sessionKey: string): Promise<string> {
    return resolveSessionScenario(this.gitDir, sessionKey);
  }

  /** Scenario + per-session backend override in one trailer read — see resolveSessionFork(). */
  async sessionFork(sessionKey: string): Promise<{ scenario: string; modeOverride?: string }> {
    return resolveSessionFork(this.gitDir, sessionKey);
  }

  /**
   * Run `handler` inside one gitsheets transaction targeting the session
   * ref, then optionally reword the resulting commit's message/trailers via
   * `finalize`. See the module-level comment for why this always goes
   * through repo.transact (never repo.openSheet) and why there is exactly
   * one shared Repository instance.
   */
  async sessionTransact<T>(opts: SessionTransactOptions<T>): Promise<SessionTransactResult<T>> {
    if (!(await this.sessionExists(opts.sessionKey))) {
      throw new SessionNotFoundError(opts.sessionKey);
    }
    const ref = sessionRef(opts.sessionKey);

    // transact() + the post-commit reword must be atomic relative to other
    // sessionTransact calls — see the AsyncMutex doc comment above.
    const out = await this.#writeMutex.run(async () => {
      const result = await this.repo.transact(
        {
          parent: ref,
          branch: ref,
          message: opts.message,
          trailers: opts.trailers,
          author: opts.author ?? plumbing.ENGINE_IDENTITY,
          committer: plumbing.ENGINE_IDENTITY,
        },
        opts.handler,
      );

      const out: SessionTransactResult<T> = { value: result.value, commitHash: result.commitHash };

      if (result.commitHash !== null && opts.finalize) {
        const finalMsg = opts.finalize(out);
        if (finalMsg) {
          await this.#rewordCommit(ref, result.commitHash, finalMsg.message, finalMsg.trailers);
        }
      }

      return out;
    });

    return out;
  }

  /**
   * Read-only convenience over sessionTransact: runs `handler` for its
   * return value only. Relies on gitsheets' no-op detection (no staged
   * mutation -> tree unchanged -> no commit) to guarantee reads never
   * advance the session ref, matching specs/scenario-engine.md § Request =
   * commit ("Read-only requests do not commit by default").
   */
  async sessionRead<T>(sessionKey: string, handler: (tx: Transaction) => Promise<T>): Promise<T> {
    const result = await this.sessionTransact({
      sessionKey,
      message: "(read-only)",
      handler,
    });
    if (result.commitHash !== null) {
      // A "read" handler mutated something — a programming error in the
      // caller, not a normal outcome. Surface loudly rather than silently
      // accept an unexpected commit on what was declared a read.
      throw new Error(
        `sessionRead handler for session ${sessionKey} produced a commit (${result.commitHash}) — reads must not mutate`,
      );
    }
    return result.value;
  }

  /** Atomically reword a commit's message/trailers in place (same tree, same parents) via CAS update-ref. */
  async #rewordCommit(
    ref: string,
    commitHash: string,
    message: string,
    trailers?: Record<string, string>,
  ): Promise<void> {
    const treeHash = await plumbing.treeOf(this.gitDir, commitHash);
    const parents = await plumbing.parentsOf(this.gitDir, commitHash);
    const fullMessage =
      trailers && Object.keys(trailers).length > 0 ? appendTrailers(message, trailers) : message;
    // Preserve the original author/committer identity and timestamps across
    // the reword — only the message/trailers change; who-did-it and when
    // must not shift just because the response arrived after the write.
    const [author, committer] = await Promise.all([
      plumbing.authorOf(this.gitDir, commitHash),
      plumbing.committerOf(this.gitDir, commitHash),
    ]);
    const newCommitHash = await plumbing.commitTree(this.gitDir, treeHash, {
      parents,
      message: fullMessage,
      author,
      committer,
    });
    await plumbing.updateRef(this.gitDir, ref, newCommitHash, commitHash);
  }
}

function appendTrailers(message: string, trailers: Record<string, string>): string {
  const trailerBlock = Object.entries(trailers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `${message.replace(/\n+$/, "")}\n\n${trailerBlock}`;
}
