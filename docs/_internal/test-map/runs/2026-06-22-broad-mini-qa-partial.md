# 2026-06-22 Broad Mini QA Partial

## Summary

- Scenario: Broad sequential QA after historical failure checks: real mini
  delegate writes, approval/write safety, promoted shell, TUI slash/run/approval,
  session resume, ACP/MCP deterministic gates, and regression matrix.
- Coverage: agents/delegates, shell promotion, write approvals, TUI rendering,
  trace diagnostics, session resume, ACP/MCP convergence.
- Result: `partial`
- Reusable lesson: Feature behavior and trace structure are mostly healthy, but
  UI/outcome surfaces can disagree with runtime facts; inspect trace plus screen
  output and fixture diff together.

## Test Setup

- Task direction: Test remaining valuable areas in order and expose problems.
- Prompt shape: `strong` for real-model canaries; scripted/deterministic for
  gates.
- Model class: real provider/model `openai/gpt-5.4-mini` plus deterministic
  gates and one `session resume --llm` default-model continuation.
- Capabilities: dynamic `spawn_agent`, configured `delegate_writer`, shell,
  task, read/write file tools, TUI slash commands, ACP/MCP test harnesses.
- Permission/approval posture: read-only where possible; writes isolated to
  `/tmp/sparkwright-qa-fixture.lJIUf8`; approvals were explicitly denied or
  auto-approved depending on scenario.
- Workspace/config isolation: temporary fixture and temporary session roots.
- Trace level: `debug` for real CLI/TUI runs.
- Environment notes: `delegate_writer` was created only in the `/tmp` fixture.

## Commands Or Harness

```bash
node packages/cli/dist/index.js run "<dynamic spawn child write prompt>" --workspace /tmp/sparkwright-qa-fixture.lJIUf8 --model openai/gpt-5.4-mini --write --yes-edits --trace-level debug
node packages/cli/dist/index.js agents create writer --workspace /tmp/sparkwright-qa-fixture.lJIUf8 --allow read_file --allow write_file --delegate delegate_writer --max-steps 4 --force
node packages/cli/dist/index.js run "<delegate write then parent verify prompt>" --workspace /tmp/sparkwright-qa-fixture.lJIUf8 --model openai/gpt-5.4-mini --write --yes --trace-level debug
SPARKWRIGHT_ENABLE_DIRECT_CORE=1 node packages/cli/dist/index.js run --direct-core "deny temp write" --workspace "$tmp" --target README.md --write --model deterministic --trace-level debug
SPARKWRIGHT_ENABLE_DIRECT_CORE=1 node packages/cli/dist/index.js run --direct-core "approve temp write" --workspace "$tmp" --target README.md --write --yes --model deterministic --trace-level debug
node packages/cli/dist/index.js run "<promoted shell prompt>" --workspace /tmp/sparkwright-qa-fixture.lJIUf8 --model openai/gpt-5.4-mini --write --yes --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ... /capabilities
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ... "Read package.json..."
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ... "Create tui-deny.txt..."
node packages/cli/dist/index.js session resume session_tui_mqpdzfvs "Answer exactly resume-ok. Do not modify files." --workspace /tmp/sparkwright-qa-fixture.lJIUf8 --session-root /tmp/sparkwright-tui-mini-run.tUwlOT --llm
npm --workspace @sparkwright/acp-adapter test -- test/round-trip.test.ts
npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts
npm --workspace @sparkwright/cli test -- test/entry-parity.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "MCP|mcp"
npm run regression:matrix
```

## Stable Evidence

- Dynamic `spawn_agent` did not write because dynamic children are read-only by
  contract. Trace/session were `ok`; the scenario should use configured
  delegates for child writes.
- Configured `delegate_writer` write succeeded with `--yes`: trace
  `/tmp/sparkwright-mini-delegate-write-yes.fUXa8Q/session_mqpdvor0o0e5iykx/trace.jsonl`.
  Parent read verified `notes.txt` after delegate write; trace/session were
  `ok`; report was `passed_with_issues` for low net progress.
- Noninteractive `delegate_writer` without `--yes` was denied and trace report
  correctly emitted high `REPEATED_APPROVAL_DENIALS`.
- Deterministic write approval denied/applied paths behaved correctly and
  `trace verify` reported `ok`.
- Promoted shell wrote `promoted-shell.txt`, task completed, parent read verified
  `mini-promoted-shell-ok`, and trace report emitted
  `UNTRACKED_WRITE_CAPABLE_BOUNDARY`.
- TUI `/capabilities` rendered without duplicate static header or raw JSON, but
  showed default model in the panel while the header showed the mini override.
- TUI read-only mini run completed with `trace report`/`verify`/`session check`
  all `ok`.
- TUI approval denial rendered the diff, denied with `n`, left
  `tui-deny.txt` absent, and had valid trace/session.
- ACP/MCP focused tests and `npm run regression:matrix` passed.

## Non-Invariants Observed

- Real mini still does not reliably honor "exactly once" tool/delegate counts.
- `session resume --llm` appended a valid run but used configured default
  `openai/gpt-5.4-nano` instead of preserving or accepting the previous mini
  override.
- `delegates run delegate_writer` is not supported for internal profiles; it is
  limited to ACP/external-command delegates despite the generic help wording.

## Failures

- Failure pattern: `tui-capabilities-model-mismatch`
- Cause bucket: `product_bug`
- Count update: new count 1.
- Failure pattern: `promoted-shell-outcome-text`
- Cause bucket: `product_bug`
- Count update: new count 1.

## Coverage Update

- Page: `coverage/tui-rendering.md`, `coverage/shell.md`,
  `coverage/agents.md`, `coverage/trace-diagnostics.md`
- Change: Real mini/TUI/promoted-shell/delegate evidence added; exact
  real-model tool count and resume model semantics remain weak/decision areas.

## Follow-Up

- Decide whether `session resume --llm` should preserve prior model override or
  expose a `--model` flag.
- Add product tests for TUI capability panel model source and CLI promoted-shell
  outcome text.
