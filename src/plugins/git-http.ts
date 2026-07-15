// Git exposure: a read-only git smart-HTTP endpoint over the runtime repo.
// See specs/facade.md § Git exposure, specs/scenario-engine.md § Runtime
// store and ref layout, plans/git-exposure.md.
//
// MECHANISM — subprocess `git http-backend` (a CGI program), invoked
// per-request via Bun.spawn and bridged to Fastify by translating the HTTP
// request into CGI environment variables and the CGI stdout (header block +
// `\r\n\r\n` + body, verified empirically against the shipped git 2.51
// binary — see the PR description for the probe transcript) back into an
// HTTP response. This is "prefer shelling to git http-backend" per the
// plan's approach: no extra daemon, no second port, same-process story —
// the subprocess lives only for the duration of one request, exactly like
// engine/plumbing.ts's `git` plumbing calls.
//
// READ-ONLY ENFORCEMENT (two independent layers):
//   1. `POST <prefix>/git-receive-pack` is never proxied to the subprocess —
//      the route handler refuses it directly. There is no code path from an
//      HTTP request to git-http-backend's receive-pack service.
//   2. Defense in depth: every invocation also sets `http.receivepack=false`
//      via `GIT_CONFIG_*` (git 2.31+'s environment-based config injection —
//      see below), so even the shared `/info/refs` negotiation endpoint
//      (which necessarily handles `?service=git-upload-pack` and
//      `?service=git-receive-pack` alike, per the smart-HTTP protocol)
//      refuses a receive-pack probe with git's own `403 Forbidden` /
//      "service not enabled" response — verified empirically.
//
// REF ADVERTISEMENT SCOPING — `uploadpack.hideRefs`, also injected via
// `GIT_CONFIG_*`: hide everything under `refs/`, then un-hide exactly the
// three prefixes specs/scenario-engine.md and specs/facade.md name
// (`refs/fixtures/baseline/`, `refs/sessions/`, `refs/tags/sessions/`).
// `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` inject
// config for this one subprocess invocation only — the runtime repo's own
// on-disk config (owned by engine/plumbing.ts and boot-import.ts) is never
// touched, keeping this plugin's concerns fully separate from the engine's.
//
// AUTH GATE — jarvus-fastify authentication.md's deny-by-default model,
// scoped to just this endpoint (the template has no app-wide operator
// identity system yet — that's out of scope here). A single `onRequest`
// hook requires `Authorization: Bearer <GIT_EXPOSURE_TOKEN>`; an unset
// token means the deployment has not opted in, so every request is refused
// (fail closed, never fail open). This plugin is deliberately NOT wrapped
// in `fastify-plugin` — Fastify's encapsulation keeps the raw-body
// content-type parsers and the auth hook scoped to this plugin's own
// prefix, with zero effect on the rest of the app's routes.
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

/** CGI header-block / body separator, per RFC 3875 and verified against the shipped git-http-backend output. */
const CRLFCRLF = "\r\n\r\n";

/**
 * Config injected into every `git http-backend` invocation via git's
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` mechanism
 * (git >= 2.31) — equivalent to prepending these lines to the repo's
 * `config` file for the lifetime of this one subprocess, without writing
 * anything to disk. Order matters for `uploadpack.hideRefs`: later entries
 * win, so "hide everything, then un-hide three prefixes" must list the
 * blanket hide first.
 */
const SUBPROCESS_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["uploadpack.hideRefs", "refs/"],
  ["uploadpack.hideRefs", "!refs/fixtures/baseline/"],
  ["uploadpack.hideRefs", "!refs/sessions/"],
  ["uploadpack.hideRefs", "!refs/tags/sessions/"],
  // Defense in depth — see the module comment's "READ-ONLY ENFORCEMENT".
  ["http.receivepack", "false"],
];

function subprocessGitConfigEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(SUBPROCESS_GIT_CONFIG.length) };
  SUBPROCESS_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

interface CgiResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

function parseCgiResponse(raw: Uint8Array): CgiResponse {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const sep = buf.indexOf(CRLFCRLF, 0, "latin1");
  if (sep === -1) {
    throw new Error("git http-backend produced no CGI header terminator (\\r\\n\\r\\n)");
  }
  const headerText = buf.toString("latin1", 0, sep);
  const body = raw.subarray(sep + CRLFCRLF.length);

  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === "status") {
      status = Number.parseInt(value.split(" ")[0] ?? "200", 10);
    } else {
      headers[key] = value;
    }
  }
  return { status, headers, body };
}

export interface InvokeGitHttpBackendOptions {
  gitDir: string;
  method: "GET" | "POST";
  /** CGI PATH_INFO — the path *after* this plugin's mount prefix, e.g. "/info/refs". */
  pathInfo: string;
  /** Raw query string, no leading "?". */
  queryString: string;
  contentType?: string;
  contentLength?: string;
  contentEncoding?: string;
  /** From the client's `Git-Protocol` header — see the nginx/apache git-http-backend server configs, which map it to this exact env var name (not the generic `HTTP_GIT_PROTOCOL` CGI form). */
  gitProtocol?: string;
  remoteAddr?: string;
  body: Uint8Array;
}

