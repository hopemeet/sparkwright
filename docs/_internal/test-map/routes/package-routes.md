# Package Routes

Use this page after project-map identifies the touched package/file. Routes are
focused defaults, not a substitute for judgment. Broaden when a change crosses
contracts, public schema, package exports, or generated `dist`.

## Core

### `packages/core/src/index.ts`, `internal.ts`, or public/internal export routing

Run:

```bash
npm --workspace @sparkwright/core test -- test/interfaces.test.ts
npm --workspace @sparkwright/core run build
npm run check:internal-imports
npm run check:package-boundaries
npm run check:dist-fresh
```

Then typecheck/build every workspace moved between the public and internal
entrypoints and run its focused tests. Assert removed implementation names are
absent from the root module and present under `/internal`; import-only source
changes can still fail at runtime when an upstream `dist` barrel is stale.

### `packages/core/src/workspace.ts` or `workspace-checkpoint.ts`

Run:

```bash
npm --workspace @sparkwright/core test -- test/workspace.test.ts test/workspace-checkpoint.test.ts test/policy.test.ts
npm --workspace @sparkwright/core run typecheck
```

Sensitivity:

- Cover symlinks that escape the workspace and symlinks whose targets remain
  inside it; realpath containment alone does not distinguish the latter.
- Nonexistent descendants and the workspace root have different semantics.
  Do not replace focused cases with one generic path-helper assertion.
- Exercise approval-driven `waiting_approval -> running` changes through the
  required run-owned state port; standalone workspace tests must provide a
  deliberate test port rather than depending on direct `RunRecord` mutation.

### `packages/core/src/run.ts`

Run:

```bash
npm --workspace @sparkwright/core test -- test/run.test.ts
npm --workspace @sparkwright/core test -- test/runtime-guardrails.test.ts
```

Broaden to `test/trace.test.ts` when run terminal payloads, tool outcomes,
verification summaries, or trace snapshots change.

Apply the same route to `packages/core/src/runtime/tool-result-analysis.ts` and
add Host protocol/tools downstream tests. The leaf must not receive a mutable
run-state bag or import the `run.ts` facade.

### `packages/core/src/user-hooks.ts`

Run:

```bash
npm --workspace @sparkwright/core test -- test/user-hooks.test.ts
npm --workspace @sparkwright/core run typecheck
npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
npm --workspace @sparkwright/host run typecheck
```

Assert descriptor identity and configuration source are present on the runner
invocation and every `user_hook.*` lifecycle event. Cover both replay-enabled
late binding and explicit future-only subscription; do not reintroduce an
unsourced descriptor or minimal-emitter fallback.

### `packages/core/src/trace-diagnostics.ts`

Run:

```bash
npm --workspace @sparkwright/core test -- test/trace.test.ts
```

