# 2026-07-03 Real Mini Skill Background Agent MaxSteps

## Summary

- Scenario: Current-source QA for recently implemented Skill, agent, and
  background-task behavior using real `openai/gpt-5.4-mini`.
- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/skills.md](../coverage/skills.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md).
- Result: `partial`
- Reusable lesson: Skill create/update and agent delegation regressions passed.
  A combined project Skill + awaited background `agent` task can pass cleanly,
  but real mini may underallocate `payload.maxSteps` as `1` when the prompt does
  not constrain it, producing a completed durable task with partial child
  finality and a high `SUBAGENT_INCOMPLETE` trace report.

## Test Setup

- Task direction: Hunt issues in recently implemented behavior, especially
  Skill, agent, and background/backstage task paths.
- Prompt shape: `strong` for real model canaries; focused deterministic gates
  for source contracts.
- Model class: real provider/model `openai/gpt-5.4-mini`.
- Capabilities: default host catalog with project Skill loading,
  `create_skill` / `update_skill`, `create_agent`, indexed `delegate_agent`,
  `task_create(kind:"agent")`, deferred `task`, workspace read tools, governed
  write/shell tools, and `tool_search`.
- Permission/approval posture:
  - real Skill and agent regression scripts used their temporary write-enabled
    fixtures;
  - manual background-agent fixture used `--access-mode ask --yes`;
  - deterministic package tests used local test harness policies.
- Workspace/config isolation: real write-capable regressions used script temp
  roots under `/var/folders/...`; manual fixture used
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R`.
- Trace level: `debug` for real CLI runs.
- Environment notes: `npm run check:dist-fresh` reported fresh dist for 26
  workspaces. `capabilities inspect --model openai/gpt-5.4-mini` resolved the
  model from local config, with pricing unavailable due to missing local
  pricing metadata.

## Commands Or Harness

```bash
npm run check:dist-fresh
npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
npm --workspace @sparkwright/host test -- test/task-revival.test.ts test/spawn-agent.test.ts test/skill-usage.test.ts test/skill-evolution.test.ts
npm --workspace @sparkwright/core test -- test/trace.test.ts -t "low net progress|repeated tool requests|subagent|background|recovered"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect|skills review|skill proposals|agents"
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-agents
node packages/cli/dist/index.js run "<skill_load + awaited task_create(kind:agent) prompt>" --workspace /var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R --model openai/gpt-5.4-mini --access-mode ask --yes --trace-level debug
node packages/cli/dist/index.js run "<same prompt with payload.maxSteps 4>" --workspace /var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R --model openai/gpt-5.4-mini --access-mode ask --yes --trace-level debug
```

## Stable Evidence

- Build/dist:
  - `npm run check:dist-fresh`: fresh for 26 built workspaces.
- Deterministic gates passed:
  - agent-runtime task tests: 60 passed;
  - host task revival, spawn agent, Skill usage/evolution: 26 passed;
  - core trace diagnostic slice: 13 passed;
  - CLI capability/Skill/agent slice: 9 passed.
- Skill real regression:
  - temp root:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-5JKqUQ`;
  - static disabled-shell capability inspection preserved
    `list_skills`, `create_skill`, and `update_skill`;
  - bash managed-package guard denied direct `.sparkwright/skills` mutation;
  - create trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-5JKqUQ/real-create/.sparkwright/sessions/session_mr53n692doxwtg0g/trace.jsonl`;
  - create evidence: `tool_search,create_skill`; one draft proposal
    `skillprop_mr53nji17mklrqvr`; 6 capability mutations; 0 workspace writes;
  - update trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-5JKqUQ/real-update/.sparkwright/sessions/session_mr53nn5yd5km7cm2/trace.jsonl`;
  - update evidence: `tool_search,skill_load,list_skills,update_skill`; one
    draft proposal `skillprop_mr53nzt2x8xsknod`; 6 capability mutations; 0
    workspace writes; trace verify ok.
