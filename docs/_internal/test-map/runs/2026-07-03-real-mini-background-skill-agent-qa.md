# 2026-07-03 Real Mini Background Skill Agent QA

## Summary

- Scenario: Real `openai/gpt-5.4-mini` QA after the background-agent jobs,
  actor-inbox/task notification, Skill usage, and Skill evolution changes.
- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/skills.md](../coverage/skills.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md).
- Result: `partial_then_fixed`
- Reusable lesson: Background `agent` tasks, Skill proposal-first mutation, and
  indexed delegate use were healthy in this run. The issue found and fixed was
  diagnostic: pre-fix `trace report` emitted `LOW_NET_PROGRESS` for a
  successful read-only background-agent workflow because the heuristic
  thresholded aggregate parent + child model/tool calls before judging low file
  progress.

## Test Setup

- Task direction: Find issues in recently implemented SparkWright behavior,
  especially Skill, agent, and background-task paths.
- Prompt shape: `strong` for real-model canaries; focused deterministic gates
  for source contracts.
- Model class: real provider/model `openai/gpt-5.4-mini`.
- Capabilities: default catalog with `task_create`, deferred `task`,
  `create_skill` / `update_skill`, `create_agent`, indexed `delegate_agent`,
  workspace read tools, and governed shell/write tools.
- Permission/approval posture:
  - Skill create/update and agent create used `--write --yes`;
  - background-agent task fixture used `--access-mode ask --yes`;
  - deterministic tests used their local harness policies.
- Workspace/config isolation: real write-capable canaries used temporary
  workspaces under `/var/folders/...`; the manual background-agent fixture used
  `/tmp/sparkwright-real-mini-bg-current.9hEJTL`.
- Trace level: `debug` for real CLI runs.
- Environment notes: `npm run build` and `npm run check:dist-fresh` passed
  first; user config exposed `openai/gpt-5.4-mini`; provider pricing remained
  unavailable because no local pricing block is configured.

## Commands Or Harness

```bash
npm run build
npm run check:dist-fresh
npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts test/task-revival.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "background agent|task_create|run.notification|revival"
npm --workspace @sparkwright/host test -- test/skill-usage.test.ts test/skill-evolution.test.ts
npm --workspace @sparkwright/skills test -- test/usage.test.ts test/index.test.ts
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-agents
node packages/cli/dist/index.js run "<task_create(kind:'agent', mode:'awaited') then task wait/output prompt>" --workspace /tmp/sparkwright-real-mini-bg-current.9hEJTL --model openai/gpt-5.4-mini --access-mode ask --yes --trace-level debug
```

## Stable Evidence

- Build/dist:
  - `npm run build`: passed;
  - `npm run check:dist-fresh`: fresh for 26 built workspaces.
- Deterministic gates passed:
  - agent-runtime task tests: 59 passed;
  - host background-agent runner + task revival: 3 passed;
  - host protocol background-agent `task_create` slice: 1 passed;
  - host Skill usage/evolution: 12 passed;
  - `@sparkwright/skills` usage/index tests: 43 passed.
- Skill real regression:
  - temp root:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-ZfbM5F`;
  - static skill tool filtering and bash managed-package guard passed;
  - create trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-ZfbM5F/real-create/.sparkwright/sessions/session_mr4hbnlyzwu6by3j/trace.jsonl`;
  - create evidence: tools `tool_search,create_skill`; one proposal
    `skillprop_mr4hbua4hci5ia5r`; proposal contains `SKILL.md`; 6 capability
    mutations; 0 workspace writes;
  - update trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-ZfbM5F/real-update/.sparkwright/sessions/session_mr4hbzbf5k5tive5/trace.jsonl`;
  - update evidence: tools `tool_search,list_skills,read,update_skill`; one
    proposal `skillprop_mr4hc7x1zdotszqv`; 6 capability mutations; source Skill
    hash unchanged.
- Agent real regression:
  - temp root:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-g3cTa7`;
  - create trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-g3cTa7/workspace/.sparkwright/sessions/session_mr4hcly1mf5pwneo/trace.jsonl`;
  - create evidence: tools `tool_search,create_agent`; 1 workspace write; 1
    capability mutation;
  - delegate trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-g3cTa7/workspace/.sparkwright/sessions/session_mr4hcvy1xlmm90qp/trace.jsonl`;
  - delegate evidence: tools `tool_search,delegate_agent,read`; `agentIds`
    `main,mini_reviewer`; `subagentIds` `mini_reviewer`; child attribution
    `mini_reviewer`.
