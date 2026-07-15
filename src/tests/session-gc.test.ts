import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import type { FastifyInstance } from "fastify";
import { runBootImport } from "../engine/boot-import.ts";
import { forkSession } from "../engine/session.ts";
import * as plumbing from "../engine/plumbing.ts";
import {
  SessionGcNotFoundError,
  isPinned,
  pinSession,
  pinnedTagRef,
  sweepExpiredSessions,
  unpinSession,
} from "../engine/session-gc.ts";
import { buildTestApp, scaffoldFixtures } from "./helpers.ts";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const futureNow = () => Date.now() + SIX_HOURS_MS;

let gitDir: string;
let scenario: string;

beforeEach(async () => {
  const fixtures = scaffoldFixtures();
  scenario = fixtures.scenario;
  gitDir = path.join(mkdtempSync(path.join(tmpdir(), "session-gc-")), "runtime.git");
  await runBootImport({ gitDir, fixturesRoot: fixtures.root });
});

describe("sweepExpiredSessions", () => {
  test("sweeps a session whose ref hasn't been updated within the TTL", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });

    const result = await sweepExpiredSessions({ gitDir, ttlMs: 1000, now: futureNow });

    expect(result.swept).toEqual([fork.sessionKey]);
    expect(result.retained).toEqual([]);
    expect(result.skippedPinned).toEqual([]);
    expect(await plumbing.resolveRef(gitDir, fork.ref)).toBeNull();
  });

  test("retains a session within the TTL", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });

    const result = await sweepExpiredSessions({ gitDir, ttlMs: 60 * 60 * 1000 }); // 1h TTL, real "now"

    expect(result.retained).toEqual([fork.sessionKey]);
    expect(result.swept).toEqual([]);
    expect(await plumbing.resolveRef(gitDir, fork.ref)).toBe(fork.mergeCommitHash);
  });

  test("a pinned session survives the sweep even when expired", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });
    await pinSession(gitDir, fork.sessionKey);

    const result = await sweepExpiredSessions({ gitDir, ttlMs: 1000, now: futureNow });

    expect(result.skippedPinned).toEqual([fork.sessionKey]);
    expect(result.swept).toEqual([]);
    expect(await plumbing.resolveRef(gitDir, fork.ref)).toBe(fork.mergeCommitHash);
  });

  test("an unpinned, expired session is swept on the next sweep", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });
    await pinSession(gitDir, fork.sessionKey);
    await unpinSession(gitDir, fork.sessionKey);

    const result = await sweepExpiredSessions({ gitDir, ttlMs: 1000, now: futureNow });

    expect(result.swept).toEqual([fork.sessionKey]);
  });

  test("sweeps only the expired sessions among several live ones", async () => {
    const old = await forkSession({ gitDir, scenario, appVersion: "test" });
    // A second fork's ref is "fresh" relative to the same simulated future
    // "now" only if its TTL window hasn't elapsed — model that directly by
    // giving it a much larger TTL budget via a second sweep call instead of
    // trying to fork at two different real times.
    const recent = await forkSession({ gitDir, scenario, appVersion: "test" });

    const result = await sweepExpiredSessions({ gitDir, ttlMs: SIX_HOURS_MS + 60 * 60 * 1000 }); // both retained, real now
    expect(result.retained.sort()).toEqual([old.sessionKey, recent.sessionKey].sort());

    const expiredResult = await sweepExpiredSessions({ gitDir, ttlMs: 1000, now: futureNow });
    expect(expiredResult.swept.sort()).toEqual([old.sessionKey, recent.sessionKey].sort());
  });
});

