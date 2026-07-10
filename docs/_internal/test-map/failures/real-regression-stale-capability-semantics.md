# Real Regression Scripts Expect Stale Capability Semantics

## Record

- Pattern ID: `real-regression-stale-capability-semantics`
- Status: `retired`
- First seen: 2026-06-28
- Last seen: 2026-06-28
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     0 |
| `test_bug`              |     2 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

Real-model regression scripts fail even though the trace/session evidence
matches the current product contract:

- `regression:real-skill-capabilities` expects `create_skill` to apply
  `.sparkwright/skills/<name>/SKILL.md` and emit one workspace write, but the
  current tool descriptor says it drafts a Skill proposal. The trace records
  `create_skill` completing with `action:"draft"`, a proposal id, and
  `capability.mutation.completed` events under
  `.sparkwright/skill-evolution/proposals/**`.
- `regression:real-agents` expects a direct `delegate_mini_reviewer` tool
  request, but the current default exposure is indexed delegation through
  `delegate_agent(agentId)`. The real model used `delegate_agent` with
  `agentId:"mini_reviewer"`; trace verify and session check passed.

## Root Cause

The scripts still assert old direct-apply/direct-delegate surfaces after the
capability model changed to proposal-first Skill creation and indexed delegate
exposure. The runtime behavior is healthy in the observed runs; the failure is
in the stale canary contract.

Fixed on 2026-06-28 by updating the Skill canary to assert proposal-first
`create_skill` behavior and the agent canary to assert the default indexed
`delegate_agent(agentId)` route.

## Diagnostic Move

Before treating a real regression script failure as product behavior, compare
the failing assertion with `tool_search` output and capability inspect output
from the same run. If the tool descriptor or capability snapshot advertises the
new surface, update the canary assertions instead of weakening runtime code.

## Prevention

Keep real regression scripts aligned with capability descriptors:

- Skill create canary should assert proposal creation, `capability.mutation`
  audit events, and no direct package application unless an explicit apply flow
  is being tested.
- Agent delegate canary should accept `delegate_agent(agentId)` as the default
  indexed route, and only require direct aliases in `exposure:"all"` or pinned
  delegate scenarios.

## Related

- Scenarios: real mini Skill create/update; real mini agent create/delegate.
- Coverage: [skills](../coverage/skills.md), [agents](../coverage/agents.md)
- Run notes: [2026-06-28-access-mode-real-mini-qa-partial.md](../runs/2026-06-28-access-mode-real-mini-qa-partial.md)
- Fix verification: [2026-06-28-access-mode-fix-verification.md](../runs/2026-06-28-access-mode-fix-verification.md)
