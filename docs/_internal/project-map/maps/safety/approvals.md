# Approvals

## Purpose

Approvals gate risky actions while preserving an audit trail of what was asked,
how it was resolved, and what happened afterward.

See [workspace-writes.md](workspace-writes.md) and [shell.md](shell.md).

## Last Verified

- Status: Verified
- Date: 2026-07-26
- Scope: detailed transcript mode is no longer a LayerStack route. Approval
  remains the highest typed route and replaces the visible operation/input
  surface while App retains the transcript mode and semantic anchor; closing
  the approval returns to the same transcript context.
- Read: App owned viewport, LayerStack route order, LayerRenderer approval
  branch, and layer/viewport tests.
- Tests: layer priority, viewport anchor, approval render, and PTY interaction
  coverage passed.

- Status: Verified
- Date: 2026-07-25
- Scope: route review for Agent action receipts and detailed TUI projection.
  Approval admission, prompt priority, remembered decisions, principal
  attribution, and denial visibility are unchanged; approvals remain visible
  above the details layer.
- Read: Agent Runtime receipt derivation, Host approval boundary, and TUI typed
  layer order.
- Tests: Host 583/583 and TUI 482/482.

- Status: Verified
- Date: 2026-07-25
- Scope: Shell remembered approvals now key exact command, resolved cwd,
  background flag, and lifetime; `foregroundTimeoutMs` no longer fragments an
  otherwise identical authorization. The prompt displays that execution mode,
  uses the runtime principal rather than execution kind as origin, and renders
  policy/tool/safety explanations as three separate layers.
- Read: Core approval/tool policy contracts, Shell subject/policy producer,
  Protocol/Host projection, TUI coordinator/session/prompt, and tests.
- Tests: full `npm run release:check` passed, including Shell 44/44, Host
  583/583, TUI 468/468, the 16-case regression matrix, and install smoke.

- Status: Verified
- Date: 2026-07-24
- Scope: every approval is now scoped by runtime-owned
  `ApprovalPrincipal`; reusable TUI decisions key session + principal + effect
  subject. Dynamic/configured children get distinct child-run principals and
  never inherit a parent's concrete approval. Workspace subjects distinguish
  create/replace/edit/remove and deprecated legacy writes.
- Read: Core approval/workspace principals, Host interaction routing,
  Protocol DTOs, TUI rule storage/projection, and focused tests.
- Tests: focused Core/Host/TUI approval suites, repository build, and
  repository test typecheck passed.

- Status: Verified
- Date: 2026-07-23
- Scope: Host IM task delivery reuses exact runtime/binding/session
  authorization and a task-specific idempotency key. It does not consult
  model-authored recipient metadata or modify approval routing, permission
  selection, resolution, or visibility; approval deliveries retain their
  existing initiating-principal/approve-permission checks.
- Read: Host IM association, task session guard, delivery visibility, approval
  route, Gateway delivery renderer, and focused/full Host tests.
- Tests: Host 604/604 including existing approval suites, IM Gateway 10/10,
  focused lifecycle/IM 25/25, and affected package typechecks passed.

- Status: Verified
- Date: 2026-07-23
- Scope: route review for bounded `task.updated` events. Events contain
  Host-resolved routing plus safe task summaries and do not add authority;
  approval subjects, decisions, and reuse semantics are unchanged.
- Read: task lifecycle projection, Host routing, and approval boundary.
- Tests: Host projection/protocol coverage, typechecks, and schema validation
  passed.

- Status: Verified
- Date: 2026-07-23
- Scope: route review for Task/Shell/Agent completion receipts; approval
  subjects, resolution, policy ordering, and remembered-decision semantics did
  not change.
- Read: task_create/Shell/spawn policy boundaries and approval map contracts.
- Tests: focused Host tools/spawn suites, Shell suite, and typechecks passed.

- Status: Verified
- Date: 2026-07-23
- Scope: repeated-failure state now carries retry scope, but policy and approval
  denials are always target-level and retain their existing expected-denial
  recovery semantics. Project instructions and Direct Core identity explicitly
  do not grant access; structured policy/approval remains authoritative.
- Read: Core failure classification/repeat metadata, project/direct prompt
  wording, approval gate, and existing denial regressions.
- Tests: focused Core run/context and affected package/typecheck suites passed;
  approval request/resolution behavior is unchanged.

- Status: Verified
- Date: 2026-07-21
- Scope: dynamic Agent handoff now uses explicit goal/context fields, but
  authorization remains derived only from structured tools and grants. Approval
  subjects, timing, reuse, denial, and cleanup are unchanged.
