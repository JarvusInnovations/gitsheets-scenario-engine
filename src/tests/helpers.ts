// Shared test bootstrap. The engine plugin (src/plugins/engine.ts) boots a
// real runtime store (a bare git repo) as part of registering `app`, so
// every test that builds the app needs an isolated RUNTIME_REPO_PATH — a
// shared path would let concurrent/successive test runs stomp on each
// other's session refs. FIXTURES_PATH defaults to the repo's real,
// read-only `fixtures/` tree, which is safe to share.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { app } from "../app.ts";

/**
 * Build a throwaway fixtures/ tree (its own `.gitsheets/`, `base/`,
 * `scenarios/<name>/`) for tests — deliberately NOT touching the repo's real
 * `fixtures/` tree, which `plans/demo-world.md` owns (see
 * fixtures/README.md: "scenarios/standard-day/ ships empty ... the
 * demo-world plan populates it"). One sheet, `examples`, mirrors the
 * existing fixtures/.gitsheets/example.toml placeholder shape.
 */
export function scaffoldFixtures(): { root: string; scenario: string } {
  const root = mkdtempSync(path.join(tmpdir(), "scenario-engine-fixtures-"));
  const scenario = "smoke";

  mkdirSync(path.join(root, ".gitsheets"), { recursive: true });
  writeFileSync(
    path.join(root, ".gitsheets", "examples.toml"),
    [
      "[gitsheet]",
      "root = 'examples'",
      "path = '${{ slug }}'",
      "",
      "[gitsheet.schema]",
      "type = 'object'",
      "required = ['slug']",
      "",
      "[gitsheet.schema.properties.slug]",
      "type = 'string'",
    ].join("\n") + "\n",
  );

  mkdirSync(path.join(root, "base", "examples"), { recursive: true });
  writeFileSync(
    path.join(root, "base", "examples", "alpha.toml"),
    'slug = "alpha"\nsource = "base"\ntouches = 0\n',
  );

  mkdirSync(path.join(root, "scenarios", scenario, "examples"), { recursive: true });
  // Overlay wins on conflict: redefines alpha's `source`.
  writeFileSync(
    path.join(root, "scenarios", scenario, "examples", "alpha.toml"),
    'slug = "alpha"\nsource = "scenario"\ntouches = 0\n',
  );
  // Scenario-only record, absent from base.
  writeFileSync(
    path.join(root, "scenarios", scenario, "examples", "beta.toml"),
    'slug = "beta"\nsource = "scenario"\ntouches = 0\n',
  );

  return { root, scenario };
}

export interface TestAppOptions {
  /** Extra env overrides applied before registration (e.g. FIXTURES_PATH for a custom fixture tree). */
  env?: Record<string, string>;
  /**
   * Register additional routes/plugins before the instance is marked ready.
   * Fastify forbids adding routes after `ready()` — a test that needs a
   * throwaway route (see tests/support/demo-routes.ts) must register it
   * here rather than after `buildTestApp` resolves.
   */
  registerRoutes?: (fastify: FastifyInstance) => Promise<void> | void;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "scenario-engine-runtime-"));
  process.env.RUNTIME_REPO_PATH = path.join(runtimeDir, "runtime.git");
  process.env.NODE_ENV = "test";
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    process.env[key] = value;
  }

  const fastify = Fastify();
  await fastify.register(app);
  if (opts.registerRoutes) {
    await opts.registerRoutes(fastify);
  }
  await fastify.ready();
  return fastify;
}

/** The absolute gitDir a running test app's engine is using — for asserting directly against git plumbing in tests. */
export function runtimeGitDir(fastify: FastifyInstance): string {
  return fastify.engine.gitDir;
}
