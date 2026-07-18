# Edge Packages

## Purpose

This page covers SparkWright packages that are important integration edges but
do not yet have dedicated project-map module pages. Use it to route changes,
then verify behavior in source and the package-specific README/reference docs.

This is not a promise that every edge package is deeply mapped. Promote a
package to its own module page when repeated changes need ownership boundaries,
contracts, and focused checklists that no longer fit here.

## Main Files

- `packages/acp-adapter/src/*`
- `packages/acp-client-adapter/src/*`
- `packages/sdk-core/src/*`
- `packages/sdk-node/src/*`
- `packages/sdk-browser/src/*`
- `packages/provider-ai-sdk/src/*`
- `packages/provider-registry/src/*`
- `packages/server-runtime/src/*`
- `packages/streaming-runtime/src/*`
- `packages/memory-file-store/src/*`
- `packages/project-commands/src/*`
- `packages/shell-sandbox/src/*`
- `packages/trace-perfetto/src/*`
- `packages/im-gateway/src/*`

## Ownership Summary

- ACP packages bridge the host/runtime/protocol world to ACP sessions and
  external ACP workers. Route ACP server changes through host/protocol/session
  maps; route external worker tool changes through agents and tool orchestration.
- `acp-client-adapter` owns ACP worker JSON-RPC, permission rejection, session
  lifecycle, timeout, child termination, and optional prepared-invocation
  cleanup. Host compiles workspace access and sandbox launch before constructing
  the worker; the adapter does not decide filesystem authority.
- SDK packages are host protocol clients. `sdk-core` owns transport-agnostic
  client behavior; `sdk-node` and `sdk-browser` add environment-specific
  transports. Protocol schema and host-client behavior remain the source of
  truth.
- Provider packages adapt external model ecosystems into core `ModelAdapter`
  and model registry shapes. Host model construction, config loading, pricing,
  and capability diagnostics still own product behavior.
- Server, streaming, memory-store, and trace-perfetto packages are reusable
  runtime/storage/diagnostic adapters around core contracts. Treat core events,
  run/session stores, and trace maps as the active contracts.
- `server-runtime`'s `InFlightCommandDispatcher` only coalesces concurrent local
  dispatch of the same command id. Agent-runtime storage and the workflow
  journal remain command/outcome/apply truth; Host remains the adapter that
  assembles a fenced writer and execution behavior. The misleading
  `DurableCommandDispatcher` alias and the parallel `ConnectionHub` /
  `RunManager` / `SessionManager` / `ApprovalBroker` /
  `ServerCapabilityRegistry` / `createServerRuntime` convenience stack have
  been removed; new runtime composition belongs on the canonical HostService
  -> ExecutionLaneCoordinator path.
- `WorkflowSupervisor` coordinates bounded inventory scans, Package C claim
  competition, claimed-adapter invocation, heartbeat, and drain reporting. It
  has no process launcher and is not a daemon; F remains responsible for the
  long-running service carrier.
- Project commands and shell sandbox packages are edge helpers consumed by TUI,
  host, CLI, and MCP/shell paths. `shell-sandbox` owns OS-specific filesystem
  grant compilation plus the availability/enforce/fallback launch decision for
  argv processes; callers still own transport I/O, timeout, shutdown, and trace
  lifecycle. Route safety-sensitive changes through shell and workspace-write
  maps. Its status explicitly distinguishes Linux `bind-allowlist` from macOS
  `deny-list-guard`; `enforce` controls fallback and must not be interpreted as
  a portable workspace allowlist.
- IM gateway is an application bridge over `sdk-node` and host events. Route
  protocol shape changes through protocol/host maps before updating gateway
  renderers or state.
- IM Gateway handshake name is client-type/display metadata only. Host WS
  bearer authentication supplies the stable ordinary-IM principal; Gateway
  platform claims remain exact bounded subject claims and cannot mint Host
  trust or system identity. Gateway also cannot select a session for a new
  self-binding; Host returns the assigned session and reconnect reuses only the
  existing exact binding.

## Does Not Own

- Core run state machine, trace/event schema, or approval policy.
- Host config merge semantics, runtime capability indexing, or model/provider
  selection policy.
- CLI/TUI rendering contracts except where a package is the product surface
  being changed.

## Routing Checklist

- If a protocol payload or host event changes, read [protocol.md](protocol.md),
  [host.md](host.md), and `docs/reference/HOST_PROTOCOL.md`.