Also run CLI trace fixture tests when text/JSON output changes:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
```

Sensitivity:

- Multi-agent traces use run-local `sequence`; cross-run ordering assertions
  should use trace append order or timeline projection rules.
- Standard trace level folds high-volume progress events.

## Coding Tools

### `packages/coding-tools/src/*`

Run:

```bash
npm --workspace @sparkwright/coding-tools test
npm --workspace @sparkwright/coding-tools run typecheck
npm --workspace @sparkwright/coding-tools run build
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Downstream Host imports coding-tools through package exports, so build the
package before the Host test. Preserve the named `index.ts` facade and reject
implementation-to-facade reverse imports.

## Shell Tool

### `packages/shell-sandbox/src/*`

Run:

```bash
npm --workspace @sparkwright/shell-sandbox test
npm --workspace @sparkwright/shell-sandbox run typecheck
npm --workspace @sparkwright/shell-sandbox run build
npm --workspace @sparkwright/host test -- test/traced-process-runner.test.ts test/external-command-agent.test.ts test/skill-inline-shell.test.ts
npm --workspace @sparkwright/mcp-adapter test
```

Downstream packages import shell-sandbox through `dist`; build it before Host
or MCP tests. Treat current-platform integration as environment-specific and
keep warn/enforce fallback assertions on injected runtimes.

### `packages/shell-tool/src/*`

Run:

```bash
npm --workspace @sparkwright/shell-tool test
```

If the public package export, output schema, timeout/promotion behavior, or cwd
semantics changed, rebuild before downstream tests:

```bash
npm --workspace @sparkwright/shell-tool run build
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Reason: downstream packages import `@sparkwright/shell-tool` through package
exports, which point at `dist`.

## Host

### `packages/host/src/agent-profiles.ts` or Markdown Agent authoring

Run:

```bash
npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts test/tools.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "agent profile id collision|inspect reports inline agent profiles"
npm --workspace @sparkwright/host run typecheck
```

Preserve filename-derived Markdown identity, same-layer basename collision
diagnostics, config-over-Markdown shadowing, exact-file post-write callability,
the model-facing `name`-only authoring schema, and canonical `model: "inherit"`
normalization without a `default` alias.

For `delegate-capability.ts` or `delegate-runner.ts`, also run config/schema and
focused CLI `delegates run|capabilities inspect` slices. Preserve the distinction
between generic delegation targets, model-facing direct aliases, and explicit
user-selected direct execution.

### `packages/host/src/acp-child-agent.ts` or ACP worker launch

Run:

```bash
npm --workspace @sparkwright/acp-client-adapter test
npm --workspace @sparkwright/acp-client-adapter run build
npm --workspace @sparkwright/host test -- test/acp-child-agent.test.ts test/external-command-agent.test.ts test/tools.test.ts
npm --workspace @sparkwright/host run typecheck
```

Assert parent write denial before launch, sandbox enforce failure, private-cwd
behavior, and the untracked-access marker for approved read-write delegates.
Do not require a real installed ACP binary for deterministic focused coverage.

### `packages/host/src/run-access.ts` or `run-security-plan.ts`

Run:

```bash
npm --workspace @sparkwright/host test -- test/run-security-plan.test.ts test/client-run.test.ts test/protocol.test.ts
npm --workspace @sparkwright/host run typecheck
```

Add the capability-inspect route when effective access, sandbox status, or tool
inventory consumption changes. Keep mutable policy-state tests separate: a
frozen security plan must never share Core mutation-policy instances between
runs.

### `packages/host/src/config.ts`, `config/*`, or `config-zod-schema.ts`

Run:

```bash
npm --workspace @sparkwright/host test -- test/config.test.ts
npm run schema:check
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "config|doctor|init|first interactive|capabilities inspect"
npm --workspace @sparkwright/tui test -- test/config.test.ts
```

Use `npm run schema:generate` instead when the generated schema artifacts are
intended to change, then run `npm run schema:check`.

If `CapabilitySnapshot` or inspect output changed, also run:

```bash
npm --workspace @sparkwright/protocol run build
npm --workspace @sparkwright/host run build
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
```

### `packages/host/src/shell.ts`

Run:

```bash
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Also run shell-tool tests when behavior belongs to command parsing, path scope,
foreground timeout, promotion, or shell output schema.

### `packages/host/src/runtime.ts` or `packages/host/src/runtime/*`

Run the focused suite matching the changed surface:

```bash
npm --workspace @sparkwright/host test -- test/protocol.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts
npm --workspace @sparkwright/host test -- test/config.test.ts
```

Broaden to CLI/TUI tests when capability snapshots, protocol responses, or
run summaries change.

For `runtime/contracts.ts`, also run Host execution/service and the import graph
gate; coordinator ports must not derive their signatures from `HostRuntime`
class methods.

For `host-service.ts`, `server.ts`, or runtime construction/admission changes,
also run:

```bash
npm --workspace @sparkwright/host test -- test/host-service.test.ts test/task-revival.test.ts test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/sdk-node test -- test/round-trip.test.ts
npm --workspace @sparkwright/host run typecheck
npm --workspace @sparkwright/sdk-node run typecheck
```

Assert that `HostService.createRuntime()` is the only `new HostRuntime()` site,
ordinary start/resume/inject/cancel always traverse its lane coordinator, and
connection adapters receive the existing process service rather than creating
one per connection.

For `runtime/task-runtime-operations.ts` or `runtime/task-projections.ts`, run:

```bash
npm --workspace @sparkwright/host test -- test/task-revival.test.ts test/host-service.test.ts test/protocol.test.ts
npm --workspace @sparkwright/host run typecheck
```

Keep TaskManager/store/outbox ownership in `WorkspaceContext`; Task runtime
operations own Host protocol/control, output polling, revival, and resume
orphan handling, while projections remain stateless.

For `runtime/workflow-runtime-operations.ts`, run:

```bash
npm --workspace @sparkwright/host test -- test/workflow-runtime-operations.test.ts test/workflows.test.ts test/workflow-hooks.test.ts test/protocol.test.ts test/host-service.test.ts
npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts test/workflow-control.test.ts test/workflow-channels.test.ts test/workflow-workers.test.ts
npm --workspace @sparkwright/server-runtime test -- test/workflow-service.test.ts test/workflow-channel-coordinator.test.ts
npm --workspace @sparkwright/host run typecheck
```

Construct the owner directly for canonical-root, snapshot, notification, and
durable idempotency tests. Preserve WorkspaceContext as the sole adapter
constructor and HostExecution as the sole live execution owner; the operations
owner may request resume only through a narrow HostRuntime execution port.

For `runtime/workflow-episode-runtime.ts`, run:

```bash
npm --workspace @sparkwright/host test -- test/workflow-episode-runtime.test.ts test/workflows.test.ts test/workflow-hooks.test.ts test/protocol.test.ts test/host-service.test.ts
npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts test/workflow-control.test.ts test/workflow-channels.test.ts test/workflow-workers.test.ts
npm --workspace @sparkwright/host run typecheck
```

Construct the owner directly for projection preparation and per-node
model/tool/budget planning. Preserve HostRuntime as the only HostExecution
factory and lane-facing facade; the episode owner receives that exact instance
and must not mirror current execution or active-run state.

For `runtime/agent-runtime-assembly.ts`, run:

```bash
npm --workspace @sparkwright/host test -- test/agent-runtime-assembly.test.ts test/tools.test.ts test/spawn-agent.test.ts test/agent-task-runner.test.ts test/agent-profiles.test.ts test/protocol.test.ts test/acp-child-agent.test.ts test/external-command-agent.test.ts
npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts test/agent-invocation.test.ts test/agent-supervisor.test.ts test/delegation-ledger.test.ts test/result-protocol.test.ts
npm --workspace @sparkwright/host run typecheck
npm --workspace @sparkwright/agent-runtime run typecheck
```

Construct the owner directly to lock configured, indexed, parallel, dynamic,
and background-task surfaces. Preserve the existing process TaskManager and
workspace lease coordinator, the caller-owned parent run reference, HostExecution
as the sole active execution owner, and the generic Host main-catalog admission
boundary.

For `session-queries.ts` or `session-compaction.ts`, run the full Host protocol
file plus Host typecheck. Preserve canonical session/agent run lookup,
checkpoint resume, completed-turn replay, compact artifact anchoring,
compaction audit events, and session inspect/fork behavior. These modules own
session filesystem reads; `HostRuntime` must not grow a second reader or expose
private helpers for tests.

## Agent Runtime

### `packages/agent-runtime/src/tasks/notifications.ts`, `file-notifications.ts`, or `manager.ts`

Run:

```bash
npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts test/workflows.test.ts
npm --workspace @sparkwright/agent-runtime run typecheck
npm --workspace @sparkwright/agent-runtime run build
npm --workspace @sparkwright/host test -- test/task-revival.test.ts test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/host run typecheck
```

When the shared workflow inbox implementation or its direct consumers change,
also run the server-runtime workflow channel coordinator and IM gateway focused
suites. Preserve reliable/lossy capacity behavior, route and identity
validation, durable actor-only fields, invalid-entry diagnostics, restart
ordering, non-consuming readiness, Host result projection, and pending sink
retry classification. Run repository test typecheck and the full release gate
when the durable inbox layout changes.

### `packages/agent-runtime/src/workflows/store.ts` or `journal.ts`

Run:

```bash
npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts
npm --workspace @sparkwright/agent-runtime run typecheck
npm --workspace @sparkwright/host test -- test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/host run typecheck
```

For durable-layout changes, also run repository test typecheck and the full
release gate. Preserve deterministic coverage for generation/revision fencing,
lease takeover, checksum/quarantine recovery, restart list/get/event replay,
and Host resume/control. Tests and product adapters must inspect workflow state
through `FileWorkflowStore`, never by reading journal entry files directly.

## Server Runtime

### Durable workflow channels and adapters

Run:

```bash
npm --workspace @sparkwright/agent-runtime test -- test/workflow-channels.test.ts test/workflow-control.test.ts
npm --workspace @sparkwright/server-runtime test -- test/workflow-channel-coordinator.test.ts test/index.test.ts
npm --workspace @sparkwright/host test -- test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/sdk-core test -- test/client.test.ts
npm --workspace @sparkwright/im-gateway test
npm --workspace @sparkwright/tui test -- test/workflow-actions.test.ts test/sdk-cutover.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"
```

Use deterministic clocks and stable delivery/idempotency keys. Assert that
failed delivery remains retryable, terminal receipt suppresses redelivery, and
two bindings responding to one wait produce one canonical Package D winner.

### `packages/server-runtime/src/workflow-service.ts` or workflow detach/service

Run:

```bash
npm --workspace @sparkwright/server-runtime test
npm --workspace @sparkwright/host test -- test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"
```

Keep service instance/worker heartbeat tests deterministic. Detached success
must be asserted only after durable outcome publication; unavailable/stale
service must fail before creating workflow storage.

## CLI

### `packages/cli/src/run-outcome.ts`

Run:

```bash
npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts
npm --workspace @sparkwright/cli test -- test/run-outcome-consistency.test.ts
```

If terminal text changes, run the specific CLI test slice that renders it.

### `packages/cli/src/cli.ts` or `packages/cli/src/commands/*`

Choose a focused slice first:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "session"
```

Then broaden to the full CLI test file when command parsing or shared helpers
are touched.

For `commands/trace-session.ts`, run all `trace|session|run resume` slices and
the full CLI golden. Assert that the module receives the existing HostService;
it must not create a second one.

For `commands/config-doctor.ts`, run `config|doctor|init|first interactive`
CLI slices, `config-schema.test.ts`, and the full CLI golden. Preserve schema
artifact parity and secret redaction.

### `packages/cli/test/support/*`

Run:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts
npm run typecheck:test
```

Keep real `process.env` mutation inside the sequential CLI suite. New temporary
directories, HTTP servers, MCP fixtures, and process-like resources should
register cleanup with the shared LIFO stack.

## Repository Governance

### import/facade or project-map routing scripts

Run:

```bash
node scripts/check-package-boundaries.mjs
node scripts/check-internal-imports.mjs
node scripts/check-import-graph.mjs
python3 scripts/check-project-map-drift.py
python3 scripts/check-project-map-drift.py --base origin/main
```

The value-import graph is a hard zero-SCC gate. Type-only SCCs are reported as
information and must not grow silently. Workspace manifest discovery follows
the root `workspaces` declarations rather than a package allowlist.

## TUI

### TUI command registry or capability-creation entrypoints

Run:

```bash
npm --workspace @sparkwright/tui test -- test/commands.test.ts test/create-capability.test.ts test/skill-evolution.test.ts
npm --workspace @sparkwright/tui run typecheck
```

Keep generic `/create skill` on the managed proposal service. Removing a slash
surface should also remove its dedicated action, layer, dialog branch, help,
and reference documentation; do not leave a hidden second parser.

### `packages/tui/src/state/run-controller.ts`

For execution identity, approval routing/cleanup, or session mutation guards:

```bash
npm --workspace @sparkwright/tui test -- test/run-controller-approval.test.ts test/run-controller-session-mutation.test.ts test/sdk-cutover.test.ts
npm --workspace @sparkwright/tui run typecheck
```

Broaden to the full TUI suite when controller return values or session/workflow
actions change.

For independent workflow job session identity, also run:

```bash
npm --workspace @sparkwright/host test -- test/client-run.test.ts test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"
```

### Rendering components

For `components/event-stream.tsx`, `components/status-bar.tsx`, or
presentation helpers:

```bash
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts
npm --workspace @sparkwright/tui test -- test/status-bar-render.test.tsx
```

For transcript changes:

```bash
npm --workspace @sparkwright/tui test -- test/transcript.test.ts
```

Rendering tests often use fake stdout. Assert visible invariants, not raw Ink
escape sequences.
