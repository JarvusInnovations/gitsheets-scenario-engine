---
status: planned
depends: [demo-world, e2e-harness]
specs:
  - specs/facade.md
issues: []
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

- [ ] Recipe page published to the gitsheets docs site; every command/snippet verified against the demo world
- [ ] #231 satisfied and cross-linked

## Risks / unknowns

- Publication-boundary hygiene: generalized use cases only, no client/project identifiers (the standing rule for public gitsheets/hologit content).

## Notes

_(populated at closeout)_

## Follow-ups

_(populated at closeout)_
