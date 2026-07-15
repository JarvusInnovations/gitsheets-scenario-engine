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

export interface RegistryEntryFixture {
  id: string;
  method: string;
  path: string;
  mode: "offline-only" | "online-only" | "dual";
  behaviors: string[];
}

/**
 * A throwaway route-parity-ledger tree (its own `.gitsheets/routes.toml` +
 * `routes/<id>.toml`) for tests — mirrors scaffoldFixtures() above and, like
 * it, deliberately doesn't touch the repo's real `registry/` tree (see
 * registry/README.md: "routes/ ships empty... tests exercise the mechanism
 * against a scaffolded scratch registry"). Entries are hand-written TOML,
 * same as scaffoldFixtures' records — this is fixture *authoring*, not an
 * application write path, so it doesn't go through the gitsheets API.
 */
export function scaffoldRegistry(entries: RegistryEntryFixture[]): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "scenario-engine-registry-"));

  mkdirSync(path.join(root, ".gitsheets"), { recursive: true });
  writeFileSync(
    path.join(root, ".gitsheets", "routes.toml"),
    [
      "[gitsheet]",
      "root = 'routes'",
      "path = '${{ id }}'",
      "",
      "[gitsheet.schema]",
      "type = 'object'",
      "required = ['id', 'method', 'path', 'mode', 'behaviors']",
      "",
      "[gitsheet.schema.properties.id]",
      "type = 'string'",
      "",
      "[gitsheet.schema.properties.method]",
      "type = 'string'",
      "",
      "[gitsheet.schema.properties.path]",
      "type = 'string'",
      "",
      "[gitsheet.schema.properties.mode]",
      "type = 'string'",
      "enum = ['offline-only', 'online-only', 'dual']",
      "",
      "[gitsheet.schema.properties.behaviors]",
      "type = 'array'",
      "items.type = 'string'",
    ].join("\n") + "\n",
  );

  mkdirSync(path.join(root, "routes"), { recursive: true });
  for (const entry of entries) {
    writeFileSync(
      path.join(root, "routes", `${entry.id}.toml`),
      [
        `id = ${JSON.stringify(entry.id)}`,
        `method = ${JSON.stringify(entry.method)}`,
        `path = ${JSON.stringify(entry.path)}`,
        `mode = ${JSON.stringify(entry.mode)}`,
        `behaviors = ${JSON.stringify(entry.behaviors)}`,
      ].join("\n") + "\n",
    );
  }

  return { root };
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
  const envOverrides: Record<string, string> = {
    RUNTIME_REPO_PATH: path.join(runtimeDir, "runtime.git"),
    NODE_ENV: "test",
    ...opts.env,
  };
  // Snapshot + restore rather than leaving these set on `process.env`
  // permanently: `bun test` runs every test file in one process, so a var
  // set here (e.g. REGISTRY_PATH pointing at one test's scratch dir) would
  // otherwise leak into every test that runs afterward, across files,
  // including ones that never touch this option. Safe to restore
  // immediately after boot (success OR failure) rather than waiting for
  // `fastify.close()`: `@fastify/env` resolves `fastify.config` once during
  // registration, and everything downstream reads `fastify.config`, never
  // `process.env`, directly (see .agents/skills/jarvus-fastify's "Config
  // access" gotcha) — so the running instance doesn't need these to stay set.
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const fastify = Fastify();
  try {
    await fastify.register(app);
    if (opts.registerRoutes) {
      await opts.registerRoutes(fastify);
    }
    await fastify.ready();
    return fastify;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The absolute gitDir a running test app's engine is using — for asserting directly against git plumbing in tests. */
export function runtimeGitDir(fastify: FastifyInstance): string {
  return fastify.engine.gitDir;
}
