// The e2e harness — specs/facade.md § E2E harness: tests declare a
// scenario, log in (fork a session), drive the API, and assert on BOTH
// surfaces — the HTTP response and the resulting session commits/records.
// This factors that pattern out of one-off test code (the shape
// src/tests/demo-world.test.ts hand-rolls per test) into a reusable API so
// other e2e test files build on it instead of re-deriving it:
//
//   - `E2EClient` abstracts "how a request reaches the app" — `injectClient`
//     (fastify.inject(), the default: no sockets, no ports, fully parallel)
//     or `socketClient` (a real TCP socket, for the over-the-wire smoke
//     tier — see smoke.e2e.test.ts). Both speak the same minimal
//     request/response shape, so `login()` and `E2ESession` work unmodified
//     against either.
//   - `login()` forks a session (POST /session/login) and wraps it as an
//     `E2ESession`, which bundles the session key, an inject-or-socket
//     request method with SESSION_HEADER attached automatically, and direct
//     read access to the session's commits/records via git plumbing +
//     `fastify.engine.sessionRead` — the "assert on both surfaces" half that
//     a plain HTTP client can't give you.
//   - `e2eTest()` is a drop-in replacement for `bun:test`'s `test()` that
//     bundles every session created during a failing test to
//     E2E_ARTIFACTS_DIR before rethrowing — the "session-as-recording
//     artifact" requirement (see bundle.ts and
//     .github/workflows/ci.yml's upload-on-failure step).
import { test as bunTest } from "bun:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { SESSION_HEADER } from "../../plugins/engine.ts";
import * as plumbing from "../../engine/plumbing.ts";
import { artifactPathFor, bundleSession } from "./bundle.ts";

export interface E2ERequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface E2EResponse {
  statusCode: number;
  body: string;
  json<T = unknown>(): T;
}

/** How an E2ESession's requests actually reach the app — see the module doc. */
export interface E2EClient {
  request(opts: E2ERequestOptions): Promise<E2EResponse>;
}

/** The default, fast transport: `fastify.inject()` — in-process, no socket. */
export function injectClient(fastify: FastifyInstance): E2EClient {
  return {
    async request(opts) {
      const injectOpts: InjectOptions = {
        method: opts.method,
        url: opts.url,
        headers: opts.headers,
      };
      if (opts.payload !== undefined) {
        injectOpts.payload = opts.payload as InjectOptions["payload"];
      }
      const response = await fastify.inject(injectOpts);
      return {
        statusCode: response.statusCode,
        body: response.body,
        json: <T>() => response.json() as T,
      };
    },
  };
}

/**
 * The over-the-wire transport: a real HTTP request against a listening
 * socket — see smoke.e2e.test.ts. `baseUrl` is e.g. `http://127.0.0.1:PORT`.
 * `content-type: application/json` is only set when there's a body — @fastify/env's
 * JSON body parser 400s on `FST_ERR_CTP_EMPTY_JSON_BODY` if the header is
 * present on a bodyless request (e.g. the state machine's POST .../accept,
 * which takes no payload), verified empirically while building this tier.
 */