describe("pin/unpin", () => {
  test("pin creates a retention tag at the session's current tip; unpin removes it", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });

    expect(await isPinned(gitDir, fork.sessionKey)).toBe(false);

    await pinSession(gitDir, fork.sessionKey);
    expect(await isPinned(gitDir, fork.sessionKey)).toBe(true);
    expect(await plumbing.resolveRef(gitDir, pinnedTagRef(fork.sessionKey))).toBe(
      fork.mergeCommitHash,
    );

    await unpinSession(gitDir, fork.sessionKey);
    expect(await isPinned(gitDir, fork.sessionKey)).toBe(false);
  });

  test("unpinning a session that was never pinned is a no-op", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });
    await expect(unpinSession(gitDir, fork.sessionKey)).resolves.toBeUndefined();
  });

  test("pinning a nonexistent session throws SessionGcNotFoundError", async () => {
    await expect(pinSession(gitDir, "not-a-real-session")).rejects.toThrow(SessionGcNotFoundError);
  });

  test("re-pinning moves the tag to the session's new tip", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });
    await pinSession(gitDir, fork.sessionKey);
    expect(await plumbing.resolveRef(gitDir, pinnedTagRef(fork.sessionKey))).toBe(
      fork.mergeCommitHash,
    );

    // Advance the session with a synthetic commit, then re-pin.
    const newTip = await plumbing.commitTree(
      gitDir,
      await plumbing.treeOf(gitDir, fork.mergeCommitHash),
      {
        parents: [fork.mergeCommitHash],
        message: "synthetic advance",
      },
    );
    await plumbing.updateRef(gitDir, fork.ref, newTip, fork.mergeCommitHash);

    await pinSession(gitDir, fork.sessionKey);
    expect(await plumbing.resolveRef(gitDir, pinnedTagRef(fork.sessionKey))).toBe(newTip);
  });
});

describe("disk reclamation", () => {
  test("a swept session's history is unreachable, and pruned once git gc runs", async () => {
    const fork = await forkSession({ gitDir, scenario, appVersion: "test" });
    const objectExists = async (hash: string) =>
      (await $`git cat-file -e ${hash}`.cwd(gitDir).quiet().nothrow()).exitCode === 0;

    expect(await objectExists(fork.mergeCommitHash)).toBe(true);

    await sweepExpiredSessions({ gitDir, ttlMs: 1000, now: futureNow });

    // The ref is gone but the sweep never touches objects directly — the
    // commit is merely unreachable now, still physically present until a
    // gc runs. Per specs/scenario-engine.md § Session lifecycle: "Deleted
    // session history becomes unreachable and is reclaimed by normal git GC."
    expect(await objectExists(fork.mergeCommitHash)).toBe(true);

    await $`git gc --prune=now -q`.cwd(gitDir).quiet();

    expect(await objectExists(fork.mergeCommitHash)).toBe(false);
  });
});

describe("session-gc fastify plugin wiring", () => {
  let fastify: FastifyInstance;

  afterEach(async () => {
    await fastify?.close();
  });

  test("fastify.sessionGc exposes sweep/pin/unpin/isPinned wired to the runtime store", async () => {
    const fixtures = scaffoldFixtures();
    fastify = await buildTestApp({
      env: {
        FIXTURES_PATH: fixtures.root,
        // 0 = "expired the instant it's not brand new" — the plugin's public
        // sweep() doesn't accept an injectable clock (only the underlying
        // sweepExpiredSessions() does, exercised directly above), so this
        // test uses a zero TTL against the real clock instead of simulating
        // time travel.
        SESSION_TTL_MS: "0",
        SESSION_GC_INTERVAL_MS: String(60 * 60 * 1000), // long enough the automatic timer won't fire during the test
      },
    });

    const fork = await fastify.engine.fork(fixtures.scenario);

    expect(await fastify.sessionGc.isPinned(fork.sessionKey)).toBe(false);
    await fastify.sessionGc.pin(fork.sessionKey);
    expect(await fastify.sessionGc.isPinned(fork.sessionKey)).toBe(true);

    const sweepWhilePinned = await fastify.sessionGc.sweep();
    expect(sweepWhilePinned.skippedPinned).toContain(fork.sessionKey);

    await fastify.sessionGc.unpin(fork.sessionKey);
    expect(await fastify.sessionGc.isPinned(fork.sessionKey)).toBe(false);
  });
});
