# 2026-06-29 Real Mini Tool Surface Follow-Up

## Summary

- Scenario: follow-up QA for untested tool filtering, safety denials, session resume, CLI help routing, and narrow TUI slash panels.
- Coverage: config-driven tool filtering, disabled discovery, read-only write denial, confidential reads, session resume, CLI nested help, and TUI session/capability panels.
- Result: `partial`
- Reusable lesson: safety denials and selector filtering mostly hold, but help routing and product copy can drift from the actual configured runtime.

## Test Setup

- Task direction: continue failure hunting after the real mini tool-surface QA pass.
- Prompt shape: `strong`
- Model class: real provider/model `openai/gpt-5.4-mini` where model behavior was involved; deterministic CLI/TUI commands for help and slash-panel checks.
- Capabilities: default catalog, `tools.use: [workspace.read]`, and `tools.disabled: [tool_search]` fixtures.
- Permission/approval posture: read-only for filtering and denial tests.
- Workspace/config isolation: all write/read-denial/filter fixtures under `/var/folders/.../T/`; TUI slash-panel session root under `/tmp/sparkwright-tui-narrow-sessions`.
- Trace level: `debug` for model runs.
- Environment notes: user provider config was reused in redacted form; no provider keys were printed.

## Commands Or Harness

```bash
node packages/cli/dist/index.js run "<intentional write in read-only>" --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<read confidential secret.txt>" --confidential secret.txt --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js capabilities inspect --workspace <tool-filter-fixture> --model openai/gpt-5.4-mini --format text
node packages/cli/dist/index.js run "<tool_search select:list_skills,bash,write>" --workspace <tool-filter-fixture> --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run resume --help
node packages/cli/dist/index.js session resume session_mqyydr8cmswp8z57 "<resume prompt>" --workspace <tool-filter-fixture> --model openai/gpt-5.4-mini
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --rows 24 --cols 60 --cmd 'node packages/cli/dist/index.js tui --session-root /tmp/sparkwright-tui-narrow-sessions ...'
```

## Stable Evidence

- Read-only write denial trace `<readonly-write-fixture>/.sparkwright/sessions/session_mqyybgv4wicflvtg/trace.jsonl`: `write` failed with `TOOL_DENIED`, `DENIED.txt` was missing, `trace report` and `trace verify` were ok.
- Confidential read trace `<confidential-read-fixture>/.sparkwright/sessions/session_mqyyc8n7t28k9xx3/trace.jsonl`: `workspace.read.denied` + `READ_SCOPE_DENIED`, `confidential reads denied 1`, no secret string persisted in trace, `trace report` and `trace verify` were ok.
- `tools.use: [workspace.read]` fixture exposed only `read`, `glob`, `grep`, and `tool_search` in model-visible descriptors; `tool_search select:list_skills,bash,write` returned `matches: []`.
- Session resume on `session_mqyydr8cmswp8z57` completed as a second run in the same session; `session check` and `trace verify` were ok with `runs: 2`.
- TUI `/help`, `/sessions`, and `/capabilities` rendered cleanly at 60 columns without raw JSON or obvious border overlap.

## Non-Invariants Observed

- `tools.disabled: [tool_search]` removes `tool_search` from model-visible tools, but the `capability_delta` prompt still says advanced and infrastructure tools may be available through `tool_search`.
- `run resume --help` is parsed as a resume attempt for run id `--help`, not as help, and writes a failed trace under the current workspace.
- TUI `/sessions` with a custom `--session-root /tmp/sparkwright-tui-narrow-sessions` says `(none found in .sparkwright/sessions ...)`, which points at the wrong root.

## Failures

- Failure pattern: [../failures/capability-delta-disabled-tool-search.md](../failures/capability-delta-disabled-tool-search.md)
- Cause bucket: `product_bug`
- Count update: +1.

- Failure pattern: [../failures/cli-run-resume-help-starts-run.md](../failures/cli-run-resume-help-starts-run.md)
- Cause bucket: `product_bug`
- Count update: +1.

- Failure pattern: [../failures/tui-sessions-custom-root-empty-label.md](../failures/tui-sessions-custom-root-empty-label.md)
- Cause bucket: `product_bug`
- Count update: +1.

## Coverage Update

- Page: [../coverage/config-schema.md](../coverage/config-schema.md)
- Change: add weak areas for disabled discovery prompt drift and nested help/config command surfaces.
- Page: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Change: add weak area for `/sessions` copy under custom session roots.

## Follow-Up

- Suppress or rewrite `capability_delta` when `tool_search` is not model-visible.
- Add a CLI regression for nested help on `run resume --help`.
- Pass session root display text into `SessionListDialog` or use neutral wording that does not hard-code `.sparkwright/sessions`.

