# Cron Capability

## Purpose

Cron capability stores scheduled background jobs and exposes automation status
and creation/update flows through CLI/TUI/host tooling.

See [../../modules/agent-runtime.md](../../modules/agent-runtime.md) for related task execution concepts.

## Last Verified

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: Cron runner imports Core workspace/trace reference implementations
  through `/internal`; scheduling, locking, policy, and persistence contracts
  are unchanged.
- Read: Cron runner/tests, Agent/Project Context downstream builds, Core
  barrels, and package route.
- Tests: Cron 20/20 and Cron typecheck passed.

- Status: Read-only
- Date: 2026-07-16T23:05:00+0800
- Scope: checked the routed Task notification consolidation; Cron stores,
  scheduling, run success, and tool contracts do not consume the removed
  task-specific notification surface and are unchanged.
- Read: Agent Runtime task notification consumers and Cron capability boundary.
- Tests: no Cron-specific behavior rerun; cross-package focused suites and
  repository test typecheck and the full release gate covered changed
  consumers.

- Status: Verified
- Date: 2026-07-16T13:21:00+0800
- Scope: Cron accepts only `InteractionChannel`; unattended default is `ask` plus a deny-only approval handler, while CLI omission stays read-only.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Date: 2026-07-16
- Scope: reviewed after the portable workflow delegate identity change; cron contracts and execution paths are unaffected.

## Main Files

- `packages/cron/src/*`
- `packages/cli/src/cli.ts`
- `packages/cli/src/runners/direct-core-runner.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/tools.ts`
- `packages/tui/src/app.tsx`

## Data Flow

```txt
cron config/state
  -> CronCommandService create/update/list/status/pause/resume/remove
  -> CLI/TUI/host create/update/list
  -> CLI diagnostic tool catalog for scheduled run tool setup
  -> scheduler/runner
  -> task/run output and capability inspect summary
```

## Contracts

- Cron state uses the `sparkwright-cron.v1` store schema.
- Cron state root is XDG state (`$XDG_STATE_HOME/sparkwright/cron` or
  `~/.local/state/sparkwright/cron`) with no legacy config-root migration.
- `CronCommandService` owns schema-normalized command behavior for create,
  update, list, status, pause, resume, and remove. `CronStore` remains the
  persistence/atomic mutation layer and composes `agent-runtime` `doc-store`
  atomic writes for durable store saves.
- Cron jobs can reference skills and run goals on a schedule.
- Schedule delay input accepts both compact (`1h`) and display (`in 1h`) forms.
- Updating a completed/error job's schedule reactivates it, clears
  `runningSince`, enables it, and resets `repeat.completed` for the new cycle.
- The in-session `cron` tool consumes `ref` (job id or exact name) as the only
  field for `remove`/`pause`/`resume`/`status`/`inspect` (and with `patch` for
  `update`); `job`/`patch` apply solely to create/update and are ignored
  otherwise (`service.removeJob(input.ref)`). The tool schema descriptions state
  this and note `remove` is idempotent (a follow-up "not found" means the
  deletion already succeeded) so the model does not loop. The doom-loop guard
  and outcome recovery key cron retries on `ref` — see
  [../runtime/tool-orchestration.md](../runtime/tool-orchestration.md).
- The in-session `cron` tool exposes status/list as read-only, mutating actions
  as risky external side effects, and reports `capability.mutation.completed`
  for changed cron state. Tool-level create is idempotent by effective
  name/config, including the default name derived when `name` is omitted;
  same-effective-name different config errors instead of auto-suffixing.
  One-shot delay/absolute schedules do not participate in idempotent create
  matching, so repeated "in 1h" style requests create fresh jobs with unique
  names.
- Cron create results expose the requested effective name and whether storage
  adjusted it. CLI and TUI unique-create flows surface that auto-suffixing so
  users can see when `name 2` was created instead of the requested name.
- Cron run/tick accepts the same `accessMode` as other run entrypoints and
  compiles it to the internal execution policy. The reusable runner defaults
  to `ask` with a deny-only resolver, preserving unattended safe-tool execution
  while rejecting actions that actually require approval; CLI omission still
  resolves to its canonical `read-only` default before calling Cron.
- CLI cron run/tick paths use `createConfiguredCliTools`, which flattens the
  host CLI diagnostic catalog profile, applies configured tool selectors, and
  filters recursive `cron` execution in `@sparkwright/cron`.
- `cron tick` uses a per-job model factory so stateful adapters such as the
  deterministic diagnostic model do not leak turn state across due jobs.
  Manual `cron run <ref>` still runs exactly one job and may pass a single
  adapter.
- `cron tick` aggregate output treats `completed` as successful cron-local
  results only and reports failed due jobs separately as `failed`; per-job lock
  skips remain separate in `skippedBecauseJobLocked`.