- Read: Host shared Agent schema/validator, Agent grant producer, and Core
  approval ordering.
- Tests: focused Host spawn/task/tool and affected approval tests passed.

- Status: Verified
- Date: 2026-07-21
- Scope: every approval request carries a producer-authored typed subject.
  Workspace writes distinguish write/remove by canonical path, Shell keys the
  exact command/cwd/execution settings, Agent grants key the exact structured
  grant, and unrecognized effects are one-shot only. TUI no longer infers
  reusable authority from display details; duplicate delivery is idempotent
  and automatic resolution failure returns to a visible manual decision.
- Read: Core approval/tool/workspace contracts, Shell and Agent producers,
  Protocol/Host projection, TUI coordinator/session rules/prompt, and fixtures.
- Tests: focused Core, Streaming Runtime, Shell, Agent Runtime, Host, Protocol,
  SDK, CLI, IM, ACP, and TUI approval tests and typechecks passed.

- Status: Verified
- Date: 2026-07-21
- Scope: dynamic spawn validates its structured enabled-tool/grant contract in
  Core's semantic input stage before approval. Goal/context text is not an
  authorization input, so negated execution wording cannot create a doomed
  workspace-write approval.
- Read: Core tool validation/policy order, Host dynamic spawn/grant assembly,
  Agent Runtime result status contract, and focused/full tests.
- Tests: Agent Runtime 240/240, Host 589/589, and repository test typecheck.

- Status: Verified
- Date: 2026-07-20
- Scope: TUI approval coordination now has one execution-scoped owner and a
  client-free view model. Exact allow-once/session/deny behavior, Host policy,
  main/Workflow isolation, queueing, and session-rule subjects are preserved;
  the decision UI adds origin, risk, scope, progress, pageable effects, safe
  default focus, and local resolve-error state.
- Read: Host/Protocol approval boundaries, TUI controller/coordinator/view
  model/renderers, session rules, layer routing, test-only concurrent Host
  adapter, and focused/full tests. Cleanup now also invalidates an in-flight
  failed session-rule auto-resolution so it cannot requeue a dead execution.
- Tests: TUI 447/447 and Host 594/594; focused coordinator/adapter regressions;
  real 80/96/120-column PTY approval scenarios plus a 96x32 concurrent waiter
  capture that advanced from `1 of 2` to `1 of 1`.

- Status: Verified
- Date: 2026-07-19
- Scope: reviewed approval consumers after assessment and target-scope changes.
  Explicit targets still narrow policy; absence of `--target` no longer
  invents `README.md`. Approval evaluation remains the same canonical tool
  decision stage and expected denials are recorded as degraded issues.
- Read: CLI target contracts, Core assessment/policy, Host tool assembly, and
  protocol/TUI approval surfaces.
- Tests: Core policy/run, Host protocol/tools, and CLI target regressions passed.

- Status: Verified
- Date: 2026-07-19
- Scope: Host approval channel construction, finite timeout, waiter
  registration, `approval.requested` delivery, response metadata, disconnect
  denial, and drain cleanup moved intact to
  `ExecutionInteractionOperations`. Live waiters remain stored only in
  HostExecution; policy ordering and audit payloads are unchanged.
- Read: Core interaction/approval contracts, Host interaction owner and
  HostExecution, protocol/IM resolution routes, and focused tests.
- Tests: owner-level, Host protocol/service, SDK, CLI, and TUI approval routes
  are recorded with the commit.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: CLI reference EventLog import moved to Core `/internal`; interaction,
  approval policy, resolution, and audit contracts are unchanged.
- Read: CLI consumer and Core public/internal boundary.
- Tests: CLI outcome 23/23 and affected typechecks passed.

- Status: Verified
- Date: 2026-07-17T11:02:45+0800
- Scope: `InteractionChannel` is now the required-method, approval-only Core
  outbound boundary. Question/notification DTOs and RunHandle helpers were
  removed without changing approval policy ordering or audit events.
- Read: Core interaction/run/workspace paths, Host/CLI/Streaming Runtime
  adapters, interaction tests, and current reference docs.
- Tests: Core interaction/approval 18/18; Host task/approval 12/12; CLI
  approval 4/4; affected package typechecks; repository test typecheck; schema
  check; project-map drift; full release gate.

