# Claude Code Guidelines

## Project

`gitsheets-scenario-engine` — a template for a dual-mode API facade where git is the
world-state engine. `specs/` is the source of truth (start at `specs/README.md`); `plans/`
is the implementation DAG that brings code into conformance (start at `plans/README.md`).
Read both before changing behavior — specs lead, code follows.

## Stack

**Bun only** — runtime, package manager, test runner, and watch-mode dev server. No Node.js,
no npm, no build step: Bun executes TypeScript source directly in dev and production alike.
`tsc --noEmit` exists solely as a type checker, never a build tool. Framework is Fastify 5.x;
the full setup is vendored as the `jarvus-fastify` skill (`.claude/skills/jarvus-fastify/`,
symlinked from `.agents/skills/`) — read `SKILL.md` and `references/setup-guide.md` before
adding routes, plugins, or config.

```sh
bun install              # never npm/yarn/pnpm
bun run dev              # bun --watch src/index.ts
bun run start            # bun run src/index.ts — no build step
bun run typecheck        # tsc --noEmit
bun run lint             # oxlint src
bun run format:check     # oxfmt --check src
bun test                 # Bun's built-in runner
```

Use `bun add` / `bun add -d` / `bun remove` for dependencies — never hand-edit
`package.json`. Commit `bun.lock`.

## All state lives in records

Per `specs/facade.md` § Offline mode: route handlers read and write the session's world
through typed sheet APIs inside the request's gitsheets transaction. **Nothing beyond that
transaction may hold state.** Anything in process memory (a module-level cache, an
in-memory counter, a `Map` standing in for a table) is a bug — it breaks clone/replay
fidelity, the property the whole engine exists to guarantee. If a request needs derived or
carried-forward state, model it as a record (or a field on one), not a variable.

## Vendored skills

Two skills ship in-repo under `.agents/skills/` (symlinked into `.claude/skills/`):

- **`specops`** — the spec/plan methodology this repo runs on. Invoke before writing specs,
  planning, or starting a feature; see `.claude/skills/specops/SKILL.md`.
- **`jarvus-fastify`** — the backend stack described above; see
  `.claude/skills/jarvus-fastify/SKILL.md` and its `references/`.

## Commits

Conventional commits (`type(scope): description`). Stage explicit paths — never `git add -A`.
When a command generates files (`bun add`, `bun init`), commit those first with the exact
command in the body, then hand-written edits as a separate commit.

Every commit authored by a Claude Code agent ends with these trailers (session URL specific
to the authoring session):

```
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_...
```
