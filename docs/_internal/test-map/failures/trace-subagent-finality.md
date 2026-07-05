# Trace Subagent Finality

## Record

- Pattern ID: `trace-subagent-finality`
- Status: `active`
- First seen: 2026-06-22
- Last seen: 2026-06-22
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

`trace report` treats a delegated write as incomplete or high severity even
when parent-run evidence shows a verification command happened after the child
reported the write.

## Root Cause

Child/delegate terminal finality and parent verification are separate facts.
The raw child finality should stay literal, while derived diagnostics may
downgrade severity only when ordered parent evidence proves verification
happened after the child write.

## Diagnostic Move

Inspect event ordering:

1. Child `subagent.completed` or child terminal event with write evidence.
2. Parent `tool.completed` or verification event after that child event.
3. Parent final answer after the verification evidence.

Do not infer verification from the child final answer or from a parent final
answer that lacks ordered evidence.

## Prevention

- Keep raw trace facts literal.
- Add derived report fields only when they can cite event-order evidence.
- Use scripted tests for exact event ordering and real-model runs only as
  canaries.

## Related

- Scenario: [../scenarios/trace-subagent-write-verify.yaml](../scenarios/trace-subagent-write-verify.yaml)
- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/agents.md](../coverage/agents.md)
- Matrix: [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
