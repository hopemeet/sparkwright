# 2026-06-23 Agents Delegates Follow-Up

## Summary

- Scenario: Continue QA on agents/delegates entrypoint parity, direct external
  delegate runs, configured delegate parent verification, and external write
  boundaries.
- Coverage: `delegates run`, external-command delegates, configured
  in-process delegates, parent read-after-child-write verification,
  `maxDepth`, expected denials, and untracked write-capable boundaries.
- Result: `pass`
- Reusable lesson: The direct external-command delegate path and run-loop
  configured delegate path both preserve trace/session integrity, but they
  expose different safety evidence. Real-model configured delegates can add
  recovered repeated-tool noise even when the functional invariant passes.

## Test Setup

- Task direction: Test agents/delegates areas that remained only partially
  covered.
- Prompt shape: `scripted` for deterministic configured delegate verification;
  `strong` for real configured delegate canary; command-driven for direct
  external delegates.
- Prompt: External delegate direct commands used fixed local Node fixtures;
  configured delegate prompts required a child write and parent `read_file`
  verification after child completion.
- Model class: scripted, command-only external process, and real provider/model
  `openai/gpt-5.4-nano`.
- Capabilities: agents/delegate tools, read_file, apply_patch, external command
  delegates, trace/session diagnostics.
- Permission/approval posture: temporary workspaces; write scenarios used
  `--write --yes`; no-write boundary scenario intentionally omitted `--write`.
- Workspace/config isolation: all fixtures used `/tmp` roots with
  project-local `.sparkwright/config.json`.
- Trace level: `debug`.
- Environment notes: tracked worktree was clean before this pass.

## Commands Or Harness

```bash
node packages/cli/dist/index.js delegates run delegate_external_cli_fixture --goal "inspect direct delegate" --workspace "$tmp" --yes --session-id delegate-direct-qa --trace-level debug --format json
node packages/cli/dist/index.js delegates run delegate_external_cli_fixture --goal "should be blocked" --workspace "$tmp" --yes --session-id delegate-depth-qa --trace-level debug --format json
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "Delegate a README patch, then verify README after the delegate returns." --workspace "$tmp" --model scripted --write --yes --trace-level debug
node packages/cli/dist/index.js run "<real delegate writer prompt>" --workspace "$tmp" --model openai/gpt-5.4-nano --write --yes --trace-level debug
node packages/cli/dist/index.js delegates run delegate_external_writer --goal "write external marker" --workspace "$tmp" --write --yes --session-id delegate-external-write-qa --trace-level debug --format json
node packages/cli/dist/index.js delegates run delegate_external_writer --goal "write external marker" --workspace "$tmp" --yes --session-id delegate-external-nowrite-qa --trace-level debug --format json
npm --workspace @sparkwright/host test -- test/external-command-agent.test.ts test/acp-child-agent.test.ts test/protocol.test.ts -t "delegate|subagent|external command"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegates run|delegate"
npm --workspace @sparkwright/core test -- test/trace.test.ts -t "subagent|delegate|expected denial"
```

## Stable Evidence

- Direct external-command delegate passed at
  `/tmp/sparkwright-delegate-direct.00ZYQi/.sparkwright/sessions/delegate-direct-qa/trace.jsonl`:
  approval requested/resolved, subagent started/completed, trace verify `ok`,
  session check `ok`, and external argv matched the templated goal.
- Direct external-command `maxDepth: 0` blocked before process execution at
  `/tmp/sparkwright-delegate-depth.uJlf1y/.sparkwright/sessions/delegate-depth-qa/trace.jsonl`;
  no marker file was written, `run.failed` was terminal, trace verify `ok`, and
  trace report classified the runtime error.
- Scripted configured delegate verification passed at
  `/tmp/sparkwright-delegate-verify.uWqcAJ/.sparkwright/sessions/session_mqq4vbqaus2pqb48/trace.jsonl`:
  child wrote README once, `subagent.completed.workspaceWrites=1`, parent
  `read_file` occurred after `subagent.completed`, trace report `ok`, trace
  verify `ok`, and session check `ok`.
- Real `openai/gpt-5.4-nano` configured delegate canary passed functionally at
  `/tmp/sparkwright-real-delegate-verify.2SNLVd/.sparkwright/sessions/session_mqq4w7zryhq1t3um/trace.jsonl`:
  one `delegate_writer` call, one child workspace write, parent `read_file`
  after child completion, final `real-delegate-ok`, trace verify `ok`, and
  session check `ok`.
- External-command `workspaceAccess: read_write` with `--write` wrote
  `external-direct.txt` directly and produced
  `workspace.write.untracked_access_granted`; trace summary reported 1
  untracked write-capable boundary and 0 managed workspace writes.
- The same external write-capable delegate without `--write` failed before the
  external command ran; summary counted
  `DELEGATE_WORKSPACE_ACCESS_DENIED` as expected denials and the marker file was
  absent.
- Focused gates passed: host external/acp/protocol delegate subset, CLI
  delegate subset, and core trace subagent/expected-denial subset.

## Non-Invariants Observed

- Real configured delegate child repeated an identical `apply_patch`; runtime
  skipped it as `REPEATED_TOOL_CALL_SKIPPED`, and trace report returned
  `passed_with_issues` with `LOW_NET_PROGRESS` and recovered tool failure
  findings. This did not break the write/parent-verification invariant.
- Direct external delegates with default `workspaceAccess: none` run from an
  isolated temporary cwd rather than the project root.
- Expected safety denials such as `DELEGATE_WORKSPACE_ACCESS_DENIED` can leave a
  terminal `run.failed` while trace report remains `ok` because the failure is
  classified as expected denial.

## Failures

- Failure pattern: none added.
- Cause bucket: n/a
- Count update: none.

## Coverage Update

- Page: `coverage/agents.md`
- Change: Added direct external-command delegate, `maxDepth`, configured
  delegate parent verification, real configured delegate canary, and external
  write-boundary evidence.

## Follow-Up

- Add a stable regression if real-model repeated `apply_patch` becomes common
  enough to raise cost or latency concerns.
- Keep treating dynamic `spawn_agent` child writes as unsupported; use
  configured delegates for child-write scenarios.
