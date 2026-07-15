---
status: done
depends: [demo-world, e2e-harness]
specs:
  - specs/facade.md
issues: []
pr: 11
---

# Docs recipe: scenario-engine page for the gitsheets docs site

## Scope

The publish capstone: a recipe page for the gitsheets docs site ([gitsheets#231](https://github.com/JarvusInnovations/gitsheets/issues/231)) presenting the pattern with the demo world as its worked example — the four production uses plus the agent-sandbox fifth, grounded in runnable code and the e2e harness. This is where the template becomes discoverable.

## Implements

- `specs/facade.md` § Template deliverables (item 5)

## Approach

1. A recipe page walking the pattern — git-as-world-state, the dual-mode seam, request=commit, clone-the-running-server — keyed to the demo world's actual sheets/routes/scenarios.
2. Show, don't tell: real commit graphs, a session clone, an e2e test asserting both surfaces.
3. Cover the five uses (E2E, contract-first parallel dev, training, time-travel debugging, agent sandbox) with the generalized enterprise-scale provenance.
4. Cross-link the evaluation-corpus recipe (#229) and the umbrella (#231); land on the docs site per that repo's flow.

## Validation

- [x] Recipe page written in-repo (`docs/recipe.md`, linked from `README.md`); every command/snippet verified against the demo world — captured from a running `bun run dev` instance on this branch, not invented
- [ ] Recipe page published to the gitsheets docs site; #231 satisfied and cross-linked — **gated follow-up, out of scope for this plan's PR** (see Notes)

## Risks / unknowns

- Publication-boundary hygiene: generalized use cases only, no client/project identifiers (the standing rule for public gitsheets/hologit content).

## Notes

Delivered the in-repo half only, per explicit scope for this closeout: `docs/recipe.md`
covers git-as-world-state, the dual-mode seam (`registry/routes/get-order.toml` + the
`GET /orders/:id` dual route), request=commit (a real rush-hour accept commit with its
trailers, plus a rejected-transition-produces-no-commit example), clone-the-running-server
(a live git-exposure fetch, `git blame`, and the fork's second-parent provenance walk —
all run against `http://127.0.0.1:3001/git` on this branch), and all five uses — the
agent-sandbox section runs a real `/sandbox/runs` -> `/sandbox/judge` ->
`/sandbox/regression` sequence, including the deterministic-replay confirmation
(`deterministic: true`, empty `divergentSteps`). Cross-links the evaluation-corpus recipe
(gitsheets#229) and the umbrella tracker (gitsheets#231) without duplicating either.

While verifying the README's own git-exposure walkthrough end-to-end, found and fixed a
real bug in it: `git blame -- <path>` has no `HEAD` to walk from in a freshly `git
init`ed repo carrying only the fetched session ref (`fatal: no such ref: HEAD`,
reproduced live) — corrected to `git blame refs/heads/session -- <path>`.

Gate: `bun run typecheck`, `bun run lint`, `bun run format:check` all clean; `bun test`
100 pass / 0 fail / 364 expect() calls (includes the full e2e tier).

**Publishing to the gitsheets docs site (#231) is explicitly NOT done here** — orchestrator-level
gated step, per this plan's task boundary. The in-repo recipe is publication-ready
content for whoever performs that step.

## Follow-ups

- Publish `docs/recipe.md`'s content to the gitsheets docs site and close/cross-link
  #231 accordingly (the gated step above).
- Optional, non-blocking: this repo has no markdown lint in its CI gate (confirmed —
  `.github/workflows/ci.yml` only runs typecheck/lint/format:check/test), and
  `docs/recipe.md` inherits the same MD013/MD040 style already present in `README.md`
  and `specs/*.md` (long unwrapped lines, some language-less fences for raw git/HTTP
  output). Fine as-is; flagging only in case the docs-site publish step wants stricter
  markdown lint applied at that boundary.
