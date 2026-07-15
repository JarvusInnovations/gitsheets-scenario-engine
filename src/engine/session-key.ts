// Opaque session-key generation. Per specs/scenario-engine.md § Runtime store
// and ref layout: "base36 timestamp + process counter + random suffix — the
// production-proven format": collision-free by construction, no create-time
// coordination needed. The authenticated principal is never encoded here —
// it's recorded in the session's commits instead (see engine/request-commit.ts).
//
// Per § Determinism and replay: "Session keys are the one sanctioned use of
// clock/randomness" — a key names a ref, never enters record content or
// trees, so its nondeterminism cannot affect replay.
let counter = 0;

export function generateSessionKey(): string {
  const timestamp = Date.now().toString(36);
  const seq = (counter++).toString(36);
  const random = Math.floor(Math.random() * 36 ** 8)
    .toString(36)
    .padStart(6, "0");
  return `${timestamp}-${seq}-${random}`;
}
