# 2026-07-02 Real Mini Background Agent Bash Shell QA

## Summary

- Scenario: Two real `openai/gpt-5.4-mini` CLI canaries focused on
  background-agent tasks and bash:
  - repo read-only run that combined parent `bash` with awaited
    `task_create(kind:"agent")`;
  - temporary write-enabled fixture with a 300 ms shell foreground budget to
    force promoted-shell task behavior.
- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/shell.md](../coverage/shell.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md).
- Result: `partial_then_fixed`
- Reusable lesson: `--access-mode read-only --yes` still denies `bash` because
  bash is classified as risky/write-capable; use a write-enabled temporary
  fixture when the scenario intentionally exercises bash. A second, product-
  relevant issue was fixed after the run: repeated expected denials now remain
  expected-denial derivatives instead of unresolved
  `REPEATED_TOOL_CALL_SKIPPED` failures. Background `agent` tasks and
  promoted-shell task output retrieval were healthy.

## Test Setup

- Task direction: User requested mini-model QA close to real use, especially
  background tasks, agents, and bash.
- Prompt shape: `strong` for both real-model canaries.
- Model class: real provider/model `openai/gpt-5.4-mini`.
- Capabilities: default catalog with eager `bash` and `task_create`; deferred
  `task` loaded through `tool_search`.
- Permission/approval posture:
  - repo canary: `--access-mode read-only --yes`;
  - shell-promotion fixture: `--access-mode accept-edits --yes`.
- Workspace/config isolation:
  - repo canary used session root
    `/tmp/sparkwright-real-mini-bg-agent-bash-20260702`;
  - shell fixture used `/tmp/sparkwright-mini-shell-promotion.Ao9JSo` with
    project config `run.backgroundTasks: enabled` and
    `shell.foregroundTimeoutMs: 300`.
- Trace level: `debug`.
- Environment notes: `npm run check:dist-fresh` passed before real CLI runs;
  user config exposed `openai/gpt-5.4-mini`; provider pricing remained
  unavailable because no pricing block is configured.

## Commands Or Harness

```bash
npm run check:dist-fresh
node packages/cli/dist/index.js capabilities inspect --workspace . --model openai/gpt-5.4-mini --format text
npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
npm --workspace @sparkwright/host test -- test/task-revival.test.ts test/agent-task-runner.test.ts test/protocol.test.ts -t "background agent|orphaned|task\\.join|task\\.promote|starts a background agent|task revival"
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts -t "promotes|background|nested|foreground-only|cancellation"
npm --workspace @sparkwright/core test -- test/run-outcome.test.ts test/trace.test.ts -t "task|recovered|subagent|background|trace"

node packages/cli/dist/index.js run "<read-only parent bash plus awaited agent task prompt>" --workspace . --session-root /tmp/sparkwright-real-mini-bg-agent-bash-20260702 --access-mode read-only --yes --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<promoted shell task prompt>" --workspace /tmp/sparkwright-mini-shell-promotion.Ao9JSo --session-root /tmp/sparkwright-mini-shell-promotion.Ao9JSo/.sparkwright/sessions --access-mode accept-edits --yes --model openai/gpt-5.4-mini --trace-level debug
```

## Stable Evidence

- Deterministic gates passed:
  - `check:dist-fresh`: fresh for 26 built workspaces;
  - agent-runtime task tests: 46 passed;
  - host task revival/background-agent/protocol slice: 5 passed;
  - host spawn promotion/background/nested slice: 4 passed;
  - core run-outcome/trace slice: 124 passed.
- Read-only repo canary:
  - trace:
    `/tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl`;
  - mini first tried `bash {"command":"pwd && node -v"}` and hit expected
    `TOOL_DENIED` because the run was read-only;
  - mini repeated the same bash command once and hit
    `REPEATED_TOOL_CALL_SKIPPED`, making the pre-fix `trace report` fail with
    one unresolved repeated-tool failure;
  - the awaited background agent task still worked: `task_create` returned
    `task_mr3fv85gp3mwdlrd`; `task(action:"wait")` used that concrete id;
    child run `run_mr3fv85l73fj98oy` completed with
    `finality:"complete"`; `run.notification.injected` fired once;
    `trace verify` was ok; session check was `ok_with_warnings`.
