import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// specs/scenario-engine.md § Determinism and replay:
//
//   "no wall-clock or randomness may leak into record content from the
//   engine itself; simulated time is a record ... any id generation is
//   derived ... Session keys are the one sanctioned use of clock/randomness
//   ... a key names a ref, it never enters record content or trees."
//
// This is a static regression guard, not a runtime one: it greps
// src/engine and src/plugins (the layers that touch the runtime store and
// session refs) for Date.now()/new Date()/Math.random() and fails if any
// file outside the documented allowlist uses them. It exists so a future
// change can't silently reintroduce nondeterminism into a request-handling
// or tree-writing code path without a deliberate, reviewed update to this
// list. src/tests/support/nondeterministic-routes.ts is the intentional
// counter-example (see src/tests/replay.test.ts "determinism guard") and is
// excluded from this scan by construction — it lives under src/tests, not
// src/engine or src/plugins.
const ALLOWLIST = new Set([
  // Sanctioned per spec: a session key names a ref, never enters record
  // content or trees, so its nondeterminism cannot affect replay.
  "src/engine/session-key.ts",
  // TTL sweep wall-clock: governs which REFS get deleted, never writes
  // tree/record content. See src/engine/session-gc.ts's module doc for why
  // "last commit" is read from the ref's reflog rather than trusting the
  // (sometimes deterministically-epoch-pinned) commit object date.
  "src/engine/session-gc.ts",
  // Sweep interval timer wiring only — no tree/record access at all.
  "src/plugins/session-gc.ts",
]);

const CLOCK_RANDOM_RE = /\bDate\.now\(\)|\bnew Date\(\)|\bMath\.random\(\)/;

/** Strip `//`-comment lines before scanning, so a doc comment that merely
 * *mentions* `Date.now()` (as several files in this codebase's determinism
 * notes do) isn't mistaken for a real call. Not a full tokenizer — doesn't
 * handle `/* ... *\/` block comments or strings containing `//` — but
 * matches this codebase's actual comment style. */
function stripLineComments(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) listTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("determinism guards", () => {
  test("Date.now()/new Date()/Math.random() only appear in the sanctioned allowlist", () => {
    const root = path.resolve(import.meta.dir, "../..");
    const scanDirs = ["src/engine", "src/plugins"];
    const files = scanDirs.flatMap((dir) => listTsFiles(path.join(root, dir)));

    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (ALLOWLIST.has(rel)) continue;
      const content = stripLineComments(readFileSync(file, "utf8"));
      if (CLOCK_RANDOM_RE.test(content)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  test("every allowlisted file still exists (catches stale entries)", () => {
    const root = path.resolve(import.meta.dir, "../..");
    for (const rel of ALLOWLIST) {
      expect(statSync(path.join(root, rel)).isFile()).toBe(true);
    }
  });
});
