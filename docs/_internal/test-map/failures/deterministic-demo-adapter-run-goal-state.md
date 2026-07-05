# Deterministic Demo Adapter Run Goal State

## Record

- Pattern ID: `deterministic-demo-adapter-run-goal-state`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

Configured delegate traces can show the correct delegated child goal in
`model.requested.payload.goal`, while the deterministic demo model's
`model.completed.message` mentions the parent run goal instead.

This is a diagnostics-adapter defect, not a real-provider delegation invariant:
real provider adapters receive the current `ModelInput`, while the demo adapter
used construction-time text in its canned response.

## Root Cause

Fixed 2026-06-29. `createDemoModel()` closed over the model-factory input goal
and kept one adapter-wide `turn` counter. Configured child-scope deterministic
adapters may be shared by `modelRef`, so the adapter could leak the parent
construction goal and another run's turn count into child diagnostics.

## Diagnostic Move

When deterministic child diagnostics look wrong, compare:

```bash
node packages/cli/dist/index.js trace events "$trace" --type model.requested --jsonl
node packages/cli/dist/index.js trace events "$trace" --type model.completed --jsonl
```

If `model.requested.payload.goal` is the child goal but the deterministic
`model.completed.message` mentions the parent goal or starts on the second turn
for a new child run, this pattern reproduced.

## Prevention

The deterministic demo adapter now reads `ModelInput.run.goal` for response text
and tracks turn state by `input.run.id`.

Focused coverage:

```bash
npm --workspace @sparkwright/host test -- test/model-factory.test.ts
```

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md)
- Project map: [../../project-map/modules/host.md](../../project-map/modules/host.md)
- Run notes: [../runs/2026-06-29-mcp-cron-tui-agent-boundary-qa.md](../runs/2026-06-29-mcp-cron-tui-agent-boundary-qa.md)
