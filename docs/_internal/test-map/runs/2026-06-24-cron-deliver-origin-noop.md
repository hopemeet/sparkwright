# 2026-06-24 Cron Deliver Origin No-Op

## Summary

- Scenario: Failure-hunt from the test map after routing through `coverage/`.
  Targeted the named untested edge "cron deliver modes beyond local output".
- Coverage: cron delivery dispatch (CLI flag, cron tool payload, store, runner).
- Result: `fail` (product bug found).
- Reusable lesson: `deliver: "origin"` is accepted on three surfaces but read by
  none. Grep `.deliver` reads before designing a delivery fixture; if the only
  hits are the CLI parse and the store persist/patch, the field is unimplemented
  and origin behaves identically to local.

## Test Setup

- Task direction: continue testing, find unknown issues.
- Prompt shape: `scripted`/deterministic (source inspection plus a deterministic
  single-job repro).
- Model class: `deterministic` (no provider key, no budget spent).
- Capabilities: cron create/run, read_file (default cron toolset).
- Permission/approval posture: read-only repo; job ran in a temp root.
- Workspace/config isolation: `mktemp -d` root; output landed under
  `<root>/output/<jobId>/...md`.
- Trace level: `standard` (cron default).
- Environment notes: macOS. No source changes; `dist` already fresh.

## Commands Or Harness

```bash
grep -rIn "\.deliver" packages --include="*.ts" | grep -v /dist/   # only CLI parse + store
node packages/cli/dist/index.js cron create --schedule "* * * * *" \
  --prompt "Say hello deterministically" --deliver origin \
  --root-dir "$root" --workspace "$ws"        # jobs.json persists "deliver": "origin"
node packages/cli/dist/index.js cron run "Say hello deterministically" \
  --model deterministic --root-dir "$root" --workspace "$ws"
```

## Evidence

- `jobs.json` persisted `"deliver": "origin"`.
- `cron run` result: `ok: true`, `outputPath` =
  `<root>/output/0cffbb11b0ea/...md` (the normal local output file). No
  origin/remote artifact produced; no warning, no error.
- Source: `packages/cron/src/runner.ts:90-99` always calls `writeJobOutput`;
  never reads `job.deliver`. Only readers of `.deliver` are
  `packages/cli/src/cli.ts:5190,5223,5241` and `packages/cron/src/store.ts:73,119`.
- Model-facing surface: `packages/cron/src/tool.ts:41,47` lists `deliver` in the
  create/update payload description.

## Findings

- Owner layer: cron package (runner/scheduler) plus the surfaces advertising the
  option (CLI `--deliver`, cron tool payload, `DeliveryTarget` model type).
- Cause bucket: `product_bug` — an unimplemented capability surfaced as
  functional. Either implement an origin delivery path keyed on `job.deliver` or
  stop advertising `origin` / emit an explicit "not implemented" signal.
- See [../failures/cron-deliver-origin-noop.md](../failures/cron-deliver-origin-noop.md).

## Residual Risk / Next

- Not a regression introduced by recent commits; long-standing gap.
- Minor adjacent observation (by design, not filed): `cron run`/`cron tick`
  ignore the global `--workspace` flag for the run itself — the runner uses
  `job.workspace ?? process.cwd()` (`runner.ts:48`). Set the job workspace with
  `--job-workspace` at create time; otherwise jobs run in the process cwd.