/** Spawn `git http-backend` as a one-shot CGI process and return its parsed response. Exported for direct unit testing. */
export async function invokeGitHttpBackend(
  opts: InvokeGitHttpBackendOptions,
): Promise<CgiResponse> {
  // Resolve once, to an absolute path, and reuse it for BOTH `cwd` and
  // `GIT_PROJECT_ROOT` below. A relative `opts.gitDir` (the config default —
  // see .env.example's RUNTIME_REPO_PATH=var/runtime.git) bit this
  // otherwise: Bun.spawn's `cwd` resolves relative to the *parent* process's
  // cwd, changing the subprocess's actual working directory to
  // `<parent-cwd>/var/runtime.git` — and git-http-backend then resolves the
  // *env var* `GIT_PROJECT_ROOT=var/runtime.git` relative to THAT (new) cwd,
  // landing on the nonexistent `.../var/runtime.git/var/runtime.git` and
  // silently 404ing the ref advertisement. Verified empirically against the
  // shipped git 2.51 binary while exercising plans/demo-world.md's demo
  // script end-to-end.
  const gitDir = path.resolve(opts.gitDir);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_PROJECT_ROOT: gitDir,
    // Skip the git-daemon-export-ok file check — this repo has no anonymous
    // git:// daemon; exposure is controlled entirely by this plugin.
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: opts.method,
    PATH_INFO: opts.pathInfo,
    QUERY_STRING: opts.queryString,
    REMOTE_ADDR: opts.remoteAddr ?? "",
    ...subprocessGitConfigEnv(),
  };
  if (opts.contentType) env.CONTENT_TYPE = opts.contentType;
  if (opts.contentLength) env.CONTENT_LENGTH = opts.contentLength;
  if (opts.contentEncoding) env.HTTP_CONTENT_ENCODING = opts.contentEncoding;
  if (opts.gitProtocol) env.GIT_PROTOCOL = opts.gitProtocol;

  const proc = Bun.spawn({
    cmd: ["git", "http-backend"],
    cwd: gitDir,
    env,
    stdin: opts.body,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git http-backend exited ${exitCode}: ${stderr.trim()}`);
  }

  return parseCgiResponse(new Uint8Array(stdout));
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/** Constant-time token comparison via fixed-length digests, so neither the length nor content of `presented` leaks through timing. */
function safeTokenEquals(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}

/** Fastify types unrecognized (non-standard) request headers as `string | string[] | undefined`; git-http-backend wants a single scalar value per CGI var. */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function proxyToGitHttpBackend(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  pathInfo: string,
): Promise<void> {
  const queryString = request.url.includes("?")
    ? request.url.slice(request.url.indexOf("?") + 1)
    : "";
  const body = Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array(0);

  let result: CgiResponse;
  try {
    result = await invokeGitHttpBackend({
      gitDir: fastify.engine.gitDir,
      method: request.method as "GET" | "POST",
      pathInfo,
      queryString,
      contentType: request.headers["content-type"],
      contentLength: request.headers["content-length"],
      contentEncoding: request.headers["content-encoding"],
      gitProtocol: singleHeader(request.headers["git-protocol"]),
      remoteAddr: request.ip,
      body,
    });
  } catch (err) {
    fastify.log.error({ err }, "git http-backend invocation failed");
    reply.code(502).send({ error: "git backend error" });
    return;
  }

  reply.code(result.status);
  for (const [key, value] of Object.entries(result.headers)) {
    reply.header(key, value);
  }
  reply.send(Buffer.from(result.body));
}

/**
 * Not `fp()`-wrapped: register with `fastify.register(gitHttpPlugin, {
 * prefix: fastify.config.GIT_EXPOSURE_PATH })` so Fastify's encapsulation
 * keeps the content-type parsers and the auth `onRequest` hook scoped to
 * this plugin's own routes only.
 */
const gitHttpPlugin: FastifyPluginAsync = async (fastify) => {
  const token = fastify.config.GIT_EXPOSURE_TOKEN;

  // git's smart-HTTP request bodies are opaque binary protocol payloads
  // (optionally gzip-compressed — passed through untouched via
  // Content-Encoding/HTTP_CONTENT_ENCODING for git-http-backend to handle).
  // Fastify has no built-in parser for these content types and errors on
  // unrecognized ones by default; register a raw pass-through for anything
  // that reaches this plugin's routes.
  fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // Operator-auth gate — deny by default (jarvus-fastify authentication.md:
  // "one global hook covers everything ... in the router's namespace").
  // An unset token means this deployment has not opted in to exposing the
  // runtime repo at all: fail closed, never fail open.
  fastify.addHook("onRequest", (request, reply, done) => {
    if (!token) {
      reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="git-exposure"')
        .send({ error: "git exposure is not configured for this deployment" });
      return;
    }
    const presented = bearerToken(request.headers.authorization);
    if (!presented || !safeTokenEquals(presented, token)) {
      reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="git-exposure"')
        .send({ error: "unauthorized" });
      return;
    }
    done();
  });

  // Ref-negotiation endpoint, shared by both upload-pack (fetch/clone) and
  // receive-pack (push) per the smart-HTTP protocol — see the module
  // comment's "READ-ONLY ENFORCEMENT" for why a `?service=git-receive-pack`
  // probe here is still refused (git itself 403s it).
  fastify.get("/info/refs", async (request, reply) => {
    await proxyToGitHttpBackend(fastify, request, reply, "/info/refs");
  });

  fastify.post("/git-upload-pack", async (request, reply) => {
    await proxyToGitHttpBackend(fastify, request, reply, "/git-upload-pack");
  });

  // Never proxied to the subprocess — the write path does not exist at
  // this layer, full stop. All mutation flows through the API
  // (specs/facade.md § Git exposure: "Write access is never exposed").
  fastify.post("/git-receive-pack", async (_request, reply) => {
    reply.code(403).send({ error: "receive-pack is not served — this endpoint is read-only" });
  });
};

export default gitHttpPlugin;
