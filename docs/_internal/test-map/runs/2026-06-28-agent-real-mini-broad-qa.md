# 2026-06-28 Agent Real Mini Broad QA

## Summary

- Scenario: Real `openai/gpt-5.4-mini` agent orchestration with a broad main
  tool surface and two configured read-only delegates.
- Coverage: dynamic `spawn_agent`, `delegate_parallel`, child read-only
  tightening, trace/session attribution, and write/approval safety evidence.
- Result: `pass`
- Reusable lesson: With a strong sequencing prompt, mini can issue
  `spawn_agent` and `delegate_parallel` in the same first tool batch even when
  the main run has write and shell tools available. The parallel child delegate
  path stayed read-only and trace-visible.

## Test Setup

- Task direction: Test agents with mini under a realistic capability posture,
  including spawn and delegation rather than only single delegate calls.
- Prompt shape: `strong`; it requested one dynamic spawn followed by one
  `delegate_parallel` call targeting `api_reviewer` and `test_reviewer`.
- Model class: real provider/model `openai/gpt-5.4-mini`.
- Capabilities: main tool selector included `workspace.read`,
  `workspace.write`, `agents`, `shell`, and `planning`; configured delegates
  were restricted to `workspace.read` with `read_file`, `grep`, `glob`, and
  `list_dir`.
- Permission/approval posture: CLI `--access-mode accept-edits --yes` in a
  temporary fixture. The prompt prohibited shell and file modification.
- Workspace/config isolation:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agent-broad-LZCcSS/workspace`.
- Trace level: `debug`.
- Environment notes: `npm run check:dist-fresh` reported fresh dist output.
  Provider pricing was unavailable with `missing_pricing`.

## Commands Or Harness

```bash
npm run check:dist-fresh
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/tools.test.ts test/protocol.test.ts -t "spawn_agent|delegate_agent|delegate_parallel|write-capable delegates|read-only configured delegates|parent approval"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegate|agents|spawn_agent|capabilities inspect|read-only access mode"
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-agents
node packages/cli/dist/index.js agents validate --workspace "$fixture" --format text
node packages/cli/dist/index.js capabilities inspect --workspace "$fixture" --model openai/gpt-5.4-mini --format text
node packages/cli/dist/index.js run "<spawn_agent then delegate_parallel prompt>" --workspace "$fixture" --model openai/gpt-5.4-mini --access-mode accept-edits --yes --trace-level debug
node packages/cli/dist/index.js trace summary "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
node packages/cli/dist/index.js session check "$session" --workspace "$fixture" --format text
```

## Stable Evidence

- Focused gates passed: host agent/delegate subset 20 tests; CLI
  agent/delegate/capability subset 12 tests.
- `regression:real-agents` passed with real mini and kept traces under
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-HA4qZy`.
  The create run had `tool_search,create_agent`, one managed workspace write,
  one capability mutation, and session check ok. The delegate run had one
  `delegate_agent` call, `subagent.completed` for `mini_reviewer`, no writes,
  and session check ok.
- Broad fixture capability inspect exposed 16 runtime tools, including
  `write_file`, `apply_patch`, `shell`, `delegate_agent`,
  `delegate_parallel`, `spawn_agent`, and `tool_search`.
- Broad real trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agent-broad-LZCcSS/workspace/.sparkwright/sessions/session_mqxum3kcix7mj32c/trace.jsonl`.
  Summary: 4 runs, agents `main`, `dynamic_context_reader`, `api_reviewer`,
  and `test_reviewer`; 9 tool calls (`spawn_agent:1`,
  `delegate_parallel:1`, `read_file:7`); 0 tool failures; 0 approvals; 0
  managed workspace writes.
- `trace verify` and `session check` were ok for
  `session_mqxum3kcix7mj32c`.
- Parent-visible subagent metadata recorded `entrypoint: "spawn_agent"` for
  `dynamic_context_reader` and `entrypoint: "delegate_parallel"` for
  `api_reviewer` and `test_reviewer`, all with the same session id.

## Non-Invariants Observed

- Real model tool-order compliance remains prompt-sensitive. This run followed
  the requested first batch, but past runs show mini may call individual
  delegates before `delegate_parallel`.
- Child runs may make their own `read_file` calls in the aggregate trace; tool
  count assertions should distinguish parent requests from child activity.

## Failures

- Failure pattern: none added.
- Cause bucket: none.
- Count update: no failure-pattern count changed.

## Coverage Update

- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: Added real mini evidence for broad main tool exposure with dynamic
  spawn plus parallel configured delegates and clean trace/session diagnostics.

## Follow-Up

- ACP live delegate transport remains outside this run.
