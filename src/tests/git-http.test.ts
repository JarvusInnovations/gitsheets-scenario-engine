// Git exposure end-to-end coverage: a real socket (git needs one — `inject`
// only executes handlers in-process, it never opens a TCP listener) serving
// the smart-HTTP endpoint, exercised by the actual `git` CLI. See
// specs/facade.md § Git exposure, plans/git-exposure.md.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildTestApp, scaffoldFixtures } from "./helpers.ts";
import { registerDemoRoutes } from "./support/demo-routes.ts";
import * as plumbing from "../engine/plumbing.ts";
import { SESSION_HEADER } from "../plugins/engine.ts";
import { invokeGitHttpBackend } from "../plugins/git-http.ts";

const TOKEN = "test-operator-token";

let fixtures: { root: string; scenario: string };
let fastify: FastifyInstance;
let baseUrl: string;

beforeEach(async () => {
  fixtures = scaffoldFixtures();
  fastify = await buildTestApp({
    env: { FIXTURES_PATH: fixtures.root, GIT_EXPOSURE_TOKEN: TOKEN },
    registerRoutes: registerDemoRoutes,
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real TCP socket address from fastify.listen");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await fastify.close();
});

/** Run a `git` CLI command against a fresh working directory, with the operator bearer header attached. Returns {code, stdout, stderr}. */
async function runGit(
  cwd: string,
  args: string[],
  opts: { auth?: boolean } = { auth: true },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const authArgs =
    opts.auth === false ? [] : ["-c", `http.extraHeader=Authorization: Bearer ${TOKEN}`];
  const proc = Bun.spawn({
    cmd: ["git", ...authArgs, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function freshDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("git exposure: fetch retrieves full session history", () => {
  test("a git fetch of a session ref brings the session commits and the baseline (second-parent) lineage", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);

    const touchResponse = await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });
    expect(touchResponse.statusCode).toBe(200);

    const serverLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);
    expect(serverLog.length).toBe(3); // root, merge (fork), request commit

    const clientDir = freshDir("git-exposure-client-");
    const init = await runGit(clientDir, ["init", "-q", "."]);
    expect(init.code).toBe(0);

    const fetch = await runGit(clientDir, [
      "fetch",
      "-q",
      `${baseUrl}/git`,
      `${fork.ref}:refs/heads/probe`,
    ]);
    expect(fetch.code).toBe(0);

    const clientLog = await runGit(clientDir, [
      "log",
      "--first-parent",
      "--format=%H",
      "refs/heads/probe",
    ]);
    expect(clientLog.code).toBe(0);
    const clientHashes = clientLog.stdout.trim().split("\n");
    expect(clientHashes).toEqual(serverLog);

    // Second-parent edge (the fork merge commit's baseline lineage) came
    // along too — the whole point of the two-commit fork shape.
    const secondParent = await runGit(clientDir, ["rev-parse", `refs/heads/probe~1^2`]);
    expect(secondParent.code).toBe(0);
    const baselineHash = await plumbing.resolveRef(
      fastify.engine.gitDir,
      `refs/fixtures/baseline/${fixtures.scenario}`,
    );
    expect(baselineHash).not.toBeNull();
    expect(secondParent.stdout.trim()).toBe(baselineHash!);

    // git blame/log --first-parent on the records themselves is the
    // documented debugging flow — confirm it resolves against the clone.
    const blame = await runGit(clientDir, [
      "log",
      "--first-parent",
      "--format=%s",
      "refs/heads/probe",
    ]);
    expect(blame.stdout).toContain("POST /examples/alpha/touch");
    expect(blame.stdout).toContain("fork session");
    expect(blame.stdout).toContain("initialize session");
  });
});

describe("git exposure: ref advertisement scoping", () => {
  test("ls-remote lists only the advertised prefixes, never an off-pattern ref", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);

    // Deliberately plant a ref outside the advertised prefixes directly via
    // plumbing (a real `refs/heads/*` branch never occurs in this engine —
    // this proves hideRefs actually filters it, not merely that one never
    // existed).
    const tip = await plumbing.resolveRef(fastify.engine.gitDir, fork.ref);
    if (!tip) throw new Error("expected session ref to resolve");
    await plumbing.updateRef(fastify.engine.gitDir, "refs/heads/should-not-appear", tip, null);

    const clientDir = freshDir("git-exposure-lsremote-");
    const lsRemote = await runGit(clientDir, ["ls-remote", `${baseUrl}/git`]);
    expect(lsRemote.code).toBe(0);

    const refs = lsRemote.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[1])
      .filter((r): r is string => Boolean(r));

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const advertised =
        ref.startsWith("refs/fixtures/baseline/") ||
        ref.startsWith("refs/sessions/") ||
        ref.startsWith("refs/tags/sessions/");
      expect(advertised).toBe(true);
    }
    expect(refs).not.toContain("refs/heads/should-not-appear");
    expect(refs).toContain(fork.ref);
  });
});

