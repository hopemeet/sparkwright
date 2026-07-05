# 2026-06-29 MCP/Cron/TUI/Agent Boundary QA

## Summary

- Scenario: Exploratory follow-up for remaining weak areas: MCP external tool
  boundaries, cron mixed success/failure, TUI `/export` copy/export behavior,
  and agent/delegate long-chain diagnostics.
- Coverage: MCP, cron, TUI rendering/export, agents/delegates, trace/session
  diagnostics.
- Result: `partial` (product bugs fixed; MCP absolute-path audit remains a
  product-boundary decision)
- Reusable lesson: per-job traces and session checks can be healthy while a
  higher-level product surface still misleads. Always compare aggregate command
  output with persisted status and trace summaries.

## Test Setup

- Task direction: Continue `/sparkwright-test-map-qa` from the remaining risk
  list and find system issues.
- Prompt shape: `scripted` and deterministic for runtime invariants; PTY slash
  command script for TUI.
- Model class: `scripted` parent runs, `deterministic` child/cron/TUI runs.
- Capabilities: MCP stdio server, cron jobs, TUI export, configured
  in-process delegates and `delegate_parallel`.
- Permission/approval posture: read-only where possible; MCP default-risk
  approval tested both denied and `--yes`; cron mixed test used `--yes-edits`
  only where needed to create one ok and one failing job.
- Workspace/config isolation: all fixtures under `/var/folders/.../T/`.
- Trace level: debug for MCP and agent runs, standard for cron job traces
  because cron currently uses standard traces, PTY capture for TUI.
- Environment notes: `npm run check:dist-fresh` reported fresh dist for 26
  workspaces before these runs.

## Commands Or Harness

```bash
node packages/cli/dist/index.js capabilities inspect --workspace . --format text
npm run check:dist-fresh

# MCP fixture:
node packages/cli/dist/index.js capabilities inspect --workspace "$mcp_ws" --resolve-mcp --format text
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "MCP neutral cwd absolute workspace write" --workspace "$mcp_ws" --model scripted --trace-level debug
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "MCP default risky approval boundary" --workspace "$mcp_risky_ws" --model scripted --trace-level debug
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "MCP default risky approved boundary" --workspace "$mcp_risky_ws" --model scripted --trace-level debug --yes

# Cron mixed fixture:
node packages/cli/dist/index.js cron create --root-dir "$cron_root" --job-workspace "$ok_ws" --schedule "$iso" --repeat 1 --prompt "Read README.md and answer briefly." --name ok-read
node packages/cli/dist/index.js cron create --root-dir "$cron_root" --job-workspace "$bad_ws" --schedule "$iso" --repeat 1 --prompt "Read README.md and answer briefly." --name bad-read
node packages/cli/dist/index.js cron tick --root-dir "$cron_root" --workspace "$ok_ws" --model deterministic --yes-edits
node packages/cli/dist/index.js cron status ok-read --root-dir "$cron_root"
node packages/cli/dist/index.js cron status bad-read --root-dir "$cron_root"
node packages/cli/dist/index.js trace summary "$bad_trace" --format text
node packages/cli/dist/index.js trace report "$bad_trace" --format text

# TUI export fixture:
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py \
  --cwd /Applications/xgw/projects/AI-native/SparkWright \
  --rows 32 --cols 100 \
  --cmd 'node packages/cli/dist/index.js tui --workspace "$tui_ws" --session-root "$tui_sessions" --model deterministic' \
  --script '[[1.0,"Inspect README.md and answer in one short sentence."],[0.8,"\r"],[8.0,"__DUMP__"],[0.5,"/export"],[0.8,"\r"],[1.5,"__DUMP__"]]'

# Agent/delegate fixture:
SPARKWRIGHT_SCRIPTED_MODEL_JSON='[...]' node packages/cli/dist/index.js run "agent delegate long-chain ledger QA" --workspace "$agent_ws" --model scripted --trace-level debug
node packages/cli/dist/index.js trace summary "$agent_trace" --format text
node packages/cli/dist/index.js trace verify "$agent_trace" --format text
node packages/cli/dist/index.js session check "$agent_session" --workspace "$agent_ws" --format text
```

## Stable Evidence

- MCP default stdio cwd remains neutral. A relative MCP write did not create a
  workspace file. An absolute MCP write to the workspace did create
  `absolute-note.txt`, but trace summary still reported `managed workspace
  writes 0` and `untracked write-capable boundaries 0`; this matches the
  current MCP map's trusted external-tool boundary, but is an audit gap to keep
  visible.
