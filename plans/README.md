# Plans

The implementation DAG for the scenario-engine template. [`specs/`](../specs/) declares
what must be true; each plan here is a buildable chunk that brings code into conformance,
and freezes to `status: done` as the durable record of what shipped. Frontmatter follows
the SpecOps convention (`status`, `depends`, `specs`, `issues`). Umbrella tracker:
[gitsheets#231](https://github.com/JarvusInnovations/gitsheets/issues/231).

## Dependency order

1. **[repo-scaffold](repo-scaffold.md)** — Fastify 5.x + TS/ESM project, gitsheets 2.4.x, the `fixtures/` trunk layout, CI skeleton. _(root)_
2. **[engine-plugin](engine-plugin.md)** — the core: runtime store, deterministic boot import, session fork (two-commit DAG), request=commit, per-session `Repository` handle. _(needs 1)_
3. **[dual-mode-routing](dual-mode-routing.md)** — route registry as route config, per-route mode resolution, the parity ledger, serializer parity. _(needs 2)_
4. **[git-exposure](git-exposure.md)** — read-only smart-HTTP endpoint advertising baseline + session refs. _(needs 2)_
5. **[session-lifecycle-tooling](session-lifecycle-tooling.md)** — TTL sweep, pinned-session tags, the deterministic replay harness. _(needs 2)_
6. **[demo-world](demo-world.md)** — a small world (sheets + scenarios + routes, one state machine) exercising the discipline. _(needs 2, 3)_
7. **[e2e-harness](e2e-harness.md)** — `fastify.inject` tests asserting HTTP + session commits, wired into CI. _(needs 6)_
8. **[agent-sandbox-profile](agent-sandbox-profile.md)** — fork-per-run, judgment-by-diff, replay-based regression evals. _(needs 5, 6)_
9. **[docs-recipe](docs-recipe.md)** — the recipe page for the gitsheets docs site (#231) — the publish capstone. _(needs 6, 7)_

The critical path is **1 → 2 → 3 → 6 → 7 → 9**. `git-exposure`, `session-lifecycle-tooling`,
and `agent-sandbox-profile` hang off the core and can land in parallel with the demo/test/docs
spine once `engine-plugin` exists.