- Agent real regression:
  - temp root:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-Ou7Wgx`;
  - create trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-Ou7Wgx/workspace/.sparkwright/sessions/session_mr53otnyy05i2erv/trace.jsonl`;
  - delegate trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-Ou7Wgx/workspace/.sparkwright/sessions/session_mr53p43ivwe8wn5i/trace.jsonl`;
  - delegate evidence: tools `tool_search,delegate_agent,read`; agents
    `main,mini_reviewer`; subagent `mini_reviewer`; trace report/verify/session
    check all ok.
- Manual Skill + background agent A/B:
  - fixture:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R`;
  - underallocated trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R/.sparkwright/sessions/session_mr53qydnkntb0wpg/trace.jsonl`;
  - underallocated task: `task_mr53reaifbkeyl4s`;
  - underallocated evidence: `skill_load` succeeded, `task_create` returned
    `mode:"awaited"`, model waited on concrete task id, `run.notification.injected`
    fired once, durable task output contained `BG_SKILL_AGENT_SENTINEL` and
    `BG_SKILL_DOC_SENTINEL`, trace verify/session check ok, but trace report
    failed with high `SUBAGENT_INCOMPLETE` because the child was
    `stepLimitReached:true` / `finality:"partial"`;
  - control trace with explicit `maxSteps:4`:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R/.sparkwright/sessions/session_mr53ubir5g330vbi/trace.jsonl`;
  - control evidence: `subagent.completed` had `terminalState:"completed"` and
    `finality:"complete"`; trace report/verify/session check all ok; 0
    workspace writes.

## Non-Invariants Observed

- The real Skill update run made an extra `skill_load` call before
  `list_skills` / `update_skill`. This was allowed and did not bypass proposal
  governance.
- The first manual background-agent run made an extra `tool_search` before
  task creation. Exact tool-search count is model-sensitive.
- Real mini chose `payload.maxSteps:1` without being asked. This is a
  prompt/model allocation risk, not evidence that task revival, durable output,
  or Skill loading is broken.
- Pricing remained unavailable because local model pricing is not configured.

## Failures

- Failure pattern:
  [../failures/task-create-agent-maxsteps-underallocation.md](../failures/task-create-agent-maxsteps-underallocation.md)
- Cause bucket: `prompt_underspecified` / `model_variance`
- Count update: new watch pattern, count 1.

## Coverage Update

- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: Added current-source real mini evidence for a combined project Skill
  load plus awaited background `agent` task, including a passing `maxSteps:4`
  control and a prompt-sensitive underallocation failure with `maxSteps:1`.

## Follow-Up

- Fixed on 2026-07-04 by updating the main and nested
  `task_create(kind:"agent")` payload schema/description for `maxSteps`,
  matching `spawn_agent` budget guidance.
- Source/tests:
  - `packages/host/src/tool-catalog.ts`
  - `packages/host/src/runtime.ts`
  - `packages/host/test/tools.test.ts`
  - `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "main host tool catalog"`
  - `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/task-revival.test.ts`
  - `npm --workspace @sparkwright/host run typecheck`
  - `npm run build --workspace @sparkwright/host`
  - `npm run check:dist-fresh`
- Post-fix real mini rerun:
  - trace:
    `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R/.sparkwright/sessions/session_mr55i1fn5symfckr/trace.jsonl`
  - task: `task_mr55i8ajkeqxo6df`
  - evidence: mini selected `payload.maxSteps:4`, child completed with
    `finality:"complete"` / `stepLimitReached:false`, durable output contained
    both sentinels, and trace report/verify/session check were all ok.
  - non-invariant: mini used `task(action:"list", scope:"run")` instead of the
    prompted `task(action:"wait")`; because task output/finality and diagnostics
    were clean, this remains a model-monitoring route variance rather than a
    recurrence of maxSteps underallocation.
