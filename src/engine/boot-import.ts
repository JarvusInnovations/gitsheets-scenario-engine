// Boot import: for each scenario dir under fixtures/scenarios/<name>/,
// underlay fixtures/base/ beneath the scenario overlay, embed
// fixtures/.gitsheets/, and write ONE deterministic baseline commit at
// refs/fixtures/baseline/<scenario>. See specs/scenario-engine.md § Runtime
// store and ref layout.
//
// Determinism: the baseline commit's author/committer identity and
// timestamp are fixed (ENGINE_IDENTITY, epoch), never wall-clock — so the
// same fixture bytes always produce the same tree hash *and* the same
// commit hash, across boots and across processes. Re-boot is therefore a
// true no-op: re-importing writes the identical objects and a CAS
// (old==existing, new==existing) update-ref no-op.
import * as plumbing from "./plumbing.ts";
import { buildScenarioFileMap, listScenarios, writeFileMapAsTree } from "./fixtures.ts";

export interface BootImportOptions {
  gitDir: string;
  fixturesRoot: string;
  /** Depth-1 bundled app commit to parent every baseline on, if the build shipped one. */
  appCommitHash?: string;
}

export interface BootImportResult {
  /** scenario name -> baseline commit hash */
  baselines: Map<string, string>;
}

const BASELINE_IDENTITY: plumbing.CommitIdentity = {
  ...plumbing.ENGINE_IDENTITY,
  date: "1970-01-01T00:00:00Z",
};

export function baselineRef(scenario: string): string {
  return `refs/fixtures/baseline/${scenario}`;
}

export async function runBootImport(opts: BootImportOptions): Promise<BootImportResult> {
  await plumbing.ensureBareRepo(opts.gitDir);

  const scenarios = await listScenarios(opts.fixturesRoot);
  const baselines = new Map<string, string>();

  for (const scenario of scenarios) {
    const files = await buildScenarioFileMap(opts.fixturesRoot, scenario);
    const treeHash = await writeFileMapAsTree(opts.gitDir, files);

    const parents = opts.appCommitHash ? [opts.appCommitHash] : [];
    const commitHash = await plumbing.commitTree(opts.gitDir, treeHash, {
      parents,
      message: `baseline: ${scenario}`,
      author: BASELINE_IDENTITY,
    });

    const ref = baselineRef(scenario);
    const existing = await plumbing.resolveRef(opts.gitDir, ref);
    // Re-boot no-op: only move the ref when the computed commit actually
    // differs from what's already there (identical fixtures -> identical
    // commit hash -> this is a true no-op, not just a same-tree new-commit).
    if (existing !== commitHash) {
      try {
        await plumbing.updateRef(opts.gitDir, ref, commitHash, existing ?? null);
      } catch (err) {
        // Two processes booting the same fresh runtime store concurrently can
        // race this CAS; if the ref now already points at our own
        // deterministic commit hash, a sibling process won the race with
        // byte-identical output — not a real failure.
        const now = await plumbing.resolveRef(opts.gitDir, ref);
        if (now !== commitHash) throw err;
      }
    }

    baselines.set(scenario, commitHash);
  }

  return { baselines };
}