- MCP default risky tools require approval in non-interactive CLI runs. Without
  `--yes`, `mcp_qa_cwd_report` produced `TOOL_APPROVAL_DENIED`; with `--yes`,
  it auto-approved and completed. Trace verify and session check passed.
- Cron mixed fixture produced one ok job and one error job:
  - ok status: `lastStatus:"ok"` and one managed workspace write after
    `--yes-edits`.
  - bad status: `lastStatus:"error"` with
    `completed_with_tool_failures` (`TOOL_ARGUMENTS_INVALID`, `EISDIR`).
  - bad standard trace summary/report clearly showed 3 unresolved tool
    failures and `trace report` returned failed.
  - `cron tick` aggregate still printed `{"attempted":2,"completed":2}` and
    exited 0.
- TUI `/export` now emits a border-free scrollback confirmation line and path,
  while also showing the older toast. The exported Markdown file was created.
- TUI exported Markdown lost the user goal: trace `run.created.payload.goal`
  and `model.requested.payload.goal` contained the prompt, while the export
  rendered `_(no goal text)_`.
- Agent/delegate long-chain scripted run passed structurally:
  - `tool_search`, `delegate_agent`, then `delegate_parallel`.
  - summary: 3 runs, agents `main`, `api_reviewer`, `test_reviewer`.
  - `delegate_parallel` result for `api_reviewer` had
    `alreadyCompleted:true`, so the shared ledger reused the earlier child.
  - trace report, trace verify, and session check were all ok.

## Non-Invariants Observed

- The deterministic child model's generated message used the parent goal text
  even though `model.requested.payload.goal` carried the correct delegated
  child goal. This looks like deterministic demo adapter closure text, not a
  real-provider delegation invariant. Fixed after the run by making the demo
  adapter read `ModelInput.run.goal` and keep turn state per run id.
- A long export path still wraps at 100 columns in the PTY capture, but the
  copy target is no longer inside a bordered toast-only surface.

## Failures

- Failure pattern: `cron-tick-aggregate-miscounts-failed-jobs`
- Cause bucket: `product_bug`
- Count update: new count 1.
- Status after source follow-up: fixed.

- Failure pattern: `tui-export-missing-user-goal`
- Cause bucket: `product_bug`
- Count update: new count 1.
- Status after source follow-up: fixed.

- Failure pattern: `deterministic-demo-adapter-run-goal-state`
- Cause bucket: `product_bug` in deterministic diagnostics adapter.
- Count update: new count 1.
- Status after source follow-up: fixed.

## Coverage Update

- Page: `coverage/cron.md`
- Change: Added evidence that standard per-job traces diagnose mixed failures,
  but `cron tick` aggregate output currently misreports mixed ok/error as
  completed count 2.

- Page: `coverage/tui-rendering.md`
- Change: Confirmed `/export` path is no longer toast-only, and added the
  exported Markdown missing-goal defect.

- Page: `coverage/agents.md`
- Change: Recorded the long-chain delegate/parallel ledger pass and the fixed
  deterministic demo-adapter goal/turn-state diagnostic defect.

## Post-Fix Verification

- Cron aggregate:
  - Source fix: `tickCron()` increments `completed` only when `result.ok` is
    true, counts failed due jobs as `failed`, and CLI `cron tick` exits 1 when
    `failed > 0`.
  - Tests passed: `npm --workspace @sparkwright/cron test --
    test/schedule.test.ts`; `npm --workspace @sparkwright/cli test --
    test/cli.test.ts -t "cron tick has a failed job"`.
- TUI export goal:
  - Source fix: `renderTranscript()` collects one per-run goal from
    `run.created`, `model.requested`, then `run.started`, and renders the user
    section once.
  - Tests passed: `npm --workspace @sparkwright/tui test --
    test/transcript.test.ts`; `npm --workspace @sparkwright/tui run typecheck`.
- Deterministic delegate diagnostics:
  - Source fix: deterministic demo adapter response text uses
    `ModelInput.run.goal` and turn counters are keyed by `run.id`.
  - Tests passed: `npm --workspace @sparkwright/host test --
    test/model-factory.test.ts`; `npm --workspace @sparkwright/host run
    typecheck`.

## Follow-Up

- Decide whether MCP external-tool workspace file writes should get a stronger
  untracked boundary signal when a tool result exposes an absolute workspace
  path, or keep the current trusted-server contract and document it more
  prominently.
- Re-run a real TUI export path/copy ergonomics pass if `/export` UI changes
  again; the current source fix covered Markdown content, not terminal mouse
  selection behavior.
