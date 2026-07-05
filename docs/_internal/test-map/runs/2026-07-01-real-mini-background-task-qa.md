# 2026-07-01 Real Mini Background Task QA

## Direction

Use configured `openai/gpt-5.4-mini` to exercise SparkWright in realistic CLI
usage around the current background-agent/task branch. Prefer read-only runs,
use a temporary session root, and classify model/prompt/config variance
separately from product defects.

## Environment

- Workspace: `/Applications/xgw/projects/AI-native/SparkWright`
- Branch: `feat/background-agent-jobs`
- Model: `openai/gpt-5.4-mini` from user config
- Access posture:
  - default config had `run.accessMode: ask`, so normal `run` is write-enabled
    even without `--write`
  - explicit `--access-mode read-only` used for controls and task runs
- Dist state: initially stale for `coding-tools`, `core`, and `host`; rebuilt
  those workspaces before CLI QA. `npm run check:dist-fresh` then passed.

## Commands

```bash
npm run build --workspace @sparkwright/coding-tools
npm run build --workspace @sparkwright/core
npm run build --workspace @sparkwright/host
npm run check:dist-fresh

node packages/cli/dist/index.js capabilities inspect --workspace . --model openai/gpt-5.4-mini --format text

node packages/cli/dist/index.js run "<repo risk prompt>" --workspace . --session-root /tmp/sparkwright-mini-qa-20260701-readonly --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<short read-only control>" --workspace . --session-root /tmp/sparkwright-mini-qa-20260701-readonly-control --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<background task prompt>" --workspace . --session-root /tmp/sparkwright-mini-qa-20260701-task --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<background task prompt>" --workspace . --session-root /tmp/sparkwright-mini-qa-20260701-task-yes --access-mode read-only --yes --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<explicit task_create kind=agent prompt>" --workspace . --session-root /tmp/sparkwright-mini-qa-20260701-task-agent --access-mode read-only --yes --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<explicit task_create kind=agent prompt, after schema fix>" --workspace . --session-root /tmp/sparkwright-mini-qa-20260701-task-agent-fixed --access-mode read-only --yes --model openai/gpt-5.4-mini --trace-level debug

npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts test/tasks.test.ts
npm --workspace @sparkwright/agent-runtime run typecheck
npm run build --workspace @sparkwright/agent-runtime
npm --workspace @sparkwright/host test -- test/tools.test.ts -t "main host tool catalog"
npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "starts a background agent through the real task_create tool"
npm --workspace @sparkwright/host run typecheck
npm run build --workspace @sparkwright/host
npm run check:dist-fresh
```

## Results

- Capability inspect passed for `openai/gpt-5.4-mini`; pricing remained
  unavailable because no model cost block is configured.
- Focused deterministic gates passed:
  - agent-runtime: 65 tests passed after the task_create schema fix
  - host background agent task runner: 2 tests passed
  - host main tool catalog focused test passed and asserts
    `task_create.kind` enum `["agent"]`, required top-level `payload`, and
    `payload.required` `["goal", "role", "prompt"]`
  - host protocol background-agent task test passed
  - agent-runtime and host typecheck passed
  - agent-runtime and host builds passed; `npm run check:dist-fresh` passed
- Explicit read-only control passed:
  - trace `/tmp/sparkwright-mini-qa-20260701-readonly-control/session_mr1lgrz1kh47gzb0/trace.jsonl`
  - 2 model calls, 2 `read` calls, no trace report findings, session check ok.
- Default-config repo-risk run completed but exited nonzero:
  - trace `/tmp/sparkwright-mini-qa-20260701-readonly/session_mr1ldp9h9vz12j9v/trace.jsonl`
  - 9 model calls, 38 tool calls, 37 reads, no writes, session check ok
  - trace report: `LOW_NET_PROGRESS` and `REPEATED_TOOL_REQUESTS`
  - built-in documented-command hook flagged README `cd SparkWright`; this run
    was write-enabled because config `accessMode: ask` compiled to
    `shouldWrite:true`.
- Background task without auto-approval did not exercise the task runner:
  - trace `/tmp/sparkwright-mini-qa-20260701-task/session_mr1lhcyd85pbj117/trace.jsonl`
  - mini selected `task_create`, but noninteractive approval denied it.
- Background task with `--yes` exposed a model-facing contract problem:
  - trace `/tmp/sparkwright-mini-qa-20260701-task-yes/session_mr1lhtfq6t0qzzcp/trace.jsonl`
  - mini used `task_create.kind="repo-inspector"` from the requested role;
    runtime only had `kind="agent"` registered, so `TASK_KIND_UNREGISTERED`
    remained unresolved.
  - `tool_search` could discover deferred `task` but not eager `task_create`;
    it did not reveal legal task_create kinds.
- Explicit `kind:"agent"` showed the runner is present but the prompt/model
  still failed to form a valid payload:
  - trace `/tmp/sparkwright-mini-qa-20260701-task-agent/session_mr1ljb1xvbnmx16i/trace.jsonl`
  - first `task_create` returned `task_mr1ljd7c69bo9uq9`
  - model sent `payload:{}` despite a strong prompt with nested fields
  - durable task failed immediately with
    `TASK_RUNNER_FAILED: spawn_agent goal must be a non-empty string`
  - model repeated the same `task_create` call and hit `TOOL_DOOM_LOOP`
- Post-fix explicit `kind:"agent"` rerun split the root cause from the
  remaining model loop:
  - trace `/tmp/sparkwright-mini-qa-20260701-task-agent-fixed/session_mr1lz0xua6sedleb/trace.jsonl`
  - first `task_create` args contained full payload:
    `goal`, `role`, `prompt`, `allowedTools:["read"]`, `maxSteps:4`
  - durable task `task_mr1lz3bphpeg925k` completed, with child run
    `run_mr1lz3br3b0iwps2` and `subagent.completed` for
    `dynamic_repo-inspector`
  - parent model later repeated the same `task_create` instead of monitoring
    the returned task id, causing `REPEATED_TOOL_CALL_SKIPPED` and final
    `TOOL_DOOM_LOOP`

## Findings

- Product bug, fixed in current source: `task_create` was model-facing but did
  not expose registered task kinds or the required payload shape for
  `kind:"agent"`. Real mini could select the tool but could not reliably
  construct a valid background-agent task. The fix makes host advertise
  `kind:"agent"` plus the `goal` / `role` / `prompt` payload contract and makes
  unknown-kind errors list available kinds.
- Prompt/model variance: when `task_create` succeeds, mini may repeat the same
  call instead of querying `task(action=get|output)` with the returned task id.
  The runtime duplicate guard catches this, but the parent run can still fail.
  The post-fix durable task completed, so classify this separately from the
  task_create payload contract.
- Config sensitivity: with local `run.accessMode: ask`, a normal CLI `run`
  activates write-enabled Stop hooks even when the prompt says read-only.
- Documentation-hook risk: README's quick-start `git clone <repo>` then
  `cd SparkWright` is valid in setup context, but the documented-command guard
  checks paths relative to the current workspace and can flag it as stale.

## Follow-up

- Keep the post-create repeat as a separate watch item: if it recurs under
  strong prompts, consider making task-monitoring guidance more model-visible
  after `task_create`, or ensuring `task` discovery is loaded alongside
  eager `task_create` when the run asks for background tasks.
- Revisit documented-command checks for clone-then-cd quick-start snippets, or
  scope that guard more tightly to verification/handoff runs.