- If a provider/model adapter changes, read [host.md](host.md),
  [../designs/multi-model.md](../designs/multi-model.md), and
  `docs/reference/PROVIDER_EDGE.md`.
- If an ACP/external delegate path changes, read [host.md](host.md),
  [agent-runtime.md](agent-runtime.md), and
  [../maps/capabilities/agents.md](../maps/capabilities/agents.md).
- If a shell, sandbox, command interpolation, or unmanaged process boundary
  changes, read [../maps/safety/shell.md](../maps/safety/shell.md) and
  [../maps/safety/workspace-writes.md](../maps/safety/workspace-writes.md).
- If storage, streaming, memory, or trace export behavior changes, read
  [core.md](core.md), [../maps/session/session-store.md](../maps/session/session-store.md),
  and [../maps/trace/raw-trace.md](../maps/trace/raw-trace.md).

## Known Debts

- These packages need focused module pages if their contracts grow beyond edge
  adapters. Highest candidates: ACP, SDK, provider edge, and server/streaming
  runtime.
- `@sparkwright/server-runtime` owns the transport-neutral, in-memory
  `ExecutionLaneCoordinator`: bounded interactive lane queues, in-flight
  idempotency, process capacity, fairness, and opaque execution handoff. It does
  not absorb Workflow/Task/Agent lifecycle ownership, Core events, or workspace
  mutation leases. This is a single-process contract; queues and outcomes are
  not restart-durable.
- Host stdio/WS, ACP, and CLI/Workflow-service production adapters now create
  runtime facades through one process-scoped HostService. The adapters retain
  protocol/transport ownership; workspace Task/Workflow durable owners live in
  Host WorkspaceContext rather than each connection/session facade.
- `serveConnection()` requires that existing HostService. Transport adapters
  cannot silently create a per-connection execution coordinator; SDK/embedded
  fixtures must compose and pass the service explicitly.
- Ordinary IM Gateway traffic now uses typed `im.*` Host control requests.
  Gateway retains platform verification, formatting, inbound message dedupe,
  outbound delivery attempts, and the existing durable Workflow channel
  adapter. It no longer stores active sessions/runs, ordinary message queues,
  canonical run targets, approval routes, or session-routing policy.
- The workflow job session route now stages durable supervisor/worker ownership
  and multi-channel control after session isolation, write fencing, and a typed
  durable workflow control inbox. `server-runtime` owns coordination; IM/Web/API
  gateways remain authenticated adapters and transport delivery stores rather
  than canonical workflow owners.
- This page is intentionally read-only coverage from package manifests and
  source exports. It should not be used as the sole authority for behavior.

## Last Verified

- Status: Verified
- Date: 2026-07-18
- Scope: Host Workflow operations now own orchestration around the existing
  Server Runtime `InFlightCommandDispatcher`; the dispatcher remains
  process-local coalescing only, and Workflow service/channel ownership and
  durable truth are unchanged.
- Read: Host Workflow owner, Server Runtime dispatcher/service/channel paths,
  Agent Runtime control truth, and focused tests.
- Tests: focused Host, Agent Runtime, and Server Runtime Workflow suites passed.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: edge packages use the explicit Core internal entry for reference
  prompt/runtime implementations, while Provider Registry exposes one fallback
  constructor name: `createProviderFallbackChain`.
- Read: Provider Registry export/tests, Agent/Project Context/Streaming/Cron/
  Perfetto consumers, Core package exports, and internal-import governance.
- Tests: Provider 7/7; Agent Runtime 49/49; Project Context 19/19; Streaming
  Runtime 12/12; Cron 20/20; Perfetto 18/18; affected typechecks passed.

- Status: Verified
- Date: 2026-07-17T22:15:00+0800
- Scope: Host edge adapters receive one explicit process HostService;
  serveConnection no longer creates a per-connection service, and SDK
  round-trip fixtures compose the Host through the same canonical entry.
- Read: Host server/main/WS transport, Host package exports, SDK Node
  round-trip fixture, and runtime/service contracts.
- Tests: Host protocol 58/58; SDK Node round-trip 2/2; SDK Node and Host
  typechecks; import graph, package boundary, and internal import gates; full
  `npm run release:check`.

- Status: Verified
- Date: 2026-07-16T13:21:00+0800
- Scope: Streaming Runtime accepts only `InteractionChannel` and no longer resolves a parallel approval option.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Status: Verified
- Date: 2026-07-16
- Scope: SDK Core collection, SDK Node, ACP, and IM Gateway consume Host protocol
  2.0 terminal failures through the single `failure` envelope; no edge adapter
  reads a root error projection.
