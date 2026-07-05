# 2026-06-23 Broad Real CLI TUI Partial

## Summary

- Scenario: Broad follow-up QA for session/trace, agents, shell, MCP, TUI, and
  Skill evolution after identifying weak coverage areas.
- Coverage: shell, trace diagnostics, agents/delegates, MCP/ACP, TUI rendering,
  session/compaction, Skill evolution.
- Result: `partial`
- Reusable lesson: Focused gates were healthy, but real-model shell argument
  variance exposed a trace terminality gap that `trace verify` caught and
  `trace report` missed.

## Test Setup

- Task direction: Start testing the weak areas called out by the test map.
- Prompt shape: `scripted` for focused gates and regression matrix; `strong`
  for real-model CLI/TUI canaries.
- Prompt: Real canaries covered read-only file inspection, dynamic
  `spawn_agent`, MCP lazy/positive calls, promoted-shell attempts, and TUI
  read-only rendering.
- Model class: deterministic/scripted gates plus real provider/model
  `openai/gpt-5.4-nano`.
- Capabilities: read/write file tools, shell, task, dynamic `spawn_agent`,
  MCP stdio tools, ACP, TUI, skills.
- Permission/approval posture: read-only by default; shell/write tests used
  temporary workspaces and explicit `--write --yes`.
- Workspace/config isolation: write and MCP/TUI scenarios used `/tmp`
  fixtures; repo workspace stayed clean.
- Trace level: `debug` for real CLI/TUI canaries.
- Environment notes: user config uses grouped `identity.model` and
  `identity.providers`; `scripts/regression-real-model.mjs` did not recognize
  that grouped provider config. Manual CLI runs used the configured model
  successfully.

## Commands Or Harness

```bash
npm run build
npm run check:dist-fresh
npm --workspace @sparkwright/core test -- test/session-compact.test.ts test/trace.test.ts
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/external-command-agent.test.ts test/acp-child-agent.test.ts
npm --workspace @sparkwright/shell-tool test
npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts
npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts test/event-stream-render.test.ts test/status-bar-render.test.tsx test/capabilities-panel-render.test.tsx test/approval-prompt-render.test.tsx
npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts test/run-outcome-consistency.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace|session|capabilities inspect|MCP|mcp|shell"
npm --workspace @sparkwright/acp-adapter test -- test/round-trip.test.ts test/event.test.ts test/session-root.test.ts
npm run regression:matrix
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano npm run regression:real-model
node packages/cli/dist/index.js run "<real read-only smoke>" --workspace . --session-root "$tmp" --model openai/gpt-5.4-nano --trace-level debug
node packages/cli/dist/index.js run "<real spawn_agent smoke>" --workspace . --session-root "$tmp" --model openai/gpt-5.4-nano --trace-level debug
node packages/cli/dist/index.js run "<real MCP lazy/positive prompts>" --workspace "$tmp" --model openai/gpt-5.4-nano --trace-level debug
node packages/cli/dist/index.js run "<real promoted-shell prompts>" --workspace "$tmp" --model openai/gpt-5.4-nano --write --yes --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ...
npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts test/capability-package-mutation.test.ts test/skill-inline-shell.test.ts
npm --workspace @sparkwright/skills test
```

## Stable Evidence

- Focused gates passed across core, host agents, shell-tool, MCP adapter, TUI
  render/SDK, CLI outcome/trace/session/capabilities/MCP/shell, ACP adapter,
  regression matrix, host Skill evolution, capability mutation, inline shell,
  and skills package tests.
- `npm run build` passed after an initial stale-dist finding, and
  `npm run check:dist-fresh` then reported fresh output for 26 workspaces.
- Real read-only smoke trace:
  `/tmp/sparkwright-real-smoke.71Jyrb/session_mqpzo6a1w7ipt68g/trace.jsonl`.
  Summary/report/verify/session check were all `ok`; 2 `read_file` calls,
  no approvals, no writes.
- Real dynamic spawn trace:
  `/tmp/sparkwright-real-spawn.BRDQkJ/session_mqpzo69yqvc1xf6h/trace.jsonl`.
  Summary/report/verify/session check were all `ok`; 2 runs, 1
  `spawn_agent`, 2 `read_file`, no writes.
- Manual real MCP idle and positive traces were `ok`. Idle did not start the
  MCP server or marker; positive emitted `mcp.server.prepared`, called
  `mcp_qa_list_tools` and `mcp_qa_call_tool`, and wrote only the server marker
  in the temporary fixture.
- TUI `/capabilities` PTY capture showed one static header, no raw JSON, and
  the active `openai/gpt-5.4-nano` model. TUI read-only run trace
  `/tmp/sparkwright-tui-real-read.r3tLsT/.sparkwright/sessions/session_tui_mqpzsq1x/trace.jsonl`
  passed summary/report/verify/session check.

## Non-Invariants Observed

- `npm run regression:real-model` skipped for both default
  `anthropic/claude-sonnet-4-6` and `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano`
  because the script looked for provider config outside grouped
  `identity.providers`.
- The manual MCP fixture copied the script's legacy
  `capabilities.tools.disabled` shape and produced a config warning; behavior
  still passed, but the fixture should use top-level `tools.disabled`.
- A real model may add `foregroundTimeoutMs`/`timeoutMs` arguments even when the
  prompt tries to rely on project shell config.

## Failures

- Failure pattern: `shell-invalid-args-terminality`
- Cause bucket: `product_bug`
- Count update: new count 1.

## Coverage Update

- Page: `coverage/shell.md`, `coverage/trace-diagnostics.md`
- Change: Added the invalid shell argument terminality gap and linked the new
  failure pattern. Agents, MCP, TUI, and Skill evolution confidence improved
  through fresh focused/real evidence but remain `Partially Verified` because
  release-level and real-model write flows were not exhaustively covered.

## Follow-Up

- Fix tool input normalization failures so they emit `tool.failed` and terminal
  `run.failed` trace events.
- Make `trace report` flag terminality errors already caught by `trace verify`.
- Update `scripts/regression-real-model.mjs` to read grouped
  `identity.providers` and modern top-level `tools.disabled`.
