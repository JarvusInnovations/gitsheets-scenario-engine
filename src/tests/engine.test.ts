import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildTestApp, scaffoldFixtures } from "./helpers.ts";
import { registerDemoRoutes } from "./support/demo-routes.ts";
import { runBootImport } from "../engine/boot-import.ts";
import * as plumbing from "../engine/plumbing.ts";
import { SESSION_HEADER } from "../plugins/engine.ts";

let fixtures: { root: string; scenario: string };
let fastify: FastifyInstance;

beforeEach(async () => {
  fixtures = scaffoldFixtures();
  fastify = await buildTestApp({
    env: { FIXTURES_PATH: fixtures.root },
    registerRoutes: registerDemoRoutes,
  });
});

afterEach(async () => {
  await fastify.close();
});

describe("boot import determinism", () => {
  test("two boots of the same fixtures produce identical baseline tree hashes", async () => {
    const gitDirA = path.join(mkdtempSync(path.join(tmpdir(), "boot-a-")), "runtime.git");
    const gitDirB = path.join(mkdtempSync(path.join(tmpdir(), "boot-b-")), "runtime.git");

    const resultA = await runBootImport({ gitDir: gitDirA, fixturesRoot: fixtures.root });
    const resultB = await runBootImport({ gitDir: gitDirB, fixturesRoot: fixtures.root });

    expect(resultA.baselines.get(fixtures.scenario)).toBeDefined();
    expect(resultA.baselines.get(fixtures.scenario)).toBe(
      resultB.baselines.get(fixtures.scenario)!,
    );

    const treeA = await plumbing.treeOf(gitDirA, resultA.baselines.get(fixtures.scenario)!);
    const treeB = await plumbing.treeOf(gitDirB, resultB.baselines.get(fixtures.scenario)!);
    expect(treeA).toBe(treeB);
  });

  test("two boots in two separate processes produce identical baseline commit hashes", async () => {
    const gitDirA = path.join(mkdtempSync(path.join(tmpdir(), "boot-proc-a-")), "runtime.git");
    const gitDirB = path.join(mkdtempSync(path.join(tmpdir(), "boot-proc-b-")), "runtime.git");

    const script = `
      import { runBootImport } from ${JSON.stringify(path.resolve(import.meta.dir, "../engine/boot-import.ts"))};
      const result = await runBootImport({ gitDir: process.argv[2], fixturesRoot: process.argv[3] });
      console.log(result.baselines.get(process.argv[4]));
    `;
    const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), "boot-script-")), "boot.mjs");
    await Bun.write(scriptPath, script);

    const runOne = async (gitDir: string) => {
      const proc = Bun.spawn(["bun", "run", scriptPath, gitDir, fixtures.root, fixtures.scenario], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`boot subprocess failed: ${err}`);
      return out.trim();
    };

    const [hashA, hashB] = await Promise.all([runOne(gitDirA), runOne(gitDirB)]);
    expect(hashA).toMatch(/^[0-9a-f]{40}$/);
    expect(hashA).toBe(hashB);
  });

  test("re-boot against the same gitDir is a no-op (ref doesn't move)", async () => {
    const gitDir = path.join(mkdtempSync(path.join(tmpdir(), "reboot-")), "runtime.git");
    const first = await runBootImport({ gitDir, fixturesRoot: fixtures.root });
    const second = await runBootImport({ gitDir, fixturesRoot: fixtures.root });
    expect(second.baselines.get(fixtures.scenario)).toBe(first.baselines.get(fixtures.scenario)!);
  });
});

describe("session fork", () => {
  test("produces the two-commit DAG with pure first-parent session history", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const gitDir = fastify.engine.gitDir;

    const log = await plumbing.firstParentLog(gitDir, fork.ref);
    expect(log).toEqual([fork.mergeCommitHash, fork.rootCommitHash]);

    const rootParents = await plumbing.parentsOf(gitDir, fork.rootCommitHash);
    expect(rootParents).toEqual([]); // parentless

    const mergeParents = await plumbing.parentsOf(gitDir, fork.mergeCommitHash);
    expect(mergeParents).toEqual([fork.rootCommitHash, expect.any(String)]);
  });

  test("Scenario-name trailer round-trips from the ref alone", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const scenario = await fastify.engine.sessionScenario(fork.sessionKey);
    expect(scenario).toBe(fixtures.scenario);
  });

  test("overlay wins over base, base fills the shared floor", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const alpha = await fastify.engine.sessionRead(fork.sessionKey, (tx) =>
      tx.sheet("examples").queryFirst({ slug: "alpha" }),
    );
    const beta = await fastify.engine.sessionRead(fork.sessionKey, (tx) =>
      tx.sheet("examples").queryFirst({ slug: "beta" }),
    );
    expect(alpha).toMatchObject({ slug: "alpha", source: "scenario" }); // overlay won
    expect(beta).toMatchObject({ slug: "beta", source: "scenario" }); // scenario-only
  });
});

