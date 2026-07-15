// Session-as-recording artifact. specs/facade.md § E2E harness: "Test
// recordings (video/logs) attach naturally: the session ref *is* the state
// recording; bundle it (`git bundle`) as a CI artifact alongside media."
//
// This module is the mechanism only (spawn `git bundle create`); harness.ts
// decides WHEN to call it (on e2e test failure — see e2eTest()) and
// .github/workflows/ci.yml decides what happens to the result (uploads
// E2E_ARTIFACTS_DIR as an artifact when the Test step fails).
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Where failing e2e tests write session bundles. Overridable via
 * E2E_ARTIFACTS_DIR (CI sets it to an absolute path under the checkout so
 * the upload-artifact step's relative `path:` — `var/e2e-artifacts` —
 * resolves the same directory regardless of cwd); local runs fall back to
 * `var/e2e-artifacts` in the repo root, which `.gitignore`'s `var` entry
 * already covers.
 */
export const E2E_ARTIFACTS_DIR =
  process.env.E2E_ARTIFACTS_DIR ?? path.resolve(import.meta.dir, "../../../var/e2e-artifacts");

/** `git bundle create` for one ref — the complete causal history reachable from it (fork lineage included, via the merge commit's second parent). */
export async function bundleSession(gitDir: string, ref: string, destPath: string): Promise<void> {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const proc = Bun.spawn({
    cmd: ["git", "bundle", "create", destPath, ref],
    cwd: gitDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git bundle create failed for ${ref} in ${gitDir}: ${stderr.trim()}`);
  }
}

/** Filesystem-safe artifact filename for a (test name, session key) pair. */
export function artifactPathFor(
  testName: string,
  sessionKey: string,
  dir: string = E2E_ARTIFACTS_DIR,
): string {
  const safeName = testName
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return path.join(dir, `${safeName || "e2e"}--${sessionKey}.bundle`);
}