- Read: protocol exports, SDK collection/round-trip, ACP event/turn mapping, IM
  rendering, and focused integration tests.

- Status: Verified
- Date: 2026-07-16T10:13:52+0800
- Scope: removed the deprecated server-runtime convenience stack and durable
  dispatcher alias after confirming that only package-local compatibility tests
  and README examples consumed them; retained the production lane, Workflow,
  and in-flight dispatch exports.
- Read: server-runtime source exports, package tests/README, all workspace
  source imports, Host lane/workspace-context consumers, and routed run/session
  maps.
- Tests: server-runtime 23/23 focused tests, all downstream typechecks, and the
  full `npm run release:check` gate passed.

- Status: Read-only
- Date: 2026-07-16T08:56:29+0800
- Scope: rechecked edge adapters after retiring the Host Agent-arbiter
  compatibility module; edge ownership and wire contracts are unchanged.
- Read: ACP worker/Host child adapter and canonical Host lease coordinator.
- Tests: focused Host 70/70, Host typecheck, and the full release gate passed.

- Status: Verified
- Date: 2026-07-15
- Scope: Host runtime facade preserves package exports while internal Host
  production callers import the concrete implementation directly.
- Read: Host package index, runtime facade/concrete implementation, server.
- Tests: Host build/typecheck and CLI entry parity/host path.

- Status: Read-only
- Date: 2026-07-15
- Scope: Host runtime contract extraction preserves all package exports and
  downstream edge-package behavior; no edge package source changed.
- Read: Host package index, runtime contracts, and server imports.
- Tests: Host build/typecheck and CLI host-path focused verification.

- Status: Verified
- Date: 2026-07-14
- Scope: checked SDK/Gateway consumers after Host principal isolation. Existing
  wire methods and Gateway reconnect/rebind flow remain compatible; stable
  identity now comes from the Host bearer credential slot, not client name, and
  new ordinary-IM binding sessions are Host-assigned.
- Tests: Host transport/IM/protocol focused suites passed; no Gateway ownership
  or durable Workflow channel change.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 gave in-flight command coalescing its accurate name and isolated
  the legacy server-runtime convenience stack as deprecated compatibility API;
  the execution-lane coordinator remains independent of that stack.
- Read: server-runtime source, tests, README, Host consumers, and coordinator
  proposal.
- Tests: server-runtime 30/30; typecheck/build; Host and edge focused suites.

- Status: Verified
- Date: 2026-07-14
- Scope: migrated ordinary IM control to Host-owned exact bindings,
  subscriptions, approval routing, and bounded replay.
- Read: IM Gateway bridge/gateway/store/Telegram adapter, Host control methods,
  protocol/SDK, and Workflow channel separation.
- Tests: IM Gateway 9/9; Host 571/571; protocol/SDK focused suites; schema and
  affected typecheck/build.

- Status: Verified
- Date: 2026-07-14
- Scope: added the transport-neutral single-process ExecutionLaneCoordinator
  and made HostService its only production interactive assembly caller.
- Read: server-runtime coordinator/tests and Host driver integration.
- Tests: server-runtime 29/29; Host 563/563; full release check.

- Status: Verified
- Date: 2026-07-14
- Scope: migrated Host stdio/WS, ACP, CLI, and Workflow-service carriers to the
  process HostService assembly path without changing their transport contracts.
- Read: edge entrypoints, Host service/context/runtime, package manifests, and
  focused tests.
- Tests: Host 58/58; ACP 15/15; CLI 31 focused; affected typecheck/build.

- Status: Verified
- Date: 2026-07-14
- Scope: kept sandboxed stdio MCP servers without an explicit cwd in their
  writable neutral scratch directory while preserving the Linux read
  allow-list; external fixture/runtime dependencies must be granted explicitly.
- Read: MCP adapter sandbox launch assembly, shell-sandbox positive scope, and
  MCP/CLI/ACP integration fixtures.
- Tests: focused MCP adapter, CLI, ACP, and shell-sandbox suites; CI covers the
  real Linux bubblewrap runtime.

- Status: Verified
- Date: 2026-07-14
- Scope: collapsed overlapping Linux bubblewrap deny mounts to their minimal
  ancestor roots and restored explicit read/write grants after the private
  `/tmp` overlay. The private parent is remounted read-only, and nonexistent
  read-deny targets no longer create host-workspace mount-point artifacts.
