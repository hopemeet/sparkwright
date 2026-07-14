# Approvals

## Purpose

Approvals gate risky actions while preserving an audit trail of what was asked,
how it was resolved, and what happened afterward.

See [workspace-writes.md](workspace-writes.md) and [shell.md](shell.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/approval.ts`
- `packages/core/src/approval-policy.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/client-approval.ts`
- `packages/cli/src/cli-approval.ts`
- `packages/tui/src/app.tsx`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/lib/permission.ts`

## Data Flow

```txt
policy requires approval
  -> approval.requested / interaction.requested
  -> CLI/TUI/host resolver
  -> approval.resolved / interaction.resolved
  -> action continues or denial path
```

## Contracts

- `RuntimeContext.requestApproval()` is the run-owned bridge for a tool that
  must prepare an inspectable final effect before authorization. The initial
  Skill consumer uses action `skill.apply`, includes proposal id + revision +
  effect hash and final diff, and persists a receipt before mutation. TUI treats
  it as one-shot (no remembered session rule).

- `approval.requested` carries an id used by protocol `approval.resolve`.
- `approval.resolved` preserves optional resolver `message` and structured
  `autoApproved` state; trace summary/report diagnostics should not rely on
  message prose for new traces.
- Approval denial does not automatically mean run cancellation.
- Repeating a denied same-target tool request does not convert the denial into
  an unexpected tool failure. The repeated-tool guard preserves
  policy/approval-denial semantics for diagnostics and run outcome, while the
  original approval/policy event remains the audit source.
- Pending approval UI should key by approval/request identity.
- `shouldWrite: false` keeps a hard-deny write gate before approval. Interactive
  clients that need write approvals should start write-enabled runs
  (`shouldWrite: true`) and rely on `permissionMode` plus normal approval
  policy for auto/manual responses.
- Host freezes resolved access fields into a run-local security plan before
  assembling policies and process capabilities. This does not share the Core
  mutation policy: approval state and `writtenPaths` remain newly constructed
  for each run.
- Trace verification checks that resolutions do not exceed requests.
- `approvals.cronMode` is a config default for cron command permission mode;
  named approval behavior remains owned by the normal core/host approval path,
  and explicit CLI flags still override the default.
- TUI sends shared `accessMode` at the run boundary; the host projects it to
  core `permissionMode`/`shouldWrite` and clamps it to any project access
  ceiling. Deprecated standalone TUI approval scopes (`approveAll`,
  `approveEdits`, `approveShellSafe`, and config `approvals.*`) do not
  independently auto-resolve TUI prompts; `bypass` and `accept-edits` remain
  auto-answering through their derived core permission modes.
- Ask-mode TUI users may remember an exact recognized approval subject for the
  current session. Rules are client-memory only, installed after a successful
  `approval.resolve`, matched on canonical path or exact tool arguments plus
  shell cwd, and surfaced as structured `autoApproved:true` resolutions.
  Unknown approval shapes remain allow-once/deny only, and concurrent requests
  are queued rather than overwritten. Workflow job connections route their
  approvals through the same controller.
- TUI approval auto-policy is execution-scoped rather than controller-global.
  Each request captures the birth client/session/permission mode and exact
  emitting run id; workflow requests also retain their workflow id when known.
  Client terminal/disconnect/close cleanup removes its active and queued
  requests without deleting prompts owned by other clients.
- Host run access resolution also clamps `backgroundTasks` against project
  ceilings. This is governance, not an approval prompt: cap/policy denials for
  background task surfaces are recoverable tool failures rather than
  `approval.requested` events.
- Configured in-process delegate child runs share the host approval resolver
  with the parent run, so child workspace-write and shell gates still resolve
  through the same CLI/TUI approval and trace path. They do not receive an
  interaction channel for arbitrary user questions.
- Dynamic `spawn_agent` and host `task_create(kind:"agent")` can request a
  spawn-time workspace-write grant through `grant.workspaceWrite: true` or an
  explicit managed write tool in `allowedTools`. The parent tool approval uses
  a grant-aware summary and write side-effect governance; once approved, the
  child gets a scoped resolver that auto-approves only child
  `workspace.write` requests. The child does not prompt the user again for the
  same grant, and grant consumption cannot approve unrelated tool execution or
  shell access.
- Read-confidentiality denials are policy denials, not approval prompts.
  `workspace.read.denied` plus `tool.failed` `READ_SCOPE_DENIED` is the audit
  path; a model may continue and complete the run without a CLI failure if it
  produces a final answer after the expected denial.

## Consumers

- Host pending approval map.
- CLI flags such as `--yes`, `--yes-edits`, and `--yes-shell-safe`.
- TUI approval layer via host-client approval helpers.
- Trace safety summary and verification.

## Change Checklist

- Check host protocol payloads and TUI controller calls.
- Check non-interactive CLI behavior.
- Check duplicate rendering between `approval.*` and `interaction.*`.
- Keep approval payloads free of secrets.
- Ordinary IM approvals are indexed by Host to execution/session and filtered
  per exact binding. The initiating principal or a binding with `approve` may
  resolve; the first valid resolution wins. Inspect-only subscribers do not
  receive actionable approval payloads. Durable Workflow approvals remain on
  the Workflow channel/control path.
- The initiating principal is transport/auth-derived and immutable across the
  connection handshake. Unauthenticated connections cannot self-bind, and a
  different authenticated credential cannot reuse approval, subscription, or
  cancellation authority even when client name and IM subject claims match.
  New self-bindings always receive a Host-assigned session, so a binding cannot
  gain approval authority by presenting another binding's session id.

## Known Debts

- Approval UX and diagnostic reporting are split across CLI, TUI, host, and core trace.

## Last Verified

- Status: Read-only
- Date: 2026-07-15
- Scope: runtime contract extraction leaves approval resolver ownership,
  timeout, routing, and HostExecution cleanup unchanged.
- Read: runtime contracts, Host runtime, HostExecution, and HostService.
- Tests: Host execution/service/protocol focused suites.

- Status: Verified
- Date: 2026-07-14
- Scope: bound IM approval/subscription/cancel authorization to immutable
  authenticated principals and Host-assigned new-binding sessions while
  retaining exact subject and scoped permission checks.
- Tests: Host IM/protocol focused authorization and replay coverage passed.

- Status: Verified
- Date: 2026-07-14
- Scope: added Host-owned IM approval routing, exact-principal authorization,
  first-writer resolution, subscriber filtering, and finite timeout coverage.
- Tests: Host IM control 5/5, Host protocol timeout/binding coverage, Gateway
  approval routing, and full Host suite 571/571.

- Status: Verified
- Date: 2026-07-14
- Scope: live Host approval waiters remain execution-owned, are denied on
  cancellation, and now have a finite timeout; durable Workflow waits remain
  separate.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked Host security-plan extraction; access values are reused within
  one run, while approval routing and Core per-run mutation-policy state remain
  unchanged.
- Read: Host run access/security plan/runtime and Core policy construction.
- Tests: Host focused suite 222/222; Host typecheck passed.

- Status: Read-only
- Date: 2026-07-12T20:00:00+0800
- Scope: checked Markdown Agent exact-file validation and legacy removal route;
  both continue through the existing workspace-write approval boundary.
- Read: host Agent tool and capability write helper.
- Tests: focused tool tests and full release gate; no approval contract change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Markdown Agent final-write approval; reconciliation remains outside managed approval semantics.
- Tests: focused host tests passed; release gate pending.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: one final-effect-bound `skill.apply` approval after proposal
  persistence, rendered with the final diff and consumed in the same run.
- Read: `packages/core/src/run.ts`, `packages/core/src/types.ts`,
  `packages/host/src/skill-evolution.ts`, `packages/host/src/tools.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/approval-prompt.tsx`.
- Tests: host same-run integration, revision/crash recovery, TUI approval
  render/controller suites, and affected typechecks.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Package A immutable TUI approval execution context and per-client
  active/queued prompt cleanup.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/test/run-controller-approval.test.ts`.
- Tests: focused approval/session-mutation suites, full TUI suite (398 tests),
  and TUI typecheck.

- Status: Verified
- Date: 2026-07-11T01:04:00+0800
- Scope: TUI session approval rules and queued approval routing, including
  approvals arriving on workflow job host connections.
- Read: `packages/tui/src/lib/session-approval.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/approval-prompt.tsx`, host approval helpers.
- Tests: focused TUI approval/unit/render suites and SDK cutover; full
  `npm run release:check` on the same source tree.

- Status: Verified
- Date: 2026-07-08T23:46:48+0800
- Scope: post-review grant approval hardening: `spawn_agent` and
  `task_create(kind:"agent")` workspace-write grant summaries now identify the
  child, parent run-loop tests prove approval happens before child/task
  creation, bypass-style resolvers record auto-approved grants, denial prevents
  creation, and read-only parent policy denies write-side-effect grant requests
  before approval.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/host/test/tools.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/spawn-agent.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`.

- Status: Verified
- Date: 2026-07-08T14:42:08+0800
- Scope: dynamic `spawn_agent` and `task_create(kind:"agent")` workspace-write
  grants use argument-dependent approval summaries at the parent tool gate and
  child-local scoped approval resolvers for `workspace.write` consumption.
- Read: `packages/core/src/run.ts`, `packages/core/src/tools.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`.
- Tests: `npm test -w @sparkwright/core -- run.test.ts`;
  `npm test -w @sparkwright/host -- tools.test.ts spawn-agent.test.ts`;
  typechecks for core, agent-runtime, and host.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow nested help exits before config/model/host setup, so it does
  not enter approval policy or pending approval flows. Approval request,
  resolution, and denial semantics are unchanged.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"workflow nested help|nested command help"`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② routed-page check: confidential read denials remain policy
  denials and do not introduce approval requests or approval resolver changes.
- Read: `packages/core/src/policy.ts`, `packages/core/src/run-outcome.ts`,
  `packages/host/src/runtime.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts
test/workspace.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "confidential"`.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: `workflow shadow` is an
  offline trace/asset report and does not start runs, request approvals, change
  run access fields, or execute workflow command/script nodes.
- Read: `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: not run for approval-specific behavior; P8a made no approval semantic
  change. Focused shadow gates passed in host/CLI.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 routing check: `workflow resume` reuses normal
  host run access/approval fields and single-writer workflow leases, but adds
  no new approval request/resolution semantics.
- Read: `packages/host/src/runtime.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/src/cli.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: not run for approval-specific behavior; P2 made no approval semantic
  change.

- Status: Verified
- Date: 2026-07-02T21:55:07+0800
- Scope: repeated-tool guard diagnostics preserve approval/policy-denial
  semantics without changing approval request/resolution behavior or write-gate
  ordering.
- Read: `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: run access governance now includes `backgroundTasks` clamping, while
  background-task policy denials remain tool-level recoverable failures instead
  of approval prompts. Existing approval request/resolution semantics did not
  otherwise change.
- Read: `packages/core/src/access-mode.ts`,
  `packages/host/src/run-access.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/access-mode.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts
test/config.test.ts -t "background task policy|backgroundTasks|accessMode"`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after `shell` -> `bash` canonicalization; approval semantics
  did not change, and shell approval matching now accepts canonical and legacy
  names.
- Read: `packages/core/src/approval-policy.ts`,
  `packages/host/src/shell.ts`, `packages/tui/src/components/approval-prompt.tsx`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/tool-request-preview.test.ts`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: fixed read-only access-mode approval semantics at the policy layer:
  explicitly safe tools with read-only/no-op governance no longer request
  approval in plan mode, while metadata-incomplete tools, write gates, and
  risky tool approvals remain intact across CLI and TUI.
- Read: `packages/core/src/policy.ts`,
  `packages/core/test/policy.test.ts`,
  `packages/host/src/tools.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/tui/test/sdk-cutover.test.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts test/access-mode.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts test/permission.test.ts`;
  real mini CLI read-only trace `session_mqxrirn46qlht3xf` and TUI read-only
  trace `session_tui_mqxrn5zz` verified with 0 approvals and 0 writes.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: `accessMode` projection to `permissionMode`/`shouldWrite`, project
  ceiling clamp, and TUI runtime mode approval behavior.
- Read: `packages/core/src/run.ts`, `packages/core/src/policy.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/src/client-approval.ts`,
  `packages/tui/src/components/approval-prompt.tsx`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/lib/permission.ts`, `packages/host/src/run-access.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/access-mode.test.ts`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm run schema:check`; `npm run build`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-08T20:41:34+0800
- Scope: approval access consolidation preserved `ask` and `bypass` as
  user-facing access presets and kept legacy `permissionMode` fields for
  compatibility. New helper surfaces centralize client-side access projection;
  `capability.inspect` uses scoped diagnostics only and does not grant or
  remove approval authority.
- Read: `packages/host/src/run-access.ts`,
  `packages/host/src/client-run.ts`,
  `packages/cli/src/run-access.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/lib/permission.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/client-run.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli-approval.test.ts test/entry-parity.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/permission.test.ts`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts test/protocol.test.ts -t "capability inspect|capability inspection|capability inspect payloads"`.