- Promoted-shell fixture canary:
  - trace:
    `/tmp/sparkwright-mini-shell-promotion.Ao9JSo/.sparkwright/sessions/session_mr3fx1c73opywmcr/trace.jsonl`;
  - capability inspect reported `shell foreground: timeoutMs=300;
    promotionAvailable=true`;
  - bash ran `npm run slow:echo`, returned `promoted:true`, and created
    `task_mr3fx4fdrq53skvu`;
  - `task.completed` recorded `exitCode:0` and stdout containing
    `PROMOTED_OK`;
  - mini loaded `task` through `tool_search` and called
    `task(action:"output", taskId:"task_mr3fx4fdrq53skvu")`;
  - CLI exit 0; trace summary reported 0 tool failures; `trace verify` and
    session check were ok.

## Non-Invariants Observed

- The read-only repo prompt intentionally mixed a denied risky tool (`bash`)
  with a read-only background-agent task. The bash denial is a policy boundary,
  not evidence that the background task runner failed.
- In the promoted-shell fixture, mini used `task output` after the task had
  already completed instead of calling `task wait` first. That is valid because
  `run.notification.injected` and the task record were already terminal.
- Exact model step count and final prose are not stable assertions.

## Failures

- Failure pattern:
  [../failures/repeated-expected-denial-outcome.md](../failures/repeated-expected-denial-outcome.md)
- Cause bucket: `prompt_underspecified` for the repo canary's incompatible
  read-only + bash requirement; `product_bug` (fixed) for core losing
  expected-denial semantics when the repeated-tool guard emitted
  `REPEATED_TOOL_CALL_SKIPPED`.
- Count update: new count `1`.

## Fix Verification

- Source fix owner: `@sparkwright/core` run loop/outcome/trace diagnostics.
- Focused regressions passed:
  - `npm --workspace @sparkwright/core test -- test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`
  - `npm --workspace @sparkwright/core run typecheck`
  - `npm run build --workspace @sparkwright/core`
  - `npm run check:dist-fresh`
- Historical trace replay after fix:
  - `trace summary` now reports `errors: 0`, `expected denials: 2`
    (`TOOL_DENIED:1`, `REPEATED_TOOL_CALL_SKIPPED:1`), and
    `unresolved tool failures: 0`;
  - `trace report` no longer reports unresolved tool failures; it remains
    `passed_with_issues` only because the exploratory run had `LOW_NET_PROGRESS`;
  - `trace verify` status is `ok`.

## Coverage Update

- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: Added real mini evidence that awaited background `agent` tasks can
  still complete and inject notification while an unrelated parent bash call is
  denied by read-only policy.
- Page: [../coverage/shell.md](../coverage/shell.md)
- Change: Added real mini evidence for promoted-shell task creation,
  completion, and output retrieval with short foreground timeout.
- Page: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Change: Added evidence and fix verification for a structurally valid
  read-only background-agent trace where a repeated expected bash denial is now
  counted as an expected denial derivative, not an unresolved tool failure.
  Promoted-shell traces still surface `UNTRACKED_WRITE_CAPABLE_BOUNDARY` as
  `passed_with_issues`.

## Follow-Up

- Keep bash canaries in write-enabled temporary fixtures unless the test is
  explicitly about read-only policy denial.
- Consider a small `task wait` API fix: single-id/default `mode:"any"` can
  return `terminalTaskIds` with the requested id while `complete:false`, which
  is technically barrier semantics but misleading for one-id waits.
- Consider trace plumbing parity for background `agent` tasks: promoted shell
  emits `task.created`/`task.started`/`task.completed`, while the real agent-task
  trace relied on `tool.completed`, `subagent.*`, and task wait output.
