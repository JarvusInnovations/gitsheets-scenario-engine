// Deterministic boot-import tree construction: underlay fixtures/base/ beneath
// fixtures/scenarios/<name>/ (scenario wins on conflict), then embed
// fixtures/.gitsheets/ into the resulting tree. Pure tree-building — no git
// object writes happen until buildSheafTree() hashes the merged file map via
// the plumbing module. See specs/scenario-engine.md § Runtime store and ref
// layout, and fixtures/README.md "The overlay-and-embed rule".
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import * as plumbing from "./plumbing.ts";
import type { TreeEntry } from "./plumbing.ts";

/** A flat map of repo-root-relative POSIX path -> file bytes. */
export type FileMap = Map<string, Buffer>;

async function walkDir(root: string, base = root): Promise<FileMap> {
  const files: FileMap = new Map();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return files; // directory doesn't exist (e.g. no fixtures/.gitsheets) — empty
  }
  for (const entry of entries) {
    if (entry === ".gitkeep") continue;
    const full = join(root, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      const sub = await walkDir(full, base);
      for (const [p, bytes] of sub) files.set(p, bytes);
    } else if (s.isFile()) {
      const relPath = relative(base, full).split("\\").join("/");
      files.set(relPath, await readFile(full));
    }
  }
  return files;
}

/** Enumerate scenario names under `fixturesRoot/scenarios/`. */
export async function listScenarios(fixturesRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(fixturesRoot, "scenarios"), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Build the merged file map for one scenario's baseline: base/ underlaid
 * beneath scenarios/<name>/ (scenario wins), with .gitsheets/ embedded at the
 * tree root under `.gitsheets/`.
 */
export async function buildScenarioFileMap(
  fixturesRoot: string,
  scenarioName: string,
): Promise<FileMap> {
  const merged: FileMap = new Map();

  const base = await walkDir(join(fixturesRoot, "base"));
  for (const [p, bytes] of base) merged.set(p, bytes);

  const overlay = await walkDir(join(fixturesRoot, "scenarios", scenarioName));
  for (const [p, bytes] of overlay) merged.set(p, bytes); // overlay wins on conflict

  const gitsheets = await walkDir(join(fixturesRoot, ".gitsheets"));
  for (const [p, bytes] of gitsheets) merged.set(`.gitsheets/${p}`, bytes);

  return merged;
}

interface DirNode {
  files: Map<string, Buffer>;
  dirs: Map<string, DirNode>;
}

function insertIntoTree(root: DirNode, path: string, bytes: Buffer): void {
  const segments = path.split("/");
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    let child = node.dirs.get(seg);
    if (!child) {
      child = { files: new Map(), dirs: new Map() };
      node.dirs.set(seg, child);
    }
    node = child;
  }
  node.files.set(segments[segments.length - 1]!, bytes);
}

async function hashDirNode(gitDir: string, node: DirNode): Promise<string> {
  const entries: TreeEntry[] = [];

  // Deterministic order: sort by name (matches git tree canonical byte order
  // for these path sets — no path here contains characters that would upset
  // git's actual sort, so plain lexicographic name sort is sufficient).
  const fileNames = [...node.files.keys()].sort();
  for (const name of fileNames) {
    const bytes = node.files.get(name)!;
    const hash = await plumbing.writeBlob(gitDir, bytes);
    entries.push({ mode: "100644", type: "blob", hash, name });
  }

  const dirNames = [...node.dirs.keys()].sort();
  for (const name of dirNames) {
    const child = node.dirs.get(name)!;
    const hash = await hashDirNode(gitDir, child);
    entries.push({ mode: "040000", type: "tree", hash, name });
  }

  return plumbing.makeTree(gitDir, entries);
}

/** Write a FileMap into the git object database as a tree; returns the tree hash. */
export async function writeFileMapAsTree(gitDir: string, files: FileMap): Promise<string> {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, bytes] of files) {
    insertIntoTree(root, path, bytes);
  }
  return hashDirNode(gitDir, root);
}
