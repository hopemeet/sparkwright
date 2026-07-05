# Model Skips Verification

## Record

- Pattern ID: `model-skips-verification`
- Status: `watch`
- First seen: not yet recorded in test-map
- Last seen: not yet recorded in test-map
- Recorded count: 0

| Cause | Count |
| --- | ---: |
| `product_bug` | 0 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

A real model delegates or writes, then produces a final answer before running
the verification step that the test expected.

## Root Cause

Usually one of:

- the prompt asked for verification but did not make it a required final-answer
  condition
- the model chose a valid but different route than the test expected
- the test asserted intent instead of ordered trace evidence

## Diagnostic Move

Check whether the prompt explicitly says:

- what must happen before final answer
- which actor must verify
- what evidence counts as verification
- whether failure to verify should fail the run

Then inspect trace ordering instead of assistant prose.

## Prevention

- Use strong prompts for route-specific tests.
- Keep real-model assertions at the invariant level.
- Use scripted or deterministic tests for exact ordering.

## Related

- Scenario: [../scenarios/trace-subagent-write-verify.yaml](../scenarios/trace-subagent-write-verify.yaml)
- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/agents.md](../coverage/agents.md)
- Matrix: [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md),
  [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
