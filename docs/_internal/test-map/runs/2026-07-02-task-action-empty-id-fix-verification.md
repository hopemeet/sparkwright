# 2026-07-02 Task Action Empty Id Fix Verification

## Summary

- Scenario: Root-cause fix verification for real mini background task
  monitoring after a same-turn empty-id `task wait` / `task output` placeholder
  failure.
- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md).
- Result: `pass`
- Reusable lesson: Action-specific provider schema is useful guidance, but
  runtime invariants still need tool-owned `validateInput()` because the local
  schema validator intentionally covers only a small JSON Schema subset.

## Fix Verified

- `packages/agent-runtime/src/tasks/tools.ts`:
  - action-specific deferred `task` schema with non-empty id constraints;
  - semantic `validateInput()` rejection for empty task monitor placeholders;
  - `parseWaitArgs()` rejects explicitly empty `taskId`.
- `packages/core/src/run-outcome.ts`:
  - records task monitor call args;
  - recovers empty task monitor placeholder failures only after a later
    same-action concrete task monitor call succeeds.
- `packages/host/test/tools.test.ts`:
  - asserts the main host catalog preserves the action-specific deferred
    `task` schema.

## Evidence

- Old failing trace:
  `/tmp/sparkwright-real-mini-bg.zbXt46/session_mr31l4683b1wzxq8/trace.jsonl`
  - post-fix `trace summary`: 2 recovered tool failures, 0 unresolved;
  - post-fix `trace report`: `passed_with_issues`,
    `RECOVERED_TOOL_FAILURES`;
  - post-fix `session check`: ok.
- New real mini rerun:
  `/tmp/sparkwright-real-mini-bg-fixed-20260702/session_mr39dffk4zblw084/trace.jsonl`
  - model: `openai/gpt-5.4-mini`;
  - prompt shape: strong, explicit `task_create` -> `task wait` ->
    `task output`;
  - CLI exit: 0;
  - `trace summary`: 6 tool calls, 0 tool failures, 0 unresolved/recovered;
  - `trace report`: `ok`;
  - `session check`: ok;
  - `task(action:"wait")` and `task(action:"output")` used concrete
    `task_mr39dm012zmcqavi`.

## Commands

```bash
npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
npm --workspace @sparkwright/core test -- test/run-outcome.test.ts test/trace.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts -t "main host tool catalog"
npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts test/protocol.test.ts -t "background agent|starts a background agent through the real task_create tool"
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts -t "background|nested|promotes"
npm --workspace @sparkwright/core run typecheck
npm --workspace @sparkwright/agent-runtime run typecheck
npm run build --workspace @sparkwright/core
npm run build --workspace @sparkwright/agent-runtime
npm run check:dist-fresh
node packages/cli/dist/index.js run "<task_create then task wait/output prompt>" --workspace . --session-root /tmp/sparkwright-real-mini-bg-fixed-20260702 --access-mode read-only --yes --model openai/gpt-5.4-mini --trace-level debug
```

## Related

- Failure pattern:
  [../failures/task-action-empty-id-recovery.md](../failures/task-action-empty-id-recovery.md)
- Prior failing run:
  [2026-07-02-real-mini-background-code-qa.md](2026-07-02-real-mini-background-code-qa.md)
