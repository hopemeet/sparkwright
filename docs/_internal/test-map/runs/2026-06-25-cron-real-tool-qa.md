# 2026-06-25 Cron Real Tool QA

## Summary

- Scenario: Cron failure-hunt from the test map, covering CLI CRUD, deterministic
  and real `cron tick`, real `cron run`, agent-created cron jobs through the
  deferred `cron` tool, and write approval posture inside cron runs.
- Coverage: cron store lifecycle, schedule parsing usability, run/tick traces,
  cron tool schema, capability mutation audit, and approval-heavy cron jobs.
- Result: `partial` (main run/tick paths passed; product issues found in update
  lifecycle, cron tool schema/audit, and schedule input usability).
- Reusable lesson: do not judge cron by aggregate completion alone. Inspect
  per-job status, trace tool events, cron state roots, and run summary mutation
  counters.

## Test Setup

- Task direction: "test cron functionality, real scenarios, multiple use or
  trigger paths, find issues".
- Prompt shape: `scripted` for CLI fixtures, `strong` for real provider
  read/write cron jobs, and `strong`/failure-hunting for agent cron tool use.
- Model class: deterministic plus real provider/model `openai/gpt-5.4-nano`
  from redacted local config.
- Capabilities: cron CLI, read_file, write_file, deferred `cron` tool,
  tool_search, approvals.
- Permission/approval posture: temporary workspaces; no product-code writes.
  Write cron jobs were tested once with default denial and once with
  `--yes-edits`.
- Workspace/config isolation: manual cron CLI checks used `--root-dir` and
  `--job-workspace`; agent cron tool checks used isolated `XDG_STATE_HOME`.
- Trace level: cron job traces use cron's standard level; agent tool runs used
  `--trace-level debug`.
- Environment notes: repo was on `main...origin/main [ahead 1]`; tests wrote
  only `/tmp` fixtures and test-map notes.

## Commands Or Harness

```bash
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t cron
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "cron|durable"

node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$ws" --model deterministic
node packages/cli/dist/index.js cron run real-read --root-dir "$root" --workspace "$ws" --model openai/gpt-5.4-nano
node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$ws" --model openai/gpt-5.4-nano

XDG_STATE_HOME="$state" node packages/cli/dist/index.js run "<create cron job with cron tool>" --workspace "$ws" --model openai/gpt-5.4-nano --trace-level debug

node packages/cli/dist/index.js cron run write-deny --root-dir "$root" --workspace "$ws" --model openai/gpt-5.4-nano
node packages/cli/dist/index.js cron run write-approve --root-dir "$root" --workspace "$ws" --model openai/gpt-5.4-nano --yes-edits
```

## Stable Evidence

- Focused gates passed:
  `@sparkwright/cron test -- test/schedule.test.ts`,
  `@sparkwright/cli test -- test/cli.test.ts -t cron`, and
  `@sparkwright/host test -- test/protocol.test.ts -t "cron|durable"`.
- Deterministic two-job `cron tick` in `/tmp/sparkwright-cron-e2e.6YQJ2F`
  reported `attempted: 2`, `completed: 2`; both job traces contained
  `tool.requested read_file`.
- Real read-only `cron run` in `/tmp/sparkwright-cron-real.JEAqQM` returned
  `CRON_REAL_SENTINEL_OK CRON_REAL_SENTINEL_0625`, requested `read_file`, had
  zero tool failures, and left the README sentinel unchanged.
- Real two-job `cron tick` in `/tmp/sparkwright-cron-real-tick.gaPjCo`
  reported `attempted: 2`, `completed: 2`; both job traces requested
  `read_file` and had zero tool failures.
- Default-denied write cron run recorded one `approval.requested`, one
  `workspace.write.denied`, zero completed writes, and no file creation.
- `--yes-edits` write cron run recorded one approval, one completed workspace
  write, zero denied writes, and created the expected sentinel file.

## Findings

- Failure pattern: `cron-completed-update-disabled`. Updating a completed job's
  schedule returned `state: scheduled` with `enabled: false`; a due tick
  attempted zero jobs until explicit resume.
- Failure pattern: `cron-tool-schema-loop`. A real agent using the deferred
  `cron` tool created five duplicate jobs and failed with `TOOL_DOOM_LOOP`;
  the tool schema/prose mismatch encouraged invalid `inspect` actions and
  structured schedule payloads.
- Failure pattern: `cron-capability-mutation-audit`. Agent-created cron jobs
  mutated `jobs.json`, but trace/run summaries reported zero capability
  mutations and a read-only outcome.
- Schedule UX gap: creating a job with delay input `1h` displays `in 1h`, but
  `--schedule "in 1h"` is rejected. The display string is not round-trippable.
- Follow-up fixed 2026-06-25:
  `cron-run-outcome-misclassified`. A write-required cron job whose workspace
  write is denied now exits 1 and records `lastStatus: error` when structured
  denial evidence exists, even if the model recovers with a final explanation.

## Non-Invariants Observed

- Real-model prose and exact retry behavior varied. Stable assertions were
  trace tool events, status fields, output paths, mutation counters, and file
  system state.
- Explicitly invalid `--model` makes an empty `cron tick` fail even when no jobs
  are due; no-config empty tick and deterministic empty tick returned
  `attempted: 0`. This was recorded as CLI behavior, not a cron failure.

## Coverage Update

- Page: `coverage/cron.md`
- Change: real run/tick evidence refreshed on 2026-06-25; added weak areas for
  completed-job update lifecycle, cron tool schema/audit, schedule display
  round-tripping, and write-denial status semantics.