describe("request = commit", () => {
  test("a mutating request produces exactly one commit with the correct shape", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const beforeLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);

    const response = await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey, "user-agent": "vitest-probe/1.0" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ slug: "alpha", touches: 1 });

    const afterLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);
    expect(afterLog.length).toBe(beforeLog.length + 1);

    const tip = afterLog[0]!;
    const message = await plumbing.commitMessage(fastify.engine.gitDir, tip);
    expect(message.split("\n")[0]).toBe("POST /examples/alpha/touch");
    expect(message).toContain("Request:");
    expect(message).toContain("Response:");

    const trailers = await plumbing.commitTrailers(fastify.engine.gitDir, tip);
    expect(trailers.Session).toBe(fork.sessionKey);
    expect(trailers.Scenario).toBe(fixtures.scenario);
    expect(trailers["Response-Code"]).toBe("200");
    expect(trailers["Request-Id"]).toBeDefined();
    expect(trailers["User-Agent"]).toBe("vitest-probe/1.0");
  });

  test("a read-only request does not create a commit", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    const beforeLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);

    const response = await fastify.inject({
      method: "GET",
      url: "/examples/alpha",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ slug: "alpha" });

    const afterLog = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);
    expect(afterLog).toEqual(beforeLog);
  });

  test("missing/unknown session is rejected before a transaction is attempted", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/examples/alpha",
      headers: { [SESSION_HEADER]: "not-a-real-session" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("session isolation", () => {
  test("two concurrent sessions never cross-contaminate reads", async () => {
    const sessionA = await fastify.engine.fork(fixtures.scenario);
    const sessionB = await fastify.engine.fork(fixtures.scenario);

    const touchResponse = await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: sessionA.sessionKey },
    });
    expect(touchResponse.statusCode).toBe(200);
    expect(touchResponse.json()).toMatchObject({ touches: 1 });

    const readA = await fastify.inject({
      method: "GET",
      url: "/examples/alpha",
      headers: { [SESSION_HEADER]: sessionA.sessionKey },
    });
    const readB = await fastify.inject({
      method: "GET",
      url: "/examples/alpha",
      headers: { [SESSION_HEADER]: sessionB.sessionKey },
    });

    expect(readA.json()).toMatchObject({ touches: 1 });
    expect(readB.json()).toMatchObject({ touches: 0 }); // untouched — B never saw A's write

    expect(sessionA.ref).not.toBe(sessionB.ref);
    const tipB = await plumbing.resolveRef(fastify.engine.gitDir, sessionB.ref);
    expect(tipB).toBe(sessionB.mergeCommitHash); // B's ref never advanced
  });

  test("two concurrent mutating requests on the SAME session serialize into two sequential commits", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);

    const [r1, r2] = await Promise.all([
      fastify.inject({
        method: "POST",
        url: "/examples/alpha/touch",
        headers: { [SESSION_HEADER]: fork.sessionKey },
      }),
      fastify.inject({
        method: "POST",
        url: "/examples/beta/touch",
        headers: { [SESSION_HEADER]: fork.sessionKey },
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const log = await plumbing.firstParentLog(fastify.engine.gitDir, fork.ref);
    expect(log.length).toBe(4); // root, merge, + 2 request commits — no lost update, no interleave corruption

    const alpha = await fastify.engine.sessionRead(fork.sessionKey, (tx) =>
      tx.sheet("examples").queryFirst({ slug: "alpha" }),
    );
    const beta = await fastify.engine.sessionRead(fork.sessionKey, (tx) =>
      tx.sheet("examples").queryFirst({ slug: "beta" }),
    );
    expect(alpha).toMatchObject({ touches: 1 });
    expect(beta).toMatchObject({ touches: 1 });
  });
});

describe("session reset", () => {
  test("reset re-forks cheaply back to the deterministic fork state", async () => {
    const fork = await fastify.engine.fork(fixtures.scenario);
    await fastify.inject({
      method: "POST",
      url: "/examples/alpha/touch",
      headers: { [SESSION_HEADER]: fork.sessionKey },
    });

    const advanced = await plumbing.resolveRef(fastify.engine.gitDir, fork.ref);
    expect(advanced).not.toBe(fork.mergeCommitHash);

    const reset = await fastify.engine.reset(fork.sessionKey);
    expect(reset.sessionKey).toBe(fork.sessionKey);
    // Deterministic fork construction: resetting reproduces the *exact* original fork commit.
    expect(reset.mergeCommitHash).toBe(fork.mergeCommitHash);
    expect(reset.rootCommitHash).toBe(fork.rootCommitHash);

    const tipNow = await plumbing.resolveRef(fastify.engine.gitDir, fork.ref);
    expect(tipNow).toBe(fork.mergeCommitHash);

    const alpha = await fastify.engine.sessionRead(fork.sessionKey, (tx) =>
      tx.sheet("examples").queryFirst({ slug: "alpha" }),
    );
    expect(alpha).toMatchObject({ touches: 0 });
  });
});
