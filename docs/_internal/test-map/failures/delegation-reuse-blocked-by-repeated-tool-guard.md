# Delegation Reuse Blocked by Repeated Tool Guard

## Record

- Pattern ID: `delegation-reuse-blocked-by-repeated-tool-guard`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A real Terra parent called indexed `delegate_agent` twice with the same
`agentId` and exact goal after the first child completed cleanly. The second
call never reached the shared delegation ledger: Core emitted
`REPEATED_TOOL_CALL_SKIPPED`, so the expected `alreadyCompleted:true` result was
unavailable and the parent completed with issues.

## Root Cause

The Agent Runtime ledger correctly admitted only complete+clean results and
could return an exact cached result, but Core's generic sequential repeat guard
ran before tool execution. It had no way to distinguish a generic redundant
tool call from a tool whose implementation owns conservative duplicate
handling.

## Resolution

Fixed 2026-07-19 by adding argument-aware
`ToolDefinition.managesRepeatedCalls(args)`. Direct Agent tools, indexed
delegation, parallel delegation, and dynamic spawn opt in only to let clean
sequential verbatim repeats reach their shared cache/retry protocol. A prior
tool failure or explicit no-progress result still uses the generic guard;
same-turn duplicate suppression and `governance.idempotency` replay-risk
semantics are unchanged.

The fixed Terra rerun emitted two `delegate_agent` requests but only one child
lifecycle. The second call completed in 2ms with the original `childRunId` and
`alreadyCompleted:true`; trace verification and session check had no findings.

## Diagnostic Move

When an expected Agent cache hit becomes `REPEATED_TOOL_CALL_SKIPPED`, compare
the second `tool.requested` with `subagent.completed`. If no second child was
requested and no cached `tool.completed` was returned, inspect the Core repeat
gate before changing the delegation ledger.

## Prevention

- Keep a Core run-loop test proving a tool-owned duplicate handler executes a
  sequential verbatim repeat without disabling the generic guard.
- Keep Host coverage proving indexed delegation forwards the selected target's
  duplicate ownership and returns the original child with
  `alreadyCompleted:true`.
- Retain real-model coverage asserting two indexed calls, one child lifecycle,
  no repeat failure, and clean trace/session diagnostics.

## Evidence

- Pre-fix trace: `/Applications/xgw/projects/AI-native/project/test/.sparkwright/sessions/session_cli_child_clean_reuse_20260719/trace.jsonl`
- Fixed trace: `/Applications/xgw/projects/AI-native/project/test/.sparkwright/sessions/session_cli_child_clean_reuse_fixed_20260719/trace.jsonl`
- Source: `packages/core/src/run.ts`, `packages/core/src/tools.ts`,
  `packages/agent-runtime/src/index.ts`, and
  `packages/host/src/indexed-delegate-tool.ts`

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md)
- Run note: [../runs/2026-07-19-real-terra-broad-refactor-qa.md](../runs/2026-07-19-real-terra-broad-refactor-qa.md)