export function socketClient(baseUrl: string): E2EClient {
  return {
    async request(opts) {
      const hasPayload = opts.payload !== undefined;
      const response = await fetch(`${baseUrl}${opts.url}`, {
        method: opts.method,
        headers: {
          ...(hasPayload ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: hasPayload ? JSON.stringify(opts.payload) : undefined,
      });
      const body = await response.text();
      return {
        statusCode: response.status,
        body,
        json: <T>() => JSON.parse(body) as T,
      };
    },
  };
}

/** Sessions created by the currently-running e2eTest() — reset per test, read on failure. See e2eTest() below. */
let activeSessions: E2ESession[] = [];

export interface LoginOptions {
  /** Per-session backend override for `dual` routes (specs/facade.md § Mode model). */
  modeOverride?: "offline" | "online";
}

/**
 * One forked session, wired to a transport and to the runtime store's git
 * plumbing directly — the pairing an e2e assertion needs: drive the API
 * through `request()`, then check the outcome landed correctly through
 * `commitCount()` / `record()` / `records()`.
 */
export class E2ESession {
  readonly client: E2EClient;
  readonly fastify: FastifyInstance;
  readonly sessionKey: string;
  readonly scenario: string;

  constructor(client: E2EClient, fastify: FastifyInstance, sessionKey: string, scenario: string) {
    this.client = client;
    this.fastify = fastify;
    this.sessionKey = sessionKey;
    this.scenario = scenario;
    activeSessions.push(this);
  }

  get ref(): string {
    return `refs/sessions/${this.sessionKey}`;
  }

  get gitDir(): string {
    return this.fastify.engine.gitDir;
  }

  /** This session's transport, with SESSION_HEADER attached automatically. */
  async request(
    opts: Omit<E2ERequestOptions, "headers"> & { headers?: Record<string, string> },
  ): Promise<E2EResponse> {
    return this.client.request({
      ...opts,
      headers: { ...opts.headers, [SESSION_HEADER]: this.sessionKey },
    });
  }

  /** First-parent commit count on the session ref right now — diff two calls around a flow to assert "exactly N commits". */
  async commitCount(): Promise<number> {
    return (await plumbing.firstParentLog(this.gitDir, this.ref)).length;
  }

  /** Read a single record straight off the session ref — the record-surface half of a dual-surface assertion. Bypasses HTTP entirely (goes through `fastify.engine.sessionRead`, a read-only transaction that never commits). Untyped at the gitsheets layer (queried by plain field equality, same as demo-world.test.ts's record assertions) — `T` narrows the RETURN value for the caller's `toMatchObject`/property access, not the query filter. */
  async record<T extends Record<string, unknown> = Record<string, unknown>>(
    sheet: string,
    query: Record<string, unknown>,
  ): Promise<T | undefined> {
    const result = await this.fastify.engine.sessionRead(this.sessionKey, (tx) =>
      tx.sheet(sheet).queryFirst(query),
    );
    return result as T | undefined;
  }

  /** Same as `record()`, for queries expected to match more than one record. */
  async records<T extends Record<string, unknown> = Record<string, unknown>>(
    sheet: string,
    query: Record<string, unknown>,
  ): Promise<T[]> {
    const result = await this.fastify.engine.sessionRead(this.sessionKey, (tx) =>
      tx.sheet(sheet).queryAll(query),
    );
    return result as T[];
  }

  /** `git bundle` this session's ref to `destPath` — the state-recording artifact (specs/facade.md § E2E harness). Exposed directly for tests that want to assert on the bundle itself (see artifact-bundle.test.ts); e2eTest() calls this automatically on failure. */
  async bundle(destPath: string): Promise<void> {
    await bundleSession(this.gitDir, this.ref, destPath);
  }
}

/**
 * POST /session/login and wrap the result as an E2ESession. Throws loudly
 * (not a 404 assertion) if login itself doesn't 201 — a harness
 * precondition a test's own assertions never see, not something under test.
 */
export async function login(
  client: E2EClient,
  fastify: FastifyInstance,
  scenario: string,
  opts: LoginOptions = {},
): Promise<E2ESession> {
  const response = await client.request({
    method: "POST",
    url: "/session/login",
    payload: { scenario, modeOverride: opts.modeOverride },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `e2e harness login() failed for scenario "${scenario}": ${response.statusCode} ${response.body}`,
    );
  }
  const body = response.json<{ sessionKey: string }>();
  return new E2ESession(client, fastify, body.sessionKey, scenario);
}

/** Convenience: login() over the default inject transport. */
export async function loginInject(
  fastify: FastifyInstance,
  scenario: string,
  opts: LoginOptions = {},
): Promise<E2ESession> {
  return login(injectClient(fastify), fastify, scenario, opts);
}

/** Best-effort: bundle every session `e2eTest` saw during a failing test. Never throws — a bundling failure must not mask the test's real failure. */
async function captureFailureArtifacts(testName: string, sessions: E2ESession[]): Promise<void> {
  await Promise.allSettled(
    sessions.map(async (session) => {
      const dest = artifactPathFor(testName, session.sessionKey);
      await session.bundle(dest);
    }),
  );
}

/**
 * Drop-in replacement for `bun:test`'s `test()`: on failure, bundles every
 * `E2ESession` the test constructed (via `login()`/`loginInject()`) to
 * E2E_ARTIFACTS_DIR before rethrowing, so a failing e2e run leaves an
 * inspectable recording (specs/facade.md § E2E harness). Runs entirely
 * inside the test body's own promise, so the bundle write is guaranteed to
 * land before any file-level `afterEach` (e.g. `fastify.close()`) tears
 * down the runtime repo.
 */
export function e2eTest(name: string, fn: () => Promise<void>, timeoutMs?: number): void {
  bunTest(
    name,
    async () => {
      activeSessions = [];
      try {
        await fn();
      } catch (err) {
        await captureFailureArtifacts(name, activeSessions);
        throw err;
      }
    },
    timeoutMs,
  );
}