describe("git exposure: no write path", () => {
  test("git push is refused — receive-pack is never served", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);

    const clientDir = freshDir("git-exposure-push-");
    const init = await runGit(clientDir, ["init", "-q", "."]);
    expect(init.code).toBe(0);
    await runGit(clientDir, ["config", "user.name", "probe"], { auth: false });
    await runGit(clientDir, ["config", "user.email", "probe@example.invalid"], { auth: false });
    const fetch = await runGit(clientDir, [
      "fetch",
      "-q",
      `${baseUrl}/git`,
      `${fork.ref}:refs/heads/probe`,
    ]);
    expect(fetch.code).toBe(0);

    const treeRes = await runGit(clientDir, ["rev-parse", "refs/heads/probe^{tree}"]);
    expect(treeRes.code).toBe(0);
    const commit = await runGit(clientDir, [
      "commit-tree",
      treeRes.stdout.trim(),
      "-p",
      "refs/heads/probe",
      "-m",
      "attempted push",
    ]);
    expect(commit.code).toBe(0);
    await runGit(clientDir, ["update-ref", "refs/heads/probe", commit.stdout.trim()]);

    const push = await runGit(clientDir, [
      "push",
      `${baseUrl}/git`,
      "refs/heads/probe:refs/heads/hostile",
    ]);
    expect(push.code).not.toBe(0);
    expect(`${push.stderr}${push.stdout}`.toLowerCase()).toMatch(
      /403|forbidden|not.*enabled|read-only/,
    );

    // The server-side ref set is unchanged — no hostile ref landed.
    const hostile = await plumbing.resolveRef(fastify.engine.gitDir, "refs/heads/hostile");
    expect(hostile).toBeNull();
  });
});

describe("git exposure: operator-auth gate", () => {
  test("an unauthenticated request is refused (401), no subprocess side effects observed", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/git/info/refs?service=git-upload-pack",
    });
    expect(response.statusCode).toBe(401);
  });

  test("a wrong bearer token is refused (401)", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/git/info/refs?service=git-upload-pack",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  test("the correct bearer token is accepted (200, smart-HTTP advertisement)", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/git/info/refs?service=git-upload-pack",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
  });

  test("git fetch without credentials fails against the real socket", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const clientDir = freshDir("git-exposure-noauth-");
    await runGit(clientDir, ["init", "-q", "."]);
    const fetch = await runGit(
      clientDir,
      ["fetch", "-q", `${baseUrl}/git`, `${fork.ref}:refs/heads/probe`],
      { auth: false },
    );
    expect(fetch.code).not.toBe(0);
  });

  test("an unset GIT_EXPOSURE_TOKEN fails closed even for a request presenting a token", async () => {
    const openFixtures = scaffoldFixtures();
    const openFastify = await buildTestApp({
      env: { FIXTURES_PATH: openFixtures.root, GIT_EXPOSURE_TOKEN: "" },
    });
    try {
      const response = await openFastify.inject({
        method: "GET",
        url: "/git/info/refs?service=git-upload-pack",
        headers: { authorization: "Bearer anything" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await openFastify.close();
    }
  });
});

describe("invokeGitHttpBackend: relative gitDir paths resolve correctly", () => {
  // Regression test for a bug found while exercising plans/demo-world.md's
  // demo script end-to-end against the DEFAULT config (RUNTIME_REPO_PATH
  // defaults to the relative "var/runtime.git" — see .env.example). Every
  // other test in this file builds its app via buildTestApp(), whose
  // RUNTIME_REPO_PATH is always an mkdtempSync ABSOLUTE path — so this class
  // of bug (Bun.spawn's `cwd` changing the subprocess's actual working
  // directory, then GIT_PROJECT_ROOT being resolved a second time relative
  // to THAT) never surfaced there. See invokeGitHttpBackend's module comment
  // for the exact failure mode.
  test("ref advertisement succeeds when gitDir is passed as a path relative to process.cwd()", async () => {
    // Must be a genuine DESCENDANT of process.cwd() (no ".." segments) to
    // reproduce the bug: the failure mode is specifically "the subprocess's
    // cwd becomes cwd + relativeGitDir, then GIT_PROJECT_ROOT (the same
    // relative string) is resolved a SECOND time against that new cwd." A
    // relative path built from an unrelated system tmpdir (e.g. via
    // path.relative to /tmp/...) walks up far enough via ".." that the
    // double-resolution round-trips back to the right place, masking the
    // bug — this reproduces it under `var/`, exactly like the shipped
    // default RUNTIME_REPO_PATH=var/runtime.git (`var/` is gitignored).
    const testDir = path.join(process.cwd(), "var", `test-relative-gitdir-${Date.now()}`);
    const absoluteGitDir = path.join(testDir, "r.git");
    const relativeGitDir = path.relative(process.cwd(), absoluteGitDir);
    try {
      mkdirSync(testDir, { recursive: true });
      await plumbing.ensureBareRepo(absoluteGitDir);
      const commitHash = await plumbing.commitTree(absoluteGitDir, plumbing.EMPTY_TREE_HASH, {
        parents: [],
        message: "probe",
      });
      // Under an advertised prefix (see git-http.ts's hardcoded
      // uploadpack.hideRefs injection) — otherwise a correctly-resolved but
      // empty advertisement would look identical to this bug's 404.
      await plumbing.updateRef(absoluteGitDir, "refs/sessions/probe", commitHash, null);

      const result = await invokeGitHttpBackend({
        gitDir: relativeGitDir,
        method: "GET",
        pathInfo: "/info/refs",
        queryString: "service=git-upload-pack",
        body: new Uint8Array(0),
      });

      expect(result.status).toBe(200);
      expect(result.headers["Content-Type"]).toBe("application/x-git-upload-pack-advertisement");
      expect(Buffer.from(result.body).toString("utf8")).toContain("refs/sessions/probe");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
