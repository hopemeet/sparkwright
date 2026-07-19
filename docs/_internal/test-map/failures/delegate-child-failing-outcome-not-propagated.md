# Delegate Child Failing Outcome Is Not Propagated

## Record

- Pattern ID: `delegate-child-failing-outcome-not-propagated`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A configured `code-reviewer` child recovered enough to return useful findings,
but its `run.completed` payload carried a failing terminal assessment after
an unrecovered invalid `grep` call. The parent still emitted
`subagent.completed`, completed `delegate_agent` successfully, and received an
output with no child-health field.

## Root Cause

Agent Runtime treats Core execution completion as equivalent to a clean child:

- `spawnSubAgent()` maps every child `run.completed` event to
  `subagent.completed`; `subagentTerminalProjection()` checks only event type,
  step limit, and truncation, not `payload.outcome.failing`.
- `createAgentTool()` throws only when `RunResult.signal !== "completed"`.
- `summarizeDelegationResult()` copies signal, stop reason, message, and usage,
  but drops `RunResult.metadata.outcome`.
- The result is then recorded by `rememberSuccessfulDelegation()`, so the
  degraded child is eligible for successful-result reuse.

Core intentionally separates terminal execution (`signal:"completed"`) from
assessment health. The Agent boundary consumed
only the first half of that contract, causing the health verdict to disappear.

## Resolution

Fixed 2026-07-19 with one canonical Agent result projection. Direct,
configured, indexed, parallel, lifecycle, delegation-ledger, compacted-session,
and cache paths now carry required `finality` plus Core `assessment`. A complete
but failing child stays complete, is visible as unhealthy to the parent and
TUI/trace diagnostics, and is ineligible for successful-result reuse. Missing
assessment fails closed.

Deterministic evidence includes Agent Runtime result/ledger/lifecycle tests,
Host `delegate_parallel` complete-but-failing coverage, Core
`SUBAGENT_UNHEALTHY` diagnostics, and TUI health rendering.

## Diagnostic Move

When a parent delegate succeeds, inspect the child `run.completed.assessment` as
well as `subagent.completed` and the parent `tool.completed` output. A useful
child message does not imply a clean child run.

## Prevention

- Keep an Agent Runtime regression whose child returns a final answer plus a
  failing assessment from an unresolved tool failure.
- Assert parent lifecycle finality, delegate output, and delegation-ledger reuse
  all preserve or reject the failing health fact consistently.
- Keep partial/truncated execution distinct from completed-but-failing health;
  both need explicit parent-visible semantics.

## Evidence

- Trace: `/Applications/xgw/projects/AI-native/project/test/.sparkwright/sessions/session_mrqz855uoi04dgdd/trace.jsonl`
- Parent run: `run_mrqz85cmjgccjykr`
- Child run: `run_mrqz8an8p7hf6yg1`
- Source: `packages/agent-runtime/src/index.ts` and
  `packages/agent-runtime/src/agents/supervisor.ts`

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md)
- Run note: [../runs/2026-07-19-real-terra-broad-refactor-qa.md](../runs/2026-07-19-real-terra-broad-refactor-qa.md)