- Cron runner derives job success from the terminal run plus structured
  evidence: core `completedRunOutcomeFromEvents()` failing outcomes mark the
  job as error, and unattended approval/policy denials from
  `analyzeToolOutcomes()` also mark the job as error. This is cron-local
  semantics; it does not change the CLI's general completed-run exit policy.
- Capability inspection reports cron state root and job summary.

## Consumers

- CLI `cron` commands.
- TUI capabilities panel and `/create cron`.
- Host capability snapshot.
- Agent-runtime task infrastructure where jobs produce durable work.

## Change Checklist

- Check store schema and corrupt-file backup behavior.
- Check CLI and TUI create/update flows.
- Check capability inspect output.
- Check task/run trace evidence for executed jobs.

## Known Debts

- Cron execution, task state, and run trace are adjacent but not fully mapped in this first pass.
- Cron can now fail jobs on structured failing outcomes and denials, but it
  still cannot infer arbitrary goal success from a model's final prose when no
  tool, verification, mutation, or denial signal exists.

## Last Verified

- Status: Verified
- Date: 2026-07-16T10:44:25+0800
- Scope: reviewed after Task model-surface consolidation; cron does not register
  or consume the removed Task control factories.
- Read: Task factory consumers and cron capability boundary.
- Tests: repository test typecheck passed; no cron contract changed.

- Status: Verified
- Date: 2026-07-16T10:27:51+0800
- Scope: reviewed after the Agent-tool policy contract changed; cron task and
  tool policy assembly do not call the Agent-tool factory and are unchanged.
- Read: agent-runtime call sites and cron capability boundaries.
- Tests: repository test typecheck passed; no cron contract changed.

- Status: Verified
- Date: 2026-07-15
- Scope: reviewed execution-scoped background Task dependencies; cron ownership
  and durable Task revival remain unchanged.

- Status: Read-only
- Date: 2026-07-12T20:12:00+0800
- Scope: checked shared Workflow record layer addition; cron contracts and
  scheduling behavior are unchanged.
- Read: Workflow pin types/store and cron capability map.
- Tests: focused Workflow tests passed; no cron contract change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Agent runtime attribution change; cron Agent contracts need no update.
- Tests: focused agent-runtime tests and the 2026-07-15 release gate passed.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked portable Workflow record changes; Cron behavior is unchanged.
- Tests: not run for Cron behavior; Phase 4 Workflow release gate passed.

- Status: Read-only
- Date: 2026-07-07T14:43:43+0800
- Scope: real mini Agent + Skill QA follow-up changed detached/promoted
  `task_create` result guidance and host terminal task notification body text
  only. Cron state, `CronStore`, cron tool schemas, scheduler semantics, and
  cron run success derivation are unchanged.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: cron-specific behavior not rerun for this agent-task feedback fix;
  focused task/agent tests and host task revival tests covered the changed
  paths.

- Status: Read-only
- Date: 2026-07-07T12:30:00+0800
- Scope: real Sonnet nested-agent/task QA changed host nested-agent task
  wrapping and agent-runtime task monitor semantics only. Cron state,
  `CronStore`, cron tool schemas, scheduler semantics, and cron run success
  derivation are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: cron-specific behavior not rerun for this agent-task fix; focused
  task/agent tests and real Sonnet trace report/verify covered the changed
  paths.

- Status: Read-only
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 migration moved the shared atomic writer implementation under
  core `file-atomic` while preserving the `agent-runtime` doc-store public
  wrapper used by `CronStore.save()`. Cron schema, command/tool contracts,
  scheduler semantics, and run success derivation are unchanged.
- Read: `packages/agent-runtime/src/doc-store/index.ts`,
  `packages/core/src/file-atomic.ts`, `packages/cron/src/store.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`.
- Tests: storage-focused `npm --workspace @sparkwright/agent-runtime test --
test/doc-store.test.ts`; cron behavior not rerun for this implementation-only
  doc-store wrapper change.

- Status: Verified
- Date: 2026-07-06T18:44:10+0800
- Scope: C9 S1 migration: `CronStore.save()` now uses the shared
  `doc-store` `atomicWriteText()` for `jobs.json`, retiring
  `packages/cron/src/store.ts`'s private tmp+fsync+rename+directory-fsync
  write flow without changing the `sparkwright-cron.v1` store schema or cron
  command/tool contracts.
- Read: `packages/cron/src/store.ts`, `packages/cron/package.json`,
  `packages/agent-runtime/src/doc-store/index.ts`,
  `docs/_internal/reviews/consolidation-agenda.md`,
  `docs/_internal/proposals/substrate-sequencing.md`.