- Status: Verified
- Date: 2026-07-16T13:36:30+0800
- Scope: Removing `ValidationHook` does not weaken approval ordering: policy still runs before the canonical interaction-channel approval, and managed workspace writes remain approval-gated.
- Read: Core run/workspace policy and approval paths plus focused safety tests.
- Tests: focused approval/workspace tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T13:21:00+0800
- Scope: `InteractionChannel` became the single Core outbound interaction boundary; the direct approval resolver option and adapter bridges were removed.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Date: 2026-07-16T11:52:29+0800
- Scope: reviewed protocol 2.0 terminal failure envelope changes; approval
  request, resolution, and audit contracts are independent of the removed
  `run.failed.error` projection.

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/approval.ts`
- `packages/core/src/approval-policy.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/runtime/host-runtime.ts`
- `packages/host/src/client-approval.ts`
- `packages/host/src/runtime/execution-interaction-operations.ts`
- `packages/cli/src/cli-approval.ts`
- `packages/tui/src/app.tsx`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/state/approval-coordinator.ts`
- `packages/tui/src/lib/approval-view-model.ts`
- `packages/tui/src/components/approval-prompt.tsx`
- `packages/tui/src/lib/permission.ts`

## Data Flow

```txt
policy requires approval
  -> runtime ApprovalPrincipal + producer effect subject
  -> approval.requested / interaction.requested
  -> InteractionChannel.approve (CLI/TUI/Host/Cron)
  -> approval.resolved / interaction.resolved
  -> action continues or denial path
```

## Contracts

- `RuntimeContext.requestApproval()` is the run-owned bridge for a tool that
  must prepare an inspectable final effect before authorization. The initial
  Skill consumer uses action `skill.apply`, includes proposal id + revision +
  effect hash and final diff, and persists a receipt before mutation. TUI treats
  it as one-shot (no remembered session rule).

- `approval.requested` carries an id used by protocol `approval.resolve` plus a
  required typed producer-authored subject. Human-readable summary/details are
  audit and presentation facts, not reusable authorization identity.
- Policy decision, tool approval-gate reason, and tool-specific safety
  classification are separate structured explanation layers. A permissive
  general policy can therefore coexist without contradiction with a shell
  classifier that requires approval.
- Every request also carries runtime-owned principal kind/scope. Remembered
  decisions are reusable only for the same session, principal scope, and
  subject key; child labels and model context cannot alter this identity.
- `approval.resolved` preserves optional resolver `message` and structured
  `autoApproved` state. Trace summary/report diagnostics consume these root
  fields only and do not parse nested responses or message prose.
- Approval denial does not automatically mean run cancellation.
- Repeating a denied same-target tool request does not convert the denial into
  an unexpected tool failure. The repeated-tool guard preserves
  policy/approval-denial semantics for diagnostics and run outcome, while the
  original approval/policy event remains the audit source.
- Pending approval UI should key by approval/request identity.
- `accessMode: read-only` keeps a hard-deny write gate before approval.
  `ask` enables writes with interactive approval, `accept-edits` auto-approves
  managed edits, and `bypass` auto-approves permitted actions.
- Host freezes resolved access fields into a run-local security plan before
  assembling policies and process capabilities. This does not share the Core
  mutation policy: approval state and `writtenPaths` remain newly constructed
  for each run.
- Trace verification checks that resolutions do not exceed requests.
- CLI, TUI, ACP, Cron, and Host send the same `accessMode` at the run boundary;
  Host clamps it to any project access ceiling and derives the run-local
  approval policy. There is no second approval-default input.
- Ask-mode TUI users may remember an exact recognized approval subject for the
  current session. The effect producer, not the TUI, supplies the stable key
  and typed canonical path, Shell command/cwd/execution mode, Agent grant, or
  tool-call identity. Shell foreground timeout is operational timing, not part
  of the remembered authorization key. Rules are client-memory only, installed
  after a successful
  `approval.resolve`, and surfaced as structured `autoApproved:true`
  resolutions. Missing/malformed/one-shot subjects remain allow-once/deny only,
  and concurrent requests are queued rather than overwritten. Workflow job
  connections route their approvals through the same controller.
- TUI approval auto-policy is execution-scoped rather than controller-global.
  Each request captures the birth client/session/permission mode and exact
  emitting run id; workflow requests also retain their workflow id when known.
  Client terminal/disconnect/close cleanup removes its active and queued
  requests without deleting prompts owned by other clients.
- TUI presentation coordination is isolated in `ApprovalCoordinator`.
  `RunController` registers immutable main/Workflow execution origins and the
  coordinator retains the originating SDK client privately; the Ink layer sees
  only `ApprovalViewModel`. Resolving disables duplicate submission, a failed
  resolve keeps the current request and queue position, and successful resolve
  advances exactly one request.
