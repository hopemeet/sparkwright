# Cron Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-06-29
- Evidence source: 2026-06-25 focused cron package tests, CLI cron subset, host
  protocol cron summaries, deterministic two-job `cron tick`, real
  `openai/gpt-5.4-nano` read-only `cron run`, real two-job `cron tick`, real
  write-denied/write-approved cron runs, and real agent cron-tool creation in
  isolated temporary roots. A deterministic two-job `cron tick` state-leak
  reproducer was rerun after fixes and both job traces contained the expected
  `read_file` route.

## Covered

- Schedule parsing for delay, interval, cron, and ISO timestamp forms.
- Cron store state transitions for create, list, status, pause, resume, update,
  remove, lock handling, due jobs, recurring jobs, and failure summaries in
  focused tests.
- CLI cron state commands honor an isolated cron root and XDG state defaults.
- A job-level `--job-workspace` remains the workspace used by read tools, even
  when `cron run` is invoked with a different CLI `--workspace`.
- Real read-only cron run created a fresh cron session trace, updated
  `lastTracePath`, wrote a local output file, and left the fixture README
  unchanged.
- Real two-job `cron tick` with `openai/gpt-5.4-nano` completed both due jobs;
  both traces requested `read_file`, read the sentinel, wrote local outputs, and
  left the workspace unchanged.
- Approval-heavy real cron runs route workspace writes through normal approval
  events: default non-interactive denial recorded `approval.requested`,
  `workspace.write.denied`, and no file creation; `--yes-edits` recorded
  `workspace.write.completed` and created the expected sentinel file.
- Strongly prompted real agent creation through the deferred `cron` tool can
  create a job in isolated XDG state when the payload exactly matches the
  accepted schema.
- 2026-06-25 fix evidence: cron command surfaces now route through
  `CronCommandService`; the in-session cron tool has strict create/update
  schemas, mutating actions are risky external side effects, successful changes
  report `capability.mutation.completed`, and tool-level create is idempotent
  by effective name/config, including unnamed creates that use the default job
  name. Scripted host/tool smoke produced one job, one capability mutation, and
  no duplicate job for a repeated create.
- 2026-06-25 outcome fix evidence: cron runner now treats structured failing
  completed-run outcomes and unattended approval/policy denials as job errors.
  Focused cron tests cover a denied workspace write and an unresolved tool
  failure where the model still emits a final answer. CLI smokes confirmed
  default denied deterministic writes exit 1 and leave `lastStatus: error`,
  while `--yes-edits` deterministic writes still exit 0 and leave
  `lastStatus: ok`.
- 2026-06-28 P0/P1 follow-up reran cron package/CLI/host gates and a manual
  `deterministic/demo` `cron run` smoke. The unattended write attempt recorded
  approval denial, left `lastStatus:"error"`, wrote no workspace file, and the
  trace verified cleanly.
- 2026-06-29 mixed deterministic `cron tick` fixture verified that standard
  per-job traces can express mixed success/failure: the ok job persisted
  `lastStatus:"ok"`, the bad job persisted `lastStatus:"error"` with
  unresolved `TOOL_ARGUMENTS_INVALID` / `EISDIR` tool failures, and the bad
  job's `trace report` failed with `UNRESOLVED_TOOL_FAILURES`.

## Weak Or Untested

- Keep the deterministic two-job `cron tick` route in the release canary set;
  aggregate tick counts can hide per-job trace regressions.
- `cron tick` with mixed success/failure was covered by package tests, but not
  yet exercised with a real provider in an isolated release canary.
- Cron runs always use `standard` trace level today; diagnostic assertions may
  need package-level evidence for details not emitted at that level.
- ACTIVE 2026-06-29: `cron tick` aggregate output can report
  `attempted:2, completed:2` and exit 0 even when one due job is persisted as
  `lastStatus:"error"`. Per-job status and trace diagnostics are correct; the
  aggregate tick result is misleading. See
  [../failures/cron-tick-aggregate-miscounts-failed-jobs.md](../failures/cron-tick-aggregate-miscounts-failed-jobs.md).
- FIXED 2026-06-25: updating a completed/error job's schedule now reactivates
  it (`enabled: true`), clears running state, resets `repeat.completed`, and due
  ticks can run it again. See
  [../failures/cron-completed-update-disabled.md](../failures/cron-completed-update-disabled.md).