- Tests: `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`;
  `npm --workspace @sparkwright/cron run typecheck`; `npm run
check:package-boundaries`; `npm run check:workspace-lock`.

- Status: Read-only
- Date: 2026-07-06T14:45:00+0800
- Scope: C9 S1 migration touched task-notification persistence only. Cron state,
  `CronStore`, cron tool schemas, scheduler semantics, and cron run success
  derivation are unchanged; `packages/cron/src/store.ts` remains a named
  remaining atomic-write migration candidate.
- Read: `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/doc-store/index.ts`,
  `packages/cron/src/store.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`.
- Tests: cron-specific behavior not run separately; storage-focused
  `npm --workspace @sparkwright/agent-runtime test -- test/doc-store.test.ts
test/tasks.test.ts` and `npm --workspace @sparkwright/agent-runtime run
typecheck` passed.

- Status: Read-only
- Date: 2026-07-05T23:09:50+0800
- Scope: workflow-runtime-v1 P9a D5 routed-page check: workspace-root workflow
  run storage does not change cron state, cron tool schemas, scheduler
  semantics, or cron run success derivation.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: not run for cron-specific behavior; P9a made no cron semantic change.

- Status: Read-only
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 routed-page check: bounded
  `parallel` / `join` does not change cron state, cron tool schemas,
  scheduler semantics, or cron run success derivation.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: not run for cron-specific behavior; P5 made no cron semantic change.

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a routing check for
  `packages/host/src/runtime.ts`: actor episode driver inversion does not
  change cron state, cron tool schemas, scheduler semantics, or cron run
  success derivation.
- Read: `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: not run for cron-specific behavior; Step 4a made no cron semantic
  change.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 routing check for
  `packages/agent-runtime/src/workflows/*`: durable workflow records do not
  change cron store, cron tool, scheduler, or capability-inspection contracts.
- Read: `packages/agent-runtime/src/workflows/store.ts`,
  `packages/cron/src/store.ts`,
  `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: not run for cron capability flows; P2 made no cron behavior change.

- Status: Read-only
- Date: 2026-07-04T23:10:33+0800
- Scope: routed S1 document-store check for `packages/agent-runtime/src/*`;
  cron contracts and `CronStore` persistence are unchanged in this phase. The
  `cron/src/store.ts` atomic-write copy remains a named future migration
  candidate after the first rule-zero migration in `FileTaskStore`.
- Read: `packages/agent-runtime/src/doc-store/index.ts`,
  `packages/agent-runtime/src/tasks/file-store.ts`,
  `packages/cron/src/store.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: not run for cron capability flows; storage-focused coverage was
  `npm --workspace @sparkwright/agent-runtime test -- test/doc-store.test.ts
test/tasks.test.ts` and `npm --workspace @sparkwright/agent-runtime run
typecheck`; plus full `npm --workspace @sparkwright/agent-runtime test` and
  `npm --workspace @sparkwright/agent-runtime run build`.

- Status: Verified
- Date: 2026-06-29T22:55:26+0800
- Scope: fixed cron tick aggregates so mixed successful/failed due jobs report
  successful completions and failures separately, and CLI tick exits non-zero
  when a due job fails.
- Read: `packages/cron/src/scheduler.ts`, `packages/cron/src/runner.ts`,
  `packages/cron/src/store.ts`, `packages/cron/src/schedule.ts`,
  `packages/cron/test/schedule.test.ts`, `packages/cli/src/cli.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/test-map/failures/cron-tick-aggregate-miscounts-failed-jobs.md`.
- Tests: `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`;
  `npm --workspace @sparkwright/cron run build`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "cron tick has a failed job"`;
  `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-06-26T01:00:00+0800
- Read: `packages/cron/src/tool.ts` (remove-family field usage + idempotency
  description), `packages/core/src/run-outcome.ts`,
  `packages/cron/src/runner.ts`, `packages/cron/src/scheduler.ts`,
  `packages/cron/src/service.ts`, `packages/cron/src/tool.ts`,
  `packages/cron/src/store.ts`, `packages/cron/src/schedule.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/cli/src/cli.ts`, `packages/tui/src/lib/create-capability.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cron/test/schedule.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/tui/test/create-capability.test.ts`.
- Tests: `npm --workspace @sparkwright/cron run build`;
  `npm --workspace @sparkwright/cron test`;
  `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`;
  `npm --workspace @sparkwright/cron run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "cron create|cron status|adjusts a duplicate name"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui test -- test/create-capability.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npx prettier --check packages/agent-runtime/src/index.ts packages/agent-runtime/test/index.test.ts packages/cron/src/service.ts packages/cron/test/schedule.test.ts packages/cli/src/cli.ts packages/cli/test/cli.test.ts packages/tui/src/lib/create-capability.ts packages/tui/test/create-capability.test.ts`.
