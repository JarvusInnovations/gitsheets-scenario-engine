// Unit coverage for the session-as-recording-artifact mechanism (bundle.ts)
// that harness.ts's e2eTest() calls on a failing test. Deliberately does
// NOT prove the "on failure" trigger end-to-end (that would require an
// actual failing `bun test` run, which would itself fail CI) — it proves
// the primitive `e2eTest` depends on: `git bundle create` against a live
// session ref produces a real, restorable recording. See harness.ts's
// `captureFailureArtifacts` for the (code-reviewable, not test-exercised
// here) call site.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers.ts";
import { loginInject } from "./harness.ts";
import { artifactPathFor, bundleSession } from "./bundle.ts";

let fastify: FastifyInstance;

beforeEach(async () => {
  fastify = await buildTestApp();
});

afterEach(async () => {
  await fastify.close();
});

describe("bundleSession", () => {
  test("produces a valid git bundle that restores the session's complete causal history", async () => {
    const session = await loginInject(fastify, "standard-day");
    const accept = await session.request({ method: "POST", url: "/orders/order-1001/accept" });
    expect(accept.statusCode).toBe(200);

    const destDir = mkdtempSync(path.join(tmpdir(), "e2e-bundle-test-"));
    const bundlePath = path.join(destDir, "session.bundle");
    await session.bundle(bundlePath);

    expect(existsSync(bundlePath)).toBe(true);

    // `git bundle verify` confirms the bundle is well-formed and self-contained.
    const verify = Bun.spawn({
      cmd: ["git", "bundle", "verify", bundlePath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const verifyErr = await new Response(verify.stderr).text();
    expect(await verify.exited, verifyErr).toBe(0);

    // Restoring it reproduces the exact same commit log the live session
    // has — the recording is a faithful copy, not just "a file exists".
    // `git bundle` records the ref under its original name
    // (refs/sessions/<key>), so fetch that ref explicitly.
    const fetchDir = mkdtempSync(path.join(tmpdir(), "e2e-bundle-fetch-"));
    const init = Bun.spawn({ cmd: ["git", "init", "-q", "."], cwd: fetchDir });
    expect(await init.exited).toBe(0);
    const fetch = Bun.spawn({
      cmd: ["git", "fetch", "-q", bundlePath, `${session.ref}:refs/heads/restored`],
      cwd: fetchDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const fetchErr = await new Response(fetch.stderr).text();
    expect(await fetch.exited, fetchErr).toBe(0);

    const log = Bun.spawn({
      cmd: ["git", "log", "--first-parent", "--format=%H", "refs/heads/restored"],
      cwd: fetchDir,
      stdout: "pipe",
    });
    const restoredLog = (await new Response(log.stdout).text()).trim().split("\n");
    expect(await log.exited).toBe(0);
    expect(restoredLog.length).toBe(await session.commitCount());
  });

  test("throws with the git stderr when the ref doesn't exist", async () => {
    const destPath = path.join(mkdtempSync(path.join(tmpdir(), "e2e-bundle-missing-")), "x.bundle");
    await expect(
      bundleSession(fastify.engine.gitDir, "refs/sessions/no-such-session", destPath),
    ).rejects.toThrow(/git bundle create failed/);
  });
});

describe("artifactPathFor", () => {
  test("sanitizes the test name into a filesystem-safe path under the given directory", () => {
    const p = artifactPathFor(
      'a weird test name: with "quotes" / slashes & spaces',
      "abc123-session-key",
      "/tmp/e2e-artifacts-example",
    );
    expect(path.dirname(p)).toBe("/tmp/e2e-artifacts-example");
    expect(path.basename(p)).toMatch(/^[a-zA-Z0-9_-]+--abc123-session-key\.bundle$/);
  });
});