- Read: shell-sandbox bubblewrap invocation compiler and platform tests.
- Tests: shell-sandbox 16/16 on Node 20 and Node 22; the CI matrix covers the
  Linux runtime.

- Status: Read-only
- Date: 2026-07-14
- Scope: re-baselined the session coordination proposal after Workflow, Task,
  Agent supervision, and workspace Agent arbitration refactors. Recorded
  `server-runtime` as the future interactive execution-lane coordination home,
  not a universal run-chain or workspace-lock owner.
- Read: `packages/server-runtime/src/index.ts`, Workflow service/supervisor,
  `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/src/workspace-lease-coordinator.ts`, and
  `docs/_internal/proposals/session-agent-host-coordinator.md`.
- Tests: not run; proposal/map-only review.

- Status: Verified
- Date: 2026-07-13T22:30:00+0800
- Scope: verified platform profile compilation and clarified the public status
  contract: Linux is bind-allowlist, macOS is allow-default deny-list guard,
  and enforce means no unsandboxed fallback.
- Read: shell-sandbox status/profile compiler, config schema/guide, and tests.
- Tests: shell-sandbox 14/14; typecheck/build; Host config/schema checks passed.

- Status: Verified
- Date: 2026-07-13
- Scope: ACP workers now accept and clean up Host-prepared sandbox invocations;
  ACP protocol/session ownership remains in the adapter.
- Read: ACP client worker, Host ACP delegate, and shared sandbox launch compiler.
- Tests: ACP client adapter 2/2; Host ACP/delegate/tool suites 122/122;
  typechecks passed.

- Status: Verified
- Date: 2026-07-13
- Scope: centralized resolved filesystem grants and argv sandbox launch
  decisions in `shell-sandbox` without moving process lifecycle ownership.
- Read: shell-sandbox, Host traced/delegate/Skill adapters, and MCP stdio
  transport.
- Tests: shell-sandbox 14/14; Host focused process tests 37/37; MCP 34/34;
  affected typechecks passed.

- Status: Verified
- Date: 2026-07-11T15:30:00+0800
- Scope: Package G server-runtime delivery coordinator, SDK preaccepted-command
  dispatch, and IM workspace binding/outbox polling/authenticated response.
- Read: `packages/server-runtime/src/workflow-channel-coordinator.ts`,
  `packages/sdk-core/src/client.ts`, `packages/im-gateway/src/gateway.ts`,
  `packages/im-gateway/src/adapters/telegram.ts`,
  `packages/im-gateway/src/bin.ts`.
- Tests: server-runtime 15 focused tests, SDK 10, IM 13; affected
  typecheck/build passed.

- Status: Read-only
- Date: 2026-07-11T15:00:00+0800
- Scope: Package G design routes TUI/CLI/agent/IM/Web/API through
  server-runtime binding/delivery coordination, existing workflow notification
  outbox, and Package D commands; gateways retain only transport identity and
  cursor/dedupe state.
- Read: `packages/im-gateway/src/gateway.ts`,
  `packages/im-gateway/src/store.ts`, `packages/im-gateway/src/types.ts`,
  `packages/agent-runtime/src/workflows/notifications.ts`,
  `packages/agent-runtime/src/workflows/control.ts`,
  `packages/server-runtime/src/index.ts`, `packages/host/src/runtime.ts`.
- Tests: not run; design-only source reconciliation after Package F release.

- Status: Verified
- Date: 2026-07-11T14:30:00+0800
- Scope: Package F foreground workflow service carrier, durable handoff/outcome,
  service instance fencing, drain, and embedded Package E supervisor.
- Read: `packages/server-runtime/src/workflow-service.ts`,
  `packages/server-runtime/src/workflow-supervisor.ts`,
  `packages/server-runtime/test/workflow-service.test.ts`,
  `packages/server-runtime/test/index.test.ts`.
- Tests: server-runtime 18 tests plus typecheck/build; Host/CLI focused evidence
  is recorded in the workflow durable-jobs test map.

- Status: Read-only
- Date: 2026-07-11T14:00:00+0800
- Scope: Package F design adjudication keeps server-runtime as the foreground
  service carrier/coordinator, with durable handoff acceptance before honest
  CLI detach; it does not add an orphan process launcher or ownership truth.