- TUI risk focus is presentation-only and never changes Host policy. High-risk
  and unknown shapes focus Deny; ordinary recognized shapes may focus Allow
  once. Allow-session is never the default, unknown shapes cannot install a
  rule, and Esc/Ctrl+C sends an explicit denied resolution instead of merely
  closing the surface.
- Host run access resolution also clamps `backgroundTasks` against project
  ceilings. This is governance, not an approval prompt: cap/policy denials for
  background task surfaces are recoverable tool failures rather than
  `approval.requested` events.
- Configured in-process delegate child runs receive an approval-only
  `InteractionChannel` from Host, so child workspace-write and shell gates
  still resolve through the same CLI/TUI approval and trace path without
  gaining `ask` or `notify` capabilities.
- Core attaches a runtime-owned `ApprovalPrincipal` to every request. Main,
  dynamic-child, and configured-delegate principals have distinct scopes;
  TUI reusable rules key `sessionId + principalScope + subject.key`, so a
  parent's concrete approval never authorizes a child call.
- Dynamic `spawn_agent` and `task_create(kind:"agent")` expose no grant or
  allowed-tool fields. Their children request approval only when an actual
  revisioned write or child-safe shell effect reaches its normal gate.
  Persisted legacy authority fields are ignored by the handoff normalizer.
- Workspace approval subjects distinguish create, replace, edit, remove, and
  deprecated legacy write operations in addition to canonical path and effect
  scope. Shell subjects remain exact command/cwd identities.
- Read-confidentiality denials are policy denials, not approval prompts.
  `workspace.read.denied` plus `tool.failed` `READ_SCOPE_DENIED` is the audit
  path; a model may continue and complete the run without a CLI failure if it
  produces a final answer after the expected denial.

## Consumers

- Host execution interaction owner over the HostExecution pending approval map.
- CLI `--access-mode` and the TUI runtime access switch.
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

- Status: Verified
- Date: 2026-07-16
- Scope: tool approval metadata and UI/CLI matching use exact callable names;
  `bash` is the only shell-tool identity. Shell risk classification and approval
  resource semantics are unchanged.
- Read: Core run gate/approval policy, Host shell catalog, CLI/TUI approval
  consumers, and focused tests.

- Status: Verified
- Date: 2026-07-16T10:23:51+0800
- Scope: reviewed for removal of the Core revival budget alias; approval
  admission, resolver, and policy boundaries do not consume that run option and
  require no contract change.
- Read: Core run option consumers and approval map contracts.
- Tests: focused Core revival/budget tests 19/19, runtime guardrails 28/28,
  full Core 668/668, and Core typecheck passed.

- Status: Verified
- Date: 2026-07-15T07:35:27+0800
- Scope: expected approval/policy denial classification moved to a pure result
  analysis leaf; resolver ownership, request/resolution order, and approval
  behavior are unchanged.
- Read: Core run approval path and tool-result-analysis.
- Tests: Core run/runtime guardrails and Host protocol/tools.

- Status: Read-only
- Date: 2026-07-15
- Scope: config/doctor read diagnostics moved mechanically; permission,
  approval defaults, resolver, and execution behavior are unchanged.
- Read: CLI config-doctor and facade routing.
- Tests: full CLI golden and config-schema suite.

- Status: Verified
- Date: 2026-07-15
- Scope: configured delegate CLI handler relocation preserves approval option
  mapping, permission mode, write gate, resolver, and Host execution behavior.
- Read: CLI capability command and approval adapter.
- Tests: CLI delegate focused slice and full CLI golden.

- Status: Verified
- Date: 2026-07-15
- Scope: direct-core run-resume handler relocation preserves approval options,
  resolver creation, permission mode, policy, and host-path routing.
- Read: CLI trace-session module, approval adapter, host/direct-core runners.
- Tests: CLI run-resume focused slice and full CLI golden.

- Status: Verified
- Date: 2026-07-15
- Scope: HostRuntime relocation preserves approval routing, timeout, resolver,
  cancellation, and HostExecution cleanup behavior.
- Read: runtime facade, concrete runtime, HostExecution, HostService.
- Tests: Host execution/service/protocol focused suites.

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
- Tests: focused host tests and the 2026-07-15 release gate passed.

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
  `packages/host/src/runtime/agent-runtime-assembly.ts`,
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
  `packages/host/src/runtime/agent-runtime-assembly.ts`,
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
  `docs/_internal/reviews/consolidation-agenda.md`.
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