- FIXED 2026-06-25: the deferred cron tool schema/prose mismatch was corrected
  for create/update/status actions; structured schedule payloads are rejected as
  `TOOL_ARGUMENTS_INVALID`, `inspect` aliases to status, and repeated identical
  creates return the existing job instead of auto-suffixing, including when
  `name` is omitted. See
  [../failures/cron-tool-schema-loop.md](../failures/cron-tool-schema-loop.md).
- FIXED 2026-06-25: agent-created cron jobs now report capability mutations; a
  scripted host/tool smoke showed `Capability mutations: 1 completed` and one
  persisted cron job. See
  [../failures/cron-capability-mutation-audit.md](../failures/cron-capability-mutation-audit.md).
- FIXED 2026-06-25: schedule display/input is round-trippable for delay forms;
  `--schedule "in 1h"` is accepted and displays `in 1h`.
- FIXED 2026-06-25: if a cron job's required workspace write is denied, the
  job now records `lastStatus: error` even when the model recovers with an
  explanatory final answer. See
  [../failures/cron-run-outcome-misclassified.md](../failures/cron-run-outcome-misclassified.md).
- Residual design gap: cron has no explicit per-job success criterion, so a
  pure final explanation with no tool, verification, mutation, failure, or
  denial signal cannot be classified semantically without adding a new contract.
- FIXED 2026-06-24 (branch `fix/cron-deliver-deadfield-workspace`, not yet
  PR'd): the `deliver` / `DeliveryTarget` dead field was removed entirely
  (option A) instead of implementing origin delivery. Cron output is local-only
  by design; there is no longer a delivery-target knob to test. `--deliver` now
  errors as an unknown option. See
  [../failures/cron-deliver-origin-noop.md](../failures/cron-deliver-origin-noop.md).
- FIXED 2026-06-24 (same branch): `runner.ts` now resolves
  `job.workspace ?? options.workspaceRoot ?? process.cwd()`, and the CLI threads
  `--workspace` into `runCronJobByRef`/`tickCron`. A job without its own
  `job.workspace` now runs (and writes its session/trace) under the caller's
  `--workspace` instead of the process cwd, which previously leaked a cron
  session dir into the repo working tree. A job-level `--job-workspace` still
  wins, so the existing precedence test stays green.

## Focused Route

```bash
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t cron
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "cron|durable"
```

Use a temporary root for manual CLI checks:

```bash
node packages/cli/dist/index.js cron create --root-dir "$root" --job-workspace "$workspace" --schedule "every 1h" --prompt "read README.md" --name qa
node packages/cli/dist/index.js cron run qa --root-dir "$root" --workspace "$workspace" --model openai/gpt-5.4-nano
node packages/cli/dist/index.js cron status qa --root-dir "$root"
```

## Scenario Links

- Add a dedicated cron real-provider scenario if cron becomes a release-blocking
  area.

## Sensitivity Links

- [../matrices/environment-sensitivity.md](../matrices/environment-sensitivity.md)
- [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)
- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)

## Stale Triggers

- `packages/cron/src/*`
- `packages/cli/src/cli.ts` cron argument parsing and command handling
- `packages/cli/src/runners/direct-core-runner.ts` configured CLI tool roots
- `packages/host/src/protocol.ts` capability inspection summaries

## Failure Links

- [../failures/cron-deterministic-model-state-leak.md](../failures/cron-deterministic-model-state-leak.md)
- [../failures/cron-tick-aggregate-miscounts-failed-jobs.md](../failures/cron-tick-aggregate-miscounts-failed-jobs.md)
- [../failures/cron-deliver-origin-noop.md](../failures/cron-deliver-origin-noop.md)
- [../failures/cron-completed-update-disabled.md](../failures/cron-completed-update-disabled.md)
- [../failures/cron-tool-schema-loop.md](../failures/cron-tool-schema-loop.md)
- [../failures/cron-capability-mutation-audit.md](../failures/cron-capability-mutation-audit.md)
- [../failures/cron-run-outcome-misclassified.md](../failures/cron-run-outcome-misclassified.md)
