# 2026-06-23 TUI Cron Shell Follow-Up

## Summary

- Scenario: Continue QA after release gate by testing TUI slash/retry
  interaction, cron tick multi-job behavior, and shell invalid-args
  terminality.
- Coverage: TUI PTY rendering, TUI retry/session trace, cron tick multi-job
  state, real-provider cron tick, shell/trace diagnostics.
- Result: `partial`
- Reusable lesson: TUI slash/retry and real cron tick were healthy; deterministic
  cron tick can leak model adapter state across jobs, and shell input
  normalization failures still leave incomplete traces.

## Test Setup

- Task direction: Continue testing weak areas not fully covered by release
  checks.
- Prompt shape: `scripted` for shell invalid args, deterministic for TUI retry
  and cron tick leak reproduction, `strong` for real cron tick.
- Prompt: TUI inspected README without edits; cron jobs read README sentinels;
  shell scripted model emitted `shell` with `timeoutMs: 0`.
- Model class: deterministic, scripted, and real provider/model
  `openai/gpt-5.4-nano`.
- Capabilities: TUI slash commands, read_file, cron, shell.
- Permission/approval posture: temporary workspaces; no product-code writes;
  shell invalid args used `--yes` but failed before approval.
- Workspace/config isolation: all scenarios used `/tmp` roots.
- Trace level: `debug` for TUI and shell, cron run traces use cron's standard
  trace level.
- Environment notes: tracked worktree was clean before this pass.

## Commands Or Harness

```bash
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ... /help /capabilities /sessions
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ... "Inspect README.md without editing" /retry
node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$workspace" --model deterministic
node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$workspace" --model openai/gpt-5.4-nano
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "Exercise invalid shell args" --workspace "$tmp" --model scripted --yes --trace-level debug
node packages/cli/dist/index.js trace verify /tmp/sparkwright-shell-invalid.So9gdO/.sparkwright/sessions/session_mqq3i6ocdyxgd7k8/trace.jsonl --format text
node packages/cli/dist/index.js trace report /tmp/sparkwright-shell-invalid.So9gdO/.sparkwright/sessions/session_mqq3i6ocdyxgd7k8/trace.jsonl --format text
```

## Stable Evidence

- TUI `/help`, `/capabilities`, and `/sessions` rendered cleanly at 120x32 and
  80x24 without raw JSON, duplicate header, or overflow.
- TUI `/retry` used one session
  `/tmp/sparkwright-tui-retry.sxID0e/.sparkwright/sessions/session_tui_mqq3dl0u/trace.jsonl`
  with 2 runs, 2 `run.completed`, 2 `read_file`, trace verify `ok`, and
  session check `ok`.
- Deterministic cron tick in `/tmp/sparkwright-cron-tick.Jfs4Rn` reported
  `attempted=2` and `completed=2`; both jobs were marked `ok`, but the second
  job trace contained no `tool.requested` event.
- Real `openai/gpt-5.4-nano` cron tick in
  `/tmp/sparkwright-cron-tick-real.wLKgFh` ran two due jobs successfully; both
  traces requested `read_file`, read `CRON_TICK_REAL_SENTINEL`, produced local
  output, and left README unchanged.
- Scripted shell invalid args trace
  `/tmp/sparkwright-shell-invalid.So9gdO/.sparkwright/sessions/session_mqq3i6ocdyxgd7k8/trace.jsonl`
  had `tool.requested shell`, no `tool.failed`, and no terminal run event.
  `trace verify` failed with `TRACE_TERMINAL_EVENT_COUNT_INVALID`; `trace
  report` still returned `verdict: ok`.

## Non-Invariants Observed

- TUI final screen labels completed runs as `run facts`; tests should assert
  trace/session completion rather than exact completion prose in the screen.
- Real cron output prose can include line breaks around the requested sentinel;
  the stable assertions are per-job trace/tool evidence, output existence, and
  unchanged workspace files.

## Failures

- Failure pattern: `cron-deterministic-model-state-leak`
- Failure pattern: `shell-invalid-args-terminality`
- Cause bucket: `product_bug`
- Count update: recorded cron deterministic leak count 1; incremented shell
  invalid args terminality count from 1 to 2.

## Coverage Update

- Page: `coverage/tui-rendering.md`
- Page: `coverage/cron.md`
- Page: `coverage/shell.md`
- Page: `coverage/trace-diagnostics.md`
- Change: Added TUI slash/retry PTY evidence, real multi-job cron tick
  evidence, deterministic cron tick leak, and scripted shell invalid-args
  reproducer.

## Follow-Up

- Add/fix a CLI cron tick regression for two deterministic due jobs.
- Capture shell input normalization errors as `tool.failed` plus terminal
  `run.failed`, and make `trace report` surface incomplete traces.
- Keep using trace/session checks for TUI retry rather than screen prose.
