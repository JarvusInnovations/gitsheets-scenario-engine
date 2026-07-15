// Request = commit: wraps a mutating route handler so it runs inside one
// gitsheets transaction on the session ref, producing exactly one commit
// shaped per specs/scenario-engine.md § Request = commit.
//
// DESIGN NOTE — response embedding via reword. `repo.transact`'s
// message/trailers are fixed *before* the handler runs (see
// gitsheets/specs/api/transaction.md — `Transaction.normalizeOptions` runs
// ahead of the handler), but the spec requires the commit body to carry the
// *response* payload and a `Response-Code:` trailer, both only known *after*
// the handler resolves. There's no gitsheets API to defer the message. So
// this wrapper runs the handler inside a transact call with the best
// message it can build upfront (subject + fenced request JSON + the
// trailers known in advance), then — only if a commit actually landed —
// atomically rewords that single commit (same tree, same parents, via a CAS
// update-ref in RuntimeStore#rewordCommit) to the complete message
// including the response. The session ref only ever shows the *final*,
// complete commit; the pre-reword message is never observable by another
// reader because intra-session writes are already serialized (one writer at
// a time — specs/scenario-engine.md § Concurrency). gitsheets performed the
// one substantive write (the validated record mutation); the reword is
// metadata-only plumbing, consistent with the "gitsheets does record
// mutations, plumbing does DAG/metadata scaffolding" split documented in
// plans/engine-plugin.md.
//
// Trailer casing: gitsheets' `repo.transact` enforces HTTP-header-style
// trailer keys (`Some-Header`, via HTTP_HEADER_KEY_RE in
// node_modules/gitsheets/dist/transaction.js) and *throws*
// TransactionError('commit_failed') otherwise. specs/scenario-engine.md's
// prose trailer names (`Request-id:`, `Response-code:`, `User-agent:`) use
// lowercase-after-hyphen casing that fails this check — verified empirically
// (see PR description). This module uses the working casing throughout
// (`Request-Id`, `Response-Code`, `User-Agent`) and the closeout notes flag
// the spec prose for a casing fix.
import type { Transaction } from "gitsheets";
import type { RuntimeStore } from "./runtime-store.ts";

export interface RequestCommitContext {
  method: string;
  path: string;
  sessionKey: string;
  scenario: string;
  requestId: string;
  userAgent?: string;
  host?: string;
  /** Authenticated principal (pseudonymized per deployment policy) — commit author. Falls back to the engine identity when absent (e.g. unauthenticated demo routes). */
  principal?: { name: string; email: string };
}

export interface RequestCommitOutcome<T> {
  responseBody: T;
  responseCode: number;
}

function baseTrailers(ctx: RequestCommitContext): Record<string, string> {
  const trailers: Record<string, string> = {
    Session: ctx.sessionKey,
    Scenario: ctx.scenario,
    "Request-Id": ctx.requestId,
  };
  if (ctx.userAgent) trailers["User-Agent"] = ctx.userAgent;
  if (ctx.host) trailers.Host = ctx.host;
  return trailers;
}

function fence(label: string, value: unknown): string {
  return ["```" + label, JSON.stringify(value, null, 2), "```"].join("\n");
}

/**
 * Run `handler` (record mutations via `tx.sheet(...)`) inside one commit on
 * `ctx.sessionKey`'s ref. `handler` returns the HTTP response body and
 * status code — used both as the wrapper's return value and to complete the
 * commit message/trailers after the fact.
 */
export async function runRequestCommit<T>(
  store: RuntimeStore,
  ctx: RequestCommitContext,
  requestBody: unknown,
  handler: (tx: Transaction) => Promise<RequestCommitOutcome<T>>,
): Promise<RequestCommitOutcome<T>> {
  const subject = `${ctx.method} ${ctx.path}`;
  const initialMessage = [subject, "", "Request:", fence("json", requestBody ?? null)].join("\n");

  const result = await store.sessionTransact<RequestCommitOutcome<T>>({
    sessionKey: ctx.sessionKey,
    message: initialMessage,
    trailers: baseTrailers(ctx),
    author: ctx.principal,
    handler,
    finalize: (outcome) => {
      const finalTrailers = {
        ...baseTrailers(ctx),
        "Response-Code": String(outcome.value.responseCode),
      };
      const finalMessage = [
        subject,
        "",
        "Request:",
        fence("json", requestBody ?? null),
        "",
        "Response:",
        fence("json", outcome.value.responseBody),
      ].join("\n");
      return { message: finalMessage, trailers: finalTrailers };
    },
  });

  return result.value;
}

/**
 * Non-request mutations (simulated background events, e.g. a timer
 * advancing an order's state). Same trailer discipline, synthetic subject.
 * See specs/scenario-engine.md § Request = commit, "Non-request mutations".
 */
export async function runEventCommit<T>(
  store: RuntimeStore,
  opts: { sessionKey: string; scenario: string; eventName: string },
  handler: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const result = await store.sessionTransact<T>({
    sessionKey: opts.sessionKey,
    message: `EVENT ${opts.eventName}`,
    trailers: { Session: opts.sessionKey, Scenario: opts.scenario },
    handler,
  });
  return result.value;
}
