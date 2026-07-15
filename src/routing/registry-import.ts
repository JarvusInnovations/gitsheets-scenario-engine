// Boot-time import of the route parity ledger (registry/, a real gitsheet —
// see registry/README.md) into the runtime store as one deterministic
// commit at refs/registry/routes. Deliberately mirrors
// engine/boot-import.ts's fixture import: same split ("plumbing writes the
// tree; gitsheets reads records off the ref via repo.transact" — see
// registry-store.ts) and the same determinism discipline (fixed identity,
// fixed timestamp, CAS no-op re-import).
//
// Per specs/facade.md § Mode model: "The parity ledger is the registry
// itself — a reviewable file (a gitsheet, naturally) tracking each route's
// status with links to the scenario behaviors that define it."
import path from "node:path";
import * as plumbing from "../engine/plumbing.ts";
import { walkDir, writeFileMapAsTree, type FileMap } from "../engine/fixtures.ts";

/** Non-refs/heads/ ref, like session refs — see runtime-store.ts's module comment for why repo.transact's `parent`/`branch` must be passed explicitly for these. */
export const REGISTRY_REF = "refs/registry/routes";

const REGISTRY_IDENTITY: plumbing.CommitIdentity = {
  ...plumbing.ENGINE_IDENTITY,
  date: "1970-01-01T00:00:00Z",
};

export interface RegistryImportOptions {
  gitDir: string;
  /** Root directory holding `.gitsheets/` (sheet config) and `routes/` (ledger records) — see registry/README.md. */
  registryRoot: string;
}

export interface RegistryImportResult {
  commitHash: string;
}

export async function runRegistryImport(
  opts: RegistryImportOptions,
): Promise<RegistryImportResult> {
  await plumbing.ensureBareRepo(opts.gitDir);

  const files: FileMap = new Map();
  const gitsheets = await walkDir(path.join(opts.registryRoot, ".gitsheets"));
  for (const [p, bytes] of gitsheets) files.set(`.gitsheets/${p}`, bytes);
  const routes = await walkDir(path.join(opts.registryRoot, "routes"));
  for (const [p, bytes] of routes) files.set(`routes/${p}`, bytes);

  const treeHash = await writeFileMapAsTree(opts.gitDir, files);
  const commitHash = await plumbing.commitTree(opts.gitDir, treeHash, {
    parents: [],
    message: "registry: route parity ledger",
    author: REGISTRY_IDENTITY,
  });

  const existing = await plumbing.resolveRef(opts.gitDir, REGISTRY_REF);
  // Re-import no-op: only move the ref when the computed commit actually
  // differs — identical registry files always hash to the identical commit
  // (same determinism property as boot-import.ts's baselines).
  if (existing !== commitHash) {
    try {
      await plumbing.updateRef(opts.gitDir, REGISTRY_REF, commitHash, existing ?? null);
    } catch (err) {
      // Concurrent boots of a fresh runtime store can race this CAS; if the
      // ref now already points at our own deterministic commit hash, a
      // sibling process won the race with byte-identical output.
      const now = await plumbing.resolveRef(opts.gitDir, REGISTRY_REF);
      if (now !== commitHash) throw err;
    }
  }

  return { commitHash };
}
