# Delegate Parallel Counts Partial Child As Complete

## Record

- Pattern ID: `delegate-parallel-partial-counted-complete`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 3
- Cause: `product_bug`

## Symptom

A mixed `delegate_parallel` call has one clean child and one step-limited child.
The latter carries `finality:partial`, `terminalState:truncated`, and
`stepLimitReached/truncated:true`, yet the parent tool reports
`completed:2, incomplete:0, unhealthy:0` and the root assessment is clean.
Offline trace diagnostics correctly report `SUBAGENT_INCOMPLETE`.

## Root Cause

`createDelegateParallelTool()` in
`packages/host/src/runtime/agent-runtime-assembly.ts` counts completion from
`signal === "completed"` only. It ignores the canonical finality and truncation
fields that were introduced to keep execution finality independent from child
health.

## Diagnostic Move

For parallel delegation, compare each raw `subagent.completed` projection with
the aggregate `delegate_parallel` result and root assessment. Do not infer
complete finality from the Core signal alone.

## Prevention

- Count a child complete only when canonical finality is complete and neither
  truncation nor a step limit is present.
- Keep health orthogonal: a complete-but-failing child is unhealthy, while a
  clean partial child is incomplete.
- Add a Host test for `signal:completed` plus `finality:partial`.

## Evidence

- `session_qa_agent_parallel_mixed_20260719`: root
  `run_mrri004ea0xt1si5`, partial child `run_mrri04cqzs162y0m`.
- `session_qa_agent_parallel_mixed_r2_20260719`: root
  `run_mrri4cis3tqomp02`, partial child `run_mrri4gnn8tbg4a01`.
- `session_qa_agent_parallel_mixed_r3_20260719`: root
  `run_mrri4ciwoxrlf78e`, partial child `run_mrri4gslahv5bgdo`.
- Session roots:
  `/Applications/xgw/projects/AI-native/project/test/qa_agent_agent_health_cache_20260719/.sparkwright/sessions`.

## Fix

- 2026-07-19: parallel aggregation now uses the shared canonical Agent finality
  predicate. A completed signal with partial finality, truncation, or a step
  limit is counted as incomplete; health remains a separate unhealthy count.
- Added a mixed Host fixture for `signal:completed` plus partial finality.
- Full Agent Runtime (235) and Host (592) suites passed.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-07-19-real-terra-refactor-qa-follow-up.md](../runs/2026-07-19-real-terra-refactor-qa-follow-up.md)
