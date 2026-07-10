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
- Project commands and shell sandbox packages are edge helpers consumed by TUI,
  host, CLI, and MCP/shell paths. Route safety-sensitive changes through shell
  and workspace-write maps.
- IM gateway is an application bridge over `sdk-node` and host events. Route
  protocol shape changes through protocol/host maps before updating gateway
  renderers or state.

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
- `@sparkwright/server-runtime` is the intended home for future session
  coordination primitives (`SessionTurnScheduler`, turn/run-chain,
  run/session/approval/event orchestration), but current host/CLI paths do not
  wire it as the main process coordinator; source currently uses host-owned
  per-connection `HostRuntime` directly.
- This page is intentionally read-only coverage from package manifests and
  source exports. It should not be used as the sole authority for behavior.

## Last Verified

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
