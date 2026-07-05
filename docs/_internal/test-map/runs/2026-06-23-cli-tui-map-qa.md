# 2026-06-23 CLI TUI Map QA

## Summary

- Scenario: Broad CLI/TUI follow-up from the project/test map after changes in
  core run terminality, trace diagnostics, cron model factories, host Skill
  proposals, and real-regression scripts.
- Coverage: core run loop, trace diagnostics, cron tick, host tools/Skill
  capability mutations, CLI capability/config paths, real model regressions, and
  TUI PTY rendering.
- Result: `pass`
- Reusable lesson: Focused gates and real regressions passed. A suspected TUI
  input-border bug was a `pyte.display` false positive; raw PTY capture must be
  used before classifying SGR-padded bordered rows as product bugs.

## Test Setup

- Task direction: Test CLI and TUI, look for issues, and identify simplification
  or shared-abstraction opportunities.
- Prompt shape: `scripted` for shell invalid args; `strong` for real CLI/TUI
  prompts; deterministic for cron and TUI first-screen measurement.
- Prompt: Read-only file inspection, shell invalid-args reproducer,
  deterministic two-job cron tick, Skill create/update capability prompts, TUI
  slash panels, and TUI read-only sentinel prompt.
- Model class: deterministic, scripted, and real provider/model
  `openai/gpt-5.4-nano`.
- Capabilities: read_file, shell, cron, Skill tools, MCP regression fixtures,
  external delegates, TUI slash panels.
- Permission/approval posture: repo tests read-only; write-capable real
  regressions used temporary fixtures with explicit flags.
- Workspace/config isolation: manual CLI/TUI checks used `/tmp` or
  `/var/folders/...` temporary workspaces; real regression workspaces were kept
  for trace inspection.
- Trace level: `debug` for manual CLI/TUI and real regressions.
- Environment notes: local user config resolved `openai/gpt-5.4-nano`;
  `config inspect` reported redacted provider keys.

## Commands Or Harness

```bash
npm --workspace @sparkwright/core test -- test/run.test.ts test/trace.test.ts
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace|config|capabilities inspect|skill|cron"
npm run build
npm run check:dist-fresh
node packages/cli/dist/index.js capabilities inspect --workspace . --format text
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "Exercise invalid shell args" --model scripted --yes --trace-level debug
node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$ws" --model deterministic
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-model
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ...
npm run check
```

## Stable Evidence

- Focused touched-area tests passed: core run/trace, cron schedule, host tools,
  and CLI trace/config/capabilities/skill/cron slice.
- `npm run check` passed: build, dist freshness, workspace typecheck, test
  typecheck, lint, format, schema, workspace lock, internal imports, package
  boundaries, reserved-field strict check, and all workspace tests.
- Scripted shell invalid args now emitted `tool.failed shell` with
  `TOOL_ARGUMENTS_INVALID`, `trace verify` returned `status: ok`, and
  `trace report` returned `verdict: failed` for unresolved tool failures rather
  than missing-terminal structure.
- CLI deterministic cron tick completed two due jobs; each job trace had one
  `read_file` request and one terminal run event.
- `regression:real-model` passed all six cases, including write-denied using
  current `write_file` and grouped/YAML config availability.
- `regression:real-skill-capabilities` passed all four cases, including real
  Skill create and real Skill update proposal.
- TUI slash checks rendered `/help`, `/capabilities`, and `/sessions` without
  raw JSON; `/capabilities` showed the same active model as CLI inspect.
- TUI real read-only run trace
  `/tmp/sparkwright-tui-read-current.yWomds/.sparkwright/sessions/session_tui_mqqnd74j/agents/main/trace.jsonl`
  had passing trace verify/report; session check for `session_tui_mqqnd74j`
  was `status: ok`.
- Raw PTY capture for the idle and non-empty input box showed aligned right
  borders at both 80 and 120 columns. The misleading `pyte.display` rows moved
  padding spaces after the right border; raw output kept those spaces before
  the right border.

## Non-Invariants Observed

- Real model read order and duplicate reads varied; stable assertions used trace
  event types and final status, not exact prose.
- `config inspect` redacts key values; redacted key length is not actual secret
  evidence.
- A first cron CLI check with `every 1m` attempted zero jobs because the jobs
  were not due yet. The stable reproducer uses near-past one-shot timestamps.

## Failures

- Failure pattern: none.
- Cause bucket: `test_bug` for the initial `pyte.display`-only interpretation;
  no product failure recorded.
- Count update: none.

## Coverage Update

- Page: `coverage/tui-rendering.md`
- Change: Added real read-only TUI trace/session evidence and the raw-vs-pyte
  caution for bordered row checks.

## Follow-Up

- Consider a small reusable PTY assertion helper that can compare raw terminal
  output and pyte reconstruction for layout invariants such as border columns,
  duplicate headers, and raw JSON absence.