- Manual background-agent task canary:
  - workspace:
    `/tmp/sparkwright-real-mini-bg-current.9hEJTL`;
  - trace:
    `/tmp/sparkwright-real-mini-bg-current.9hEJTL/.sparkwright/sessions/session_mr4hdu7zh7hdjb8i/trace.jsonl`;
  - task id: `task_mr4he6sq5yvcsfsq`;
  - child run: `run_mr4he6ssn6cqo4mq`;
  - child agent: `dynamic_background-fixture-inspector`;
  - `task_create` returned `mode:"awaited"` / `awaited:true`;
  - model used concrete `task(action:"wait", taskId:"task_mr4he6sq5yvcsfsq")`;
  - `subagent.completed` had `entrypoint:"agent_task"` and
    `finality:"complete"`;
  - `run.notification.injected` fired once;
  - `tasks output` returned one `agent.completed` chunk containing
    `BG_AGENT_CURRENT_SENTINEL`;
  - `trace summary`: 2 runs, 8 tool calls, 0 tool failures, 0 workspace writes,
    1 auto-approved `task_create` approval;
  - `trace verify`: ok; `session check`: ok.

## Non-Invariants Observed

- The manual prompt asked for `task wait` and then `task output`; mini stopped
  after `task wait`. This is not a product failure because the wait result
  already included the completed task record and final child message. Use CLI
  `tasks output` or a stricter scripted model when specifically testing output
  retrieval.
- Exact model step count and repeated `tool_search` calls are prompt/model
  sensitive. This run made three `tool_search` calls before `task_create`, but
  the final task and trace invariants were healthy.
- Missing pricing is local config metadata, not provider connectivity failure.

## Findings

- Failure pattern:
  [../failures/trace-background-agent-low-progress.md](../failures/trace-background-agent-low-progress.md)
- Cause bucket: `product_bug` in trace diagnostics only.
- Symptom: The successful manual background-agent trace had `trace verify` ok,
  `session check` ok, no tool failures, terminal child finality, and durable
  task output, but `trace report` returned `passed_with_issues` with medium
  `LOW_NET_PROGRESS`.
- Root cause check: filtering the same trace to the parent run only produced
  `trace report` verdict `ok` with 5 model calls / 5 tool calls; filtering to
  the child run only produced `ok` with 3 model calls / 3 tool calls. The
  combined report crossed the threshold at 8 model calls / 8 tool calls.
- Owner layer: `@sparkwright/core` trace diagnostics.

## Fix Verification

- Source fix owner: `@sparkwright/core` trace diagnostics.
- Change: `LOW_NET_PROGRESS` inputs are now built per `runId`; thresholds in
  `run-health.ts` stay unchanged, and multi-run findings include run/agent
  scope.
- Focused regressions passed:
  - parent 5 calls + child 3 calls no longer reports `LOW_NET_PROGRESS`;
  - child run independently crossing the threshold still reports with child
    run/agent evidence;
  - existing single-run low-progress, paginated-read, and delayed-verification
    tests continue to pass.
- Commands:
  - `npm --workspace @sparkwright/core test -- test/trace.test.ts -t "low net progress|sequential paginated|delayed verification"`
  - `npm --workspace @sparkwright/core test -- test/trace.test.ts`
  - `npm --workspace @sparkwright/core run typecheck`
  - `npm run build --workspace @sparkwright/core`
  - `npm run check:dist-fresh`
- Real trace replay:
  - `/tmp/sparkwright-real-mini-bg-current.9hEJTL/.sparkwright/sessions/session_mr4hdu7zh7hdjb8i/trace.jsonl`
  - post-fix `trace report`: `ok`, findings none.

## Coverage Update

- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: Added current-source real mini evidence for awaited background
  `agent` task completion, notification injection, durable output, and clean
  trace/session structure after the actor-inbox/task-notification changes.
- Page: [../coverage/skills.md](../coverage/skills.md)
- Change: Added current-source real mini evidence that Skill create/update
  still use proposal-first managed mutations, with no shell bypass or direct
  workspace writes.
- Page: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Change: Added and fixed the diagnostic-noise pattern for `LOW_NET_PROGRESS`
  on successful read-only background-agent workflows.

## Follow-Up

