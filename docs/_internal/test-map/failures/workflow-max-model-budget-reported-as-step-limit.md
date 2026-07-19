# Workflow Max Model Budget Is Reported As A Step Limit

## Record

- Pattern ID: `workflow-max-model-budget-reported-as-step-limit`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 2
- Cause: `product_bug`

## Symptom

A Workflow model node configured with only
`runBudget.maxModelCalls: 1` terminates its first episode with
`MAX_STEPS_EXCEEDED` / `max_steps_exceeded`. The configured budget dimension
and Core's canonical budget code are instead
`MAX_MODEL_CALLS_EXCEEDED` / `max_model_calls_exceeded`.

Durable Workflow continuation still works because both reasons are resumable,
but operators and trace consumers see the wrong owning limiter.

## Root Cause

`WorkflowEpisodeRuntime` passes the node `runBudget` into Core and also calls
`resolveWorkflowEpisodeMaxSteps()`. That helper clamps `maxSteps` to
`runBudget.maxModelCalls`. At the next boundary, Core's step-limit check wins
before the model-call budget can produce its dimension-specific terminal.

## Diagnostic Move

When a Workflow budget stop has an unexpected code, inspect both
`run.started`/Workflow episode metadata and the persisted `run.failed` payload.
If metadata says `runBudget.maxModelCalls` while the terminal says max steps,
the error is Host/Core limiter precedence, not a user-configured `maxSteps`.

## Prevention

- Do not project `maxModelCalls` into a competing `maxSteps` owner, or define a
  canonical precedence rule that preserves the configured dimension.
- Add a real-shape Workflow episode test with one model call followed by a
  tool call and assert the terminal code/reason.
- Keep Workflow supersession diagnostics accepting only explicitly documented
  resumable reasons while preserving their exact codes in the audit trail.

## Fix

`WorkflowEpisodeRuntime` now derives Core `maxSteps` only from explicit
profile `maxSteps` (or the existing 100-step backstop). Node/profile
`runBudget.maxModelCalls` remains a separate Core resource budget and therefore
owns its terminal code.

Verification on 2026-07-19:

- Host budget-independence and durable-continuation regressions passed;
- the related Host Workflow/protocol slice passed 103/103;
- a real `openai/gpt-5.6-terra` Workflow recorded four
  `MAX_MODEL_CALLS_EXCEEDED` terminals, completed on its final episode, passed
  `node-verifier`, and returned clean trace report/verify/session check results.

Post-fix trace:
`/Applications/xgw/projects/AI-native/project/test/qa_fix_verify_20260719_182027/workflow_positive/.sparkwright/sessions/session_workflow_1add6b2782e640b08e61e9dba02c9442/trace.jsonl`.

## Evidence

- Durable positive control:
  `/Applications/xgw/projects/AI-native/project/test/qa_fix_verify_20260719_182027/workflow_positive/.sparkwright/sessions/session_workflow_067c144011ed47c19861fb9834976c6d/trace.jsonl`.
- Independent negative control:
  `/Applications/xgw/projects/AI-native/project/test/qa_fix_verify_20260719_182027/workflow_negative/.sparkwright/sessions/session_qa_fix_independent_history_20260719/trace.jsonl`.
- Both configured only `maxModelCalls: 1`; both persisted
  `MAX_STEPS_EXCEEDED`.

## Related

- Coverage:
  [../coverage/workflow-durable-jobs.md](../coverage/workflow-durable-jobs.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note:
  [../runs/2026-07-19-real-model-fix-verification.md](../runs/2026-07-19-real-model-fix-verification.md)
- Supersession pattern:
  [workflow-resumable-trace-report-divergence.md](workflow-resumable-trace-report-divergence.md)
