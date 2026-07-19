# Workflow Resumable Trace Report Divergence

## Record

- Pattern ID: `workflow-resumable-trace-report-divergence`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A three-episode real Workflow finishes with durable status `completed` and a
canonical execution assessment of `degraded` only for a recovered tool failure.
CLI reports `completed_with_issues` and exits 0. Offline `trace report` judges
the same trace `failed` because the two intermediate, resumable Core
`run.failed` events are counted as `TRACE_ERRORS`.

## Root Cause

Execution aggregation understands that budget-limited intermediate episodes
are superseded by an authorized durable Workflow continuation. Core trace
diagnostics operate on generic run terminals and do not use Workflow episode
authorization/finality to suppress resumable `MAX_STEPS_EXCEEDED` and
`MAX_MODEL_CALLS_EXCEEDED` from the final verdict.

## Diagnostic Move

For a multi-episode Workflow, compare the durable Workflow terminal record,
persisted `ExecutionAssessment`, CLI status/exit, and offline trace report.
Intermediate Core failures must be classified with Workflow continuation
context rather than as standalone terminal errors.

## Prevention

- Teach trace diagnostics which Core stops are resumable and superseded by a
  later authorized Workflow episode.
- Preserve the intermediate events in the audit trail while deriving the final
  report verdict from canonical Workflow/execution terminal facts.
- Add a three-episode trace fixture with two resumable budget stops and a clean
  final node.

## Evidence

- Workflow run `workflow_run_mrrigh3awvg7zahg`.
- Core runs `run_mrrigh49zfhxl2bw`, `run_mrrigkp7fbn05udq`, and
  `run_mrrigmtid9g6gmtd`.
- Trace:
  `/Applications/xgw/projects/AI-native/project/test/qa_tui_agent_20260719_tui_evidence/sessions/session_workflow_74d3546eff4640edadd0a114854ff01a/trace.jsonl`.
- `trace verify` and `session check` are structurally healthy; the split is the
  semantic report verdict.

## Fix

- 2026-07-19: the existing resumable-failure reason predicate is shared from
  Core by Host execution aggregation and trace diagnostics. Offline report
  retains intermediate events but excludes a resumable `run.failed` from
  `TRACE_ERRORS` only when a later episode terminal for the same
  `workflowRunId` supersedes it. Independent later runs in the same session do
  not hide historical failures.
- The retained three-episode trace now reports `passed_with_issues` with only
  `RECOVERED_TOOL_FAILURES`; Core trace coverage passed (132 focused, 641 full).

## Related

- Coverage: [../coverage/workflow-durable-jobs.md](../coverage/workflow-durable-jobs.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-07-19-real-terra-refactor-qa-follow-up.md](../runs/2026-07-19-real-terra-refactor-qa-follow-up.md)