- Consider a future aggregate-level stuck-pattern diagnostic for repeated
  parent `spawn_agent` / `task_create` loops with failed or incomplete children.
  Keep it separate from run-scoped `LOW_NET_PROGRESS` so independent child
  review work is not misclassified.

## Follow-Up Pass: Sub-Agent Failure Hunt

- Direction: Continue real mini QA with sub-agents focused on trace/report
  counterexamples, background task/resume behavior, and Skill usage/evolution.
- Result: `partial_then_fixed`
- Sub-agent findings:
  - trace/report: `LOW_NET_PROGRESS` was fixed, but
    `REPEATED_TOOL_REQUESTS` still aggregated identical reads across parent and
    child runs;
  - tasks: resumed model-side `task(action:"list")` saw only current-run tasks,
    while direct ids still worked; real mini also naturally batched two
    background `agent` tasks and hit the default active `agent=1` cap;
  - skills: runtime behavior was healthy, but
    `REAL_SKILL_UPDATE_PROPOSAL` could fail because the prompt said
    `list_skills` was optional while the assertion required it.

### Follow-Up Fixes

- `@sparkwright/core` trace diagnostics:
  - `REPEATED_TOOL_REQUESTS` now thresholds per run, matching the earlier
    `LOW_NET_PROGRESS` fix;
  - regression coverage: parent/child identical reads no longer combine, while
    one child run repeating the same request still reports with run/agent
    evidence;
  - real replay:
    `/tmp/sparkwright-real-mini-spawn-read-repeat.FKfRMP/.sparkwright/sessions/session_mr4teseeiusb206j/trace.jsonl`
    now reports `ok`.
- `@sparkwright/agent-runtime` task tools:
  - `task(action:"list")` / `task_list` now accept `scope:"all"` and default to
    `scope:"run"`;
  - `task_create` description now discloses active concurrency limits including
    default `agent=1`;
  - deterministic coverage verifies current-run default, all-task listing, bad
    scope validation, and concurrency description.
- Real Skill regression:
  - update prompt now requires `list_skills` exactly once before
    `update_skill` exactly once.

### Follow-Up Evidence

- Core trace tests:
  - `npm --workspace @sparkwright/core test -- test/trace.test.ts -t "repeated tool requests|low net progress"`: 6 passed;
  - `npm --workspace @sparkwright/core test -- test/trace.test.ts`: 121 passed;
  - `npm --workspace @sparkwright/core run typecheck`: passed.
- Task tests:
  - `npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts`: 60 passed;
  - `npm --workspace @sparkwright/agent-runtime run typecheck`: passed;
  - host focused task/protocol gates: passed.
- Build/dist:
  - `npm run build --workspace @sparkwright/core`;
  - `npm run build --workspace @sparkwright/agent-runtime`;
  - `npm run build --workspace @sparkwright/host`;
  - `npm run build --workspace @sparkwright/cli`;
  - `npm run check:dist-fresh`: fresh for 26 built workspaces.
- Real Skill regression rerun:
  - temp root:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-cOF4Jy`;
  - `REAL_SKILL_UPDATE_PROPOSAL`: passed with tools
    `tool_search,list_skills,update_skill`;
  - update trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-cOF4Jy/real-update/.sparkwright/sessions/session_mr4txmdajlou2piq/trace.jsonl`.
- Real task resume canary:
  - workspace:
    `/tmp/sparkwright-real-mini-task-scope.FUyGeX`;
  - session/trace:
    `/tmp/sparkwright-real-mini-task-scope.FUyGeX/.sparkwright/sessions/session_task_scope_qa/trace.jsonl`;
  - initial awaited agent task: `task_mr4tyr00d2njwhc5`;
  - resumed run used
    `task(action:"list", scope:"all", kind:"agent", status:"completed")`,
    answered with `OLD_TASK_VISIBLE_SENTINEL task_mr4tyr00d2njwhc5
    TASK_SCOPE_SENTINEL_ALPHA`, and passed trace report/verify/session check.

### Follow-Up Failure Patterns

- [../failures/trace-cross-run-repeated-tool-requests.md](../failures/trace-cross-run-repeated-tool-requests.md)
- [../failures/task-list-resume-run-scope.md](../failures/task-list-resume-run-scope.md)
- [../failures/real-skill-regression-list-skills-prompt.md](../failures/real-skill-regression-list-skills-prompt.md)
