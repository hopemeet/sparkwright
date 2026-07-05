# 2026-06-22 Historical Failures Pass

## Summary

- Scenario: Re-check previously recorded shell, trace diagnostics, agents, and
  TUI rendering failure patterns on `fix/promoted-shell-no-rollback`.
- Coverage: shell cwd/dist skew, promoted shell task writes, trace subagent
  finality, TUI static header ownership, deterministic CLI trace integrity.
- Result: `pass`
- Reusable lesson: After shell-tool source changes, rebuild exported `dist`
  before host/CLI checks; combine focused source tests with one real CLI trace
  diagnostic pass before calling a fix healthy.

## Test Setup

- Task direction: Verify whether previously recorded issues still exist, with
  trace diagnostics checked in addition to feature behavior.
- Prompt shape: `scripted`
- Prompt: Deterministic CLI smoke asked to inspect `package.json` and
  `README.md` without modifying files.
- Model class: `deterministic`
- Capabilities: read-only CLI direct-core smoke; shell, host, agent, trace, and
  TUI focused gates.
- Permission/approval posture: read-only; no workspace write approvals.
- Workspace/config isolation: CLI trace used a temporary `/tmp` session root;
  TUI PTY first-screen capture used the repo workspace and no submitted run.
- Trace level: `debug` for CLI smoke.
- Environment notes: macOS local checkout; branch
  `fix/promoted-shell-no-rollback`; full `npm run build` passed before CLI
  `dist` diagnostics.

## Commands Or Harness

```bash
npm --workspace @sparkwright/shell-tool test
npm --workspace @sparkwright/shell-tool run build
npm --workspace @sparkwright/host test -- test/tools.test.ts
npm --workspace @sparkwright/host test -- test/config.test.ts
npm run schema:check
npm --workspace @sparkwright/core test -- test/trace.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts
npm --workspace @sparkwright/tui test -- test/status-bar-render.test.tsx test/event-stream-render.test.ts
npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts
npm --workspace @sparkwright/host test -- test/external-command-agent.test.ts
npm run build
npm run check:dist-fresh
SPARKWRIGHT_ENABLE_DIRECT_CORE=1 node packages/cli/dist/index.js run --direct-core "Inspect package.json and README.md, then answer with one sentence about what SparkWright does. Do not modify files." --workspace . --session-root "$tmp" --target package.json --model deterministic --trace-level debug
node packages/cli/dist/index.js trace summary "$trace" --format text
node packages/cli/dist/index.js trace timeline "$trace" --format text
node packages/cli/dist/index.js trace report "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
node packages/cli/dist/index.js session check "$session" --workspace . --session-root "$tmp" --format text
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cwd /Applications/xgw/projects/AI-native/SparkWright --rows 24 --cols 100 --cmd 'node packages/cli/dist/index.js tui --workspace /Applications/xgw/projects/AI-native/SparkWright --trace-level debug' --script '[[1.0,"__DUMP__"],[0.2,"\u0003"]]'
```

## Stable Evidence

- Shell-tool, host shell, config/schema, agent-runtime, spawn-agent, external
  command agent, core trace, CLI trace/config/run-outcome, and TUI render tests
  all passed.
- `npm run build` passed, and `npm run check:dist-fresh` reported fresh output
  for 26 built workspaces.
- Deterministic CLI trace:
  `/tmp/sparkwright-trace-smoke.wrOuV9/session_mqpd3dlpvb0f9v74/trace.jsonl`.
- CLI trace summary reported 25 events, 1 read-only tool call, 0 errors,
  0 tool failures, 0 approvals, and 0 workspace writes.
- `trace verify`, `trace report`, and `session check` reported `ok` / no
  findings for the deterministic smoke trace.
- PTY first screen showed one committed `SparkWright` header and no repeated
  brand text in the live status/input area.

## Non-Invariants Observed

- The deterministic smoke did not exercise real provider prose, real model tool
  choice, or live subagent writes.
- TUI PTY capture checked first-screen rendering only; it did not submit a run
  or inspect a TUI run trace.
- The smoke trace reports `cost: unavailable (usage_not_reported:2)` because
  the deterministic model does not report provider usage.

## Failures

- Failure pattern: none reproduced.
- Cause bucket: none.
- Count update: no failure counts changed.

## Coverage Update

- Page: `coverage/shell.md`, `coverage/trace-diagnostics.md`,
  `coverage/tui-rendering.md`
- Change: Replace doc-only seed evidence with fresh focused gate, build,
  `dist`, CLI trace, and PTY first-screen evidence while retaining real-provider
  and live-run residual risks.

## Follow-Up

- Use a real provider/model canary only if the target question is model route
  variance, final answer quality, or live child-agent verification behavior.
