# 2026-06-28 Access Mode Real Mini QA Partial

## Summary

- Scenario: broad post-update QA for access mode, Skill/agent capability
  canaries, CLI trace/session evidence, and TUI PTY behavior.
- Coverage: access-mode runtime semantics, Skill evolution real canary,
  indexed agent delegation, TUI capabilities panel.
- Result: `partial`
- Reusable lesson: deterministic gates passed, but real mini exposed one
  product bug in read-only approval semantics and two stale real-regression
  script contracts.

## Test Setup

- Task direction: use a configured mini model in realistic CLI/TUI flows after
  recent capability updates.
- Prompt shape: `strong` for CLI read/write and regression canaries; scripted
  for the shell managed-package guard; PTY scripted input for TUI.
- Prompt: repo read-only inspection, temp README edit, Skill create/update,
  agent create/delegate, TUI read-only inspect, TUI `/capabilities`.
- Model class: real provider/model `openai/gpt-5.4-mini`; scripted model for
  the shell guard inside the Skill regression.
- Capabilities: default repo tools; Skill create/update; agent
  `create_agent`/`delegate_agent`; no configured MCP servers in the repo
  capability snapshot.
- Permission/approval posture: `read-only`, `ask`, and `accept-edits`; temp
  fixture writes only.
- Workspace/config isolation: current repo read-only; write tests used
  `/var/folders/.../sparkwright-mini-write-*` and preserved real regression
  temp roots with `SPARKWRIGHT_KEEP_REAL_REGRESSION=1`.
- Trace level: `debug`.
- Environment notes: user config resolved `openai/gpt-5.4-mini` via grouped
  YAML identity config; cost was unavailable due `missing_pricing`.

## Commands Or Harness

```bash
npm run build --workspace @sparkwright/core
npm run build --workspace @sparkwright/protocol
npm run build --workspace @sparkwright/skills
npm run build --workspace @sparkwright/agent-runtime
npm run build --workspace @sparkwright/host
npm run build --workspace @sparkwright/cli
npm run build --workspace @sparkwright/tui
npm --workspace @sparkwright/core test -- test/access-mode.test.ts test/trace.test.ts test/workflow-hooks.test.ts
npm --workspace @sparkwright/host test -- test/run-access.test.ts test/config.test.ts test/client-run.test.ts test/protocol.test.ts test/tools.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts test/event-format.test.ts
npm --workspace @sparkwright/tui test -- test/permission.test.ts test/config.test.ts test/startup-validation.test.ts test/capabilities-panel-render.test.tsx test/tool-request-preview.test.ts
npm run schema:check
npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts
npm --workspace @sparkwright/tui test -- test/approval-prompt-render.test.tsx test/sdk-cutover.test.ts -t "approval|permission|explicit model|read-only|bypass"
npm --workspace @sparkwright/cli test -- test/cli-approval.test.ts test/run-outcome-consistency.test.ts test/entry-parity.test.ts
npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts test/spawn-agent.test.ts test/external-command-agent.test.ts test/skill-evolution.test.ts
node packages/cli/dist/index.js capabilities inspect --workspace . --format text
node packages/cli/dist/index.js run "<repo read-only prompt>" --workspace . --model openai/gpt-5.4-mini --access-mode read-only --trace-level debug
node packages/cli/dist/index.js run "<repo read-only prompt>" --workspace . --model openai/gpt-5.4-mini --access-mode ask --trace-level debug
node packages/cli/dist/index.js run "<temp README edit prompt>" --workspace <tmp> --target README.md --model openai/gpt-5.4-mini --access-mode accept-edits --trace-level debug
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-agents
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cmd "node packages/cli/dist/index.js tui --workspace . --model openai/gpt-5.4-mini --access-mode read-only --trace-level debug" ...
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cmd "node packages/cli/dist/index.js tui --workspace . --model openai/gpt-5.4-mini --access-mode ask --trace-level debug" ...
```

## Stable Evidence

- Focused deterministic gates passed: core 119 tests, host 192 + 73 tests,
  CLI 135 + 14 tests, TUI 23 + 7 tests, agent-runtime 36 tests, schema check
  validated 22 schemas and 15 instances.
- CLI read-only failure trace:
  `.sparkwright/sessions/session_mqxohkzakol3mfvq/trace.jsonl`.
  Summary showed 8 approvals requested/denied for `read_file`/`glob`, 0
  workspace reads, and approval events with `risk:"safe"` plus
  `reason:"Plan mode requires approval."`
- CLI ask-mode control trace:
  `.sparkwright/sessions/session_mqxoia5cwy7ns19g/trace.jsonl`.
  Summary showed 2 completed `read_file` calls, 0 approvals, 0 writes, and
  passing trace verify/session check.
- Accept-edits temp write trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-write-z5cs2G/.sparkwright/sessions/session_mqxoj59g1achcrqj/trace.jsonl`.
  Summary showed one `workspace.write.completed`, no approvals, and passing
  trace verify/session check.
- Skill regression kept root:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-yLLGAw`.
  `REAL_SKILL_CREATE` failed the script, but trace
  `session_mqxol797829pf4sw` showed `create_skill` completed as
  `action:"draft"` with proposal `skillprop_mqxolbqn9nfxfnbg` and six
  `capability.mutation.completed` events.
- Agent regression kept root:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-f8EbPy`.
  `REAL_AGENT_DELEGATE` failed the script, but trace
  `session_mqxomfknxds9pxw3` passed trace verify/session check with
  `delegate_agent(agentId:"mini_reviewer")`, `agentIds=main,mini_reviewer`,
  and `subagentIds=mini_reviewer`.
- TUI read-only PTY session `session_tui_mqxonnzw` displayed an approval prompt
  for `read_file` with `risk:safe` and `reason: Plan mode requires approval.`
- TUI `/capabilities` PTY session `session_tui_mqxoom27` rendered the
  capabilities panel at 100 columns with no raw JSON or obvious overlap.

## Non-Invariants Observed

- Mini may use extra parent reads before delegation; do not assert exact tool
  order unless the prompt and canary require it.
- Current `create_skill` is proposal-first; no direct Skill package write is an
  expected product behavior for that surface.
- TUI trace verify failed for `session_tui_mqxonnzw` only because the PTY script
  interrupted a blocked run with Ctrl-C before a terminal event.

## Failures

- Failure pattern: [access-mode-read-only-safe-read-approval.md](../failures/access-mode-read-only-safe-read-approval.md)
- Cause bucket: `product_bug`
- Count update: new count 2, from CLI read-only and TUI read-only reproductions.
- Failure pattern: [real-regression-stale-capability-semantics.md](../failures/real-regression-stale-capability-semantics.md)
- Cause bucket: `test_bug`
- Count update: new count 2, from stale Skill create and agent delegate canary
  assertions.

## Coverage Update

- Page: [../coverage/skills.md](../coverage/skills.md)
- Change: note current `create_skill` proposal-first behavior and stale real
  regression assertion.
- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: note real mini indexed delegation passed runtime evidence while the
  direct-alias regression assertion is stale.
- Page: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Change: note TUI read-only safe-read approval prompt as a runtime/access
  semantics issue visible in UI.

## Follow-Up

- Fix plan-mode/read-only approval semantics so safe read tools run without
  approval while writes and risky side effects remain blocked.
- Update real Skill and agent regression scripts to assert proposal-first Skill
  create and indexed `delegate_agent` by default.
- Add focused deterministic tests for read-only safe reads across host/CLI/TUI
  permission projection.
