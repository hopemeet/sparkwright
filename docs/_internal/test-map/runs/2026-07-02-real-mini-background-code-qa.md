# 2026-07-02 Real Mini Background Code QA

## Summary

- Scenario: Focused background-task gates plus two real
  `openai/gpt-5.4-mini` CLI runs: a temporary coding fixture and an awaited
  background agent task with explicit `task_create` -> `task wait` ->
  `task output` monitoring.
- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/tui-rendering.md](../coverage/tui-rendering.md).
- Result: `partial`
- Reusable lesson: Background `task_create(kind:"agent")` execution,
  notification injection, and task output retrieval worked, but the deferred
  `task` model-facing schema/guidance still lets mini batch dependent
  `wait`/`output` calls with empty task ids before the `task_create` result is
  available. Later successful wait/output did not recover those empty-target
  failures, so CLI exited non-zero despite a correct final answer.

## Test Setup

- Task direction: Test recently added background task management/communication
  with realistic code and repository scenarios.
- Prompt shape: `strong` for coding and background-task monitoring.
- Model class: real provider/model `openai/gpt-5.4-mini`.
- Capabilities: default local catalog, including `read`, `write`, `bash`,
  `task_create`, deferred `task`, deferred `spawn_agent`, and `tool_search`.
- Permission/approval posture:
  - focused repo tests are deterministic/read-only;
  - coding fixture used `--access-mode accept-edits --yes`;
  - background task run used `--access-mode read-only --yes`.
- Workspace/config isolation:
  - coding fixture in `/tmp/sparkwright-real-mini-code.kdEl1P`;
  - background run session root in `/tmp/sparkwright-real-mini-bg.zbXt46`;
  - durable task record written under the repo task store
    `.sparkwright/tasks/tasks/task_mr31lao7rmsc3cet/record.json`.
- Trace level: `debug`.
- Environment notes: user config used grouped YAML identity with
  `openai/gpt-5.4-mini` configured; provider pricing unavailable because no
  pricing block is configured.

## Commands Or Harness

```bash
git status --short --branch
npm run check:dist-fresh
node packages/cli/dist/index.js capabilities inspect --workspace . --model openai/gpt-5.4-mini --format text

npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
npm --workspace @sparkwright/core test -- test/run.test.ts -t "awaited task|waiting_tasks|revival"
npm --workspace @sparkwright/host test -- test/task-revival.test.ts test/agent-task-runner.test.ts test/protocol.test.ts -t "background agent|orphaned|task\\.join|task\\.promote|starts a background agent|task revival"
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts -t "promotes|background|nested|foreground-only|cancellation"
npm --workspace @sparkwright/tui test -- test/activity-panel-render.test.tsx test/event-stream-render.test.ts test/status-bar-render.test.tsx test/tool-request-preview.test.ts
npm --workspace @sparkwright/core test -- test/access-mode.test.ts
npm --workspace @sparkwright/host test -- test/config.test.ts test/run-access.test.ts -t "background task|backgroundTasks|accessMode|foreground-only"
npm run schema:check

node packages/cli/dist/index.js run "<fix cart fixture prompt>" --workspace /tmp/sparkwright-real-mini-code.kdEl1P --session-root /tmp/sparkwright-real-mini-code.kdEl1P/.sparkwright/sessions --access-mode accept-edits --yes --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<task_create then task wait/output prompt>" --workspace . --session-root /tmp/sparkwright-real-mini-bg.zbXt46 --access-mode read-only --yes --model openai/gpt-5.4-mini --trace-level debug
```

## Stable Evidence

- `npm run check:dist-fresh`: passed for 26 built workspaces before real CLI
  runs.
- Focused gates passed:
  - agent-runtime task tests: 43 passed;
  - core awaited/waiting/revival slice: 7 passed;
  - host task revival/background agent/protocol slice: 5 passed;
  - host spawn promotion/background/nested slice: 4 passed;
  - TUI task/activity/status/tool rendering: 35 passed;
  - core access mode: 6 passed;
  - host config/run-access background policy slice: 7 passed;
  - `schema:check`: 22 JSON Schema files, 15 JSON instances, and protocol
    consistency passed.
- Coding fixture:
  - trace:
    `/tmp/sparkwright-real-mini-code.kdEl1P/.sparkwright/sessions/session_mr31jpr3m6woq17r/trace.jsonl`
  - mini applied one managed write to `src/cart.js`;
  - `npm test` passed after the run;
  - `trace summary`: 8 model calls, 8 tool calls, 1 write, 0 tool failures,
    last successful verification `npm test`;
  - `session check`: ok.
- Background task:
  - trace:
    `/tmp/sparkwright-real-mini-bg.zbXt46/session_mr31l4683b1wzxq8/trace.jsonl`
  - `task_create` args used `kind:"agent"`, `mode:"awaited"`, and a complete
    payload with `goal`, `role`, `prompt`, `allowedTools:["read"]`, and
    `maxSteps:4`;
  - durable task `task_mr31lao7rmsc3cet` completed with child run
    `run_mr31laobkmjlpkys`, agent `dynamic_package-inspector`, and
    `finality:"complete"`;
  - later `task(action:"wait")` and `task(action:"output")` with the real
    task id both completed;
  - `run.notification.injected` fired once after terminal task output;
  - `trace verify`: ok.

## Non-Invariants Observed

- The coding run solved the fixture but spent three model calls after the final
  write before concluding. `trace report` flagged `LOW_NET_PROGRESS`; final
  prose also said no code change was needed even though one managed write was
  applied. Treat this as model/prompt efficiency and answer wording, not as a
  write-safety failure.
- In the background task run, mini first batched `task_create`, `task wait`,
  and `task output` in one model turn. The two dependent `task` calls used
  `taskId:""` / `ids:[]`, failed, and were followed by later valid calls after
  the real task id became visible.

## Failures

- Failure pattern:
  [../failures/task-action-empty-id-recovery.md](../failures/task-action-empty-id-recovery.md)
- Cause bucket: `product_bug` for the weak model-facing `task` schema/reporting
  recovery gap; `model_variance` for mini batching dependent calls despite a
  sequential prompt.
- Count update: new count `1`.

## Coverage Update

- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: Added real mini evidence for successful awaited background-agent
  task communication and a remaining weak spot around deferred `task` action
  argument guidance.
- Page: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Change: Added evidence that `trace verify` can be clean while
  `trace report`/CLI fail on unrecovered empty-target task argument failures.

## Follow-Up

- Strengthen the model-facing `task` schema and/or tool description with
  action-specific constraints: `wait` requires a non-empty `ids` array or
  non-empty `taskId`; `output` and `get` require non-empty `taskId`.
- Consider guidance after `task_create` that dependent `task` calls must be in
  a later model turn using the returned id, not batched with placeholders.
- Decide whether later successful `task wait/output` for a concrete task id
  should recover earlier empty-target placeholder failures, or whether the CLI
  should keep exiting non-zero to force inspection.

## Follow-Up Resolution

Fixed later on 2026-07-02. The product now combines action-specific deferred
`task` schema guidance, tool-owned semantic `validateInput()`, stricter
`parseWaitArgs()` handling for explicitly empty `taskId`, and core
tool-outcome recovery for empty placeholders followed by later concrete
same-action task monitoring.

Verification note:
[2026-07-02-task-action-empty-id-fix-verification.md](2026-07-02-task-action-empty-id-fix-verification.md)