- Read: `packages/server-runtime/src/workflow-supervisor.ts`,
  `packages/server-runtime/src/index.ts`, `packages/host/src/server.ts`,
  `packages/host/src/runtime.ts`, `packages/cli/src/runners/host-runner.ts`.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T13:30:00+0800
- Scope: Package E server-runtime workflow supervisor coordination and
  deterministic claim/drain/restart behavior.
- Read: `packages/server-runtime/src/workflow-supervisor.ts`,
  `packages/server-runtime/test/index.test.ts`,
  `packages/agent-runtime/src/workflows/workers.ts`.
- Tests: server-runtime focused tests/typecheck/build and Package E release gate.

- Status: Read-only
- Date: 2026-07-11T13:10:00+0800
- Scope: Package E design adjudication: server-runtime will coordinate worker
  registration/drain/inventory claiming, while the Package C journal claim is
  the only workflow ownership truth and F retains daemon/process lifecycle.
- Read: `packages/server-runtime/src/index.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/journal.ts`,
  `packages/host/src/runtime.ts`, and workflow job review section 8.14.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T13:00:00+0800
- Scope: Package D SDK `controlWorkflow()` adapter and server-runtime local
  durable-command dispatch coalescing boundary.
- Read: `packages/sdk-core/src/client.ts`,
  `packages/server-runtime/src/index.ts`,
  `packages/server-runtime/test/index.test.ts`, `packages/host/src/runtime.ts`.
- Tests: SDK/server-runtime focused tests, typecheck, build, and the full D
  release gate recorded in the workflow durable-jobs test map.

- Status: Read-only
- Date: 2026-07-11T00:00:00+0800
- Scope: routed workflow supervisor/daemon/multi-channel stages through the
  existing server-runtime coordinator and thin-gateway ownership boundaries.
- Read: `packages/server-runtime/src/index.ts`,
  `packages/im-gateway/src/gateway.ts`,
  `docs/_internal/proposals/session-agent-host-coordinator.md`, and workflow job
  session review section 8.
- Tests: not run; documentation-only roadmap convergence.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: SDK edge update for workflow-runtime-v1 P2: `sdk-core` now exposes
  transport-agnostic `listWorkflowRuns()` and `resumeWorkflowRun()` helpers for
  the host `workflow.list` / `workflow.resume` protocol requests.
- Read: `packages/sdk-core/src/client.ts`,
  `packages/sdk-core/test/client.test.ts`,
  `packages/protocol/src/index.ts`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/sdk-core test -- test/client.test.ts`;
  `npm --workspace @sparkwright/sdk-core run build`.

- Status: Read-only
- Date: 2026-06-30T00:10:06+0800
- Scope: updated the session-coordinator proposal debt after v3 clarified that
  server-runtime should coordinate logical session turns/run-chains rather than
  single core runs; verified current host still owns per-connection active
  state and broader `runChainCancelled` semantics while `RunManager.createRun`
  still calls core `createRun()` directly.
- Read: `packages/server-runtime/src/index.ts`,
  `packages/host/src/runtime.ts`, `packages/core/src/run.ts`,
  `packages/core/src/storage-lock.ts`,
  `docs/_internal/proposals/session-agent-host-coordinator.md`.
- Tests: not run; proposal/map-only review.

- Status: Read-only
- Date: 2026-06-29T23:45:00+0800
- Scope: recorded the session-coordinator proposal debt after verifying
  `server-runtime` exports `ConnectionHub`, `RunManager`, `SessionManager`, and
  `ApprovalBroker`, while current host runtime still owns per-connection active
  run state and host/CLI paths do not wire `server-runtime` as the main
  coordinator.
- Read: `packages/server-runtime/src/index.ts`,
  `packages/server-runtime/README.md`, `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`,
  `docs/_internal/proposals/session-agent-host-coordinator.md`.
- Tests: not run; proposal/map-only review.

- Status: Read-only
- Date: 2026-06-27T18:53:34+0800
- Scope: mapped actual workspace packages without dedicated module pages to
  existing project-map routes and public reference docs.
- Read: `package.json`, package manifests under `packages/*`, `README.md`,
  `docs/reference/ARCHITECTURE.md`, `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROVIDER_EDGE.md`,
  `docs/reference/STREAMING_LOOP_REQUIREMENTS.md`,
  `docs/reference/EXTENSION_INTERFACES.md`, source exports/imports for the edge
  package set listed in Main Files, and available package README files.
- Tests: not run; documentation-only routing pass.
