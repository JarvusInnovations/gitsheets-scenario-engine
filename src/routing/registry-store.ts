// Reads the parity-ledger gitsheet off the ref runRegistryImport wrote.
//
// DELIBERATELY reuses the engine's one shared gitsheets `Repository`
// instance (`store.repo`) rather than opening a second one against the same
// gitDir. See runtime-store.ts's module comment: two separate `Repository`
// instances racing `transact()` against the same physical gitDir don't
// queue — the native core throws `transaction_in_progress`. Going through
// `store.repo.transact(...)` directly (bypassing RuntimeStore's own
// sessionTransact/#writeMutex, which exist only to make the request=commit
// reword step atomic — irrelevant here, this never rewords) still funnels
// through gitsheets' own per-instance mutex, so it safely interleaves with
// concurrent session reads/writes on the same instance.
import type { RuntimeStore } from "../engine/runtime-store.ts";
import { REGISTRY_REF } from "./registry-import.ts";
import type { RegistryEntry } from "./types.ts";

export async function readRegistry(store: RuntimeStore): Promise<RegistryEntry[]> {
  const result = await store.repo.transact(
    { parent: REGISTRY_REF, branch: REGISTRY_REF, message: "(read-only)" },
    async (tx) => tx.sheet<RegistryEntry>("routes").queryAll(),
  );
  if (result.commitHash !== null) {
    // A "read" produced a commit — programming error (a mutation snuck into
    // this query), not a normal outcome. Mirrors RuntimeStore#sessionRead's
    // same guard for the same reason.
    throw new Error(
      `readRegistry produced a commit (${result.commitHash}) — the registry ledger read must not mutate`,
    );
  }
  return result.value;
}
