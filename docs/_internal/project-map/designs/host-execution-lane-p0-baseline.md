# Host Execution Lane P0 Baseline

## Purpose

This page records the source-verified pre-refactor ownership and race baseline
for the Host Execution Lane Coordinator work. It is characterization, not a
target contract. Source and tests remain authoritative.

## Production Construction Inventory

`HostRuntime` is constructed directly by these production paths:

- `packages/host/src/server.ts`: one runtime per stdio/WebSocket connection;
- `packages/acp-adapter/src/session.ts`: one runtime per ACP session;
- `packages/acp-adapter/src/agent.ts`: a temporary runtime for capability
  inspection without an ACP session;
- `packages/cli/src/cli.ts`: workflow stop/list/service accept/recover/control,
  workflow supervision, capability inspection, and session inspect/compact;
- CLI interactive execution reaches Host through `packages/cli/src/runners/host-runner.ts`,
  while `--direct-core` deliberately remains a diagnostic Core-only path.

`packages/im-gateway` does not construct `HostRuntime`; it uses the SDK bridge
but currently owns ordinary-session `activeRuns`, queued messages, run targets,
and approval-to-run routing.

## Current Ownership

| Scope | Current owner/facts before P1 | Known problem for target shape |
| --- | --- | --- |
| Process | global workspace lease coordinator; WS listener | no process Host service or execution index |
| Workspace | filesystem stores exist under workspace/session roots | each runtime constructs its own Task manager/store/outbox and Workflow adapters |
| Connection | `HostRuntime`, `active`, `startingRun`, `runChainCancelled`, pending approvals | connection lifetime is also execution/store assembly lifetime |
| Execution | todo/workflow episode loop and resource cleanup are methods/locals of `HostRuntime` | no independent execution identity/completion owner |
| Run | Core run state, event/store facts, command queue, mutable policy | correct canonical altitude, but command acceptance is not terminal-aware |

Existing domain owners remain: `TaskManager` owns Task terminal/cancellation and
notification delivery; Workflow store/supervisor/service own Workflow actor
lifecycle; `AgentSupervisor`/prepared invocation own Agent invocation identity;
`WorkspaceLeaseCoordinator` owns workspace mutation admission; Core owns each
run state machine and canonical event/store facts.

## Characterization Matrix

| Scenario | Current evidence | Classification |
| --- | --- | --- |
| same runtime concurrent start during async assembly | `host/test/protocol.test.ts` rejects exactly one via `startingRun` | intended compatibility until lanes |
| two connections, same `sessionId` | per-connection runtime construction; no shared guard | known missing coordination, P4 target |
| todo multi-episode and root/current/final run ids | Host protocol todo handoff tests and `startWorkflowActorEpisodeChain` | preserve; Core terminal is not execution terminal |
| inject during episode handoff | active run id changes in Host locals | explicit P0 gap; covered when `HostExecution` exposes aliases |
| run terminal versus inject | Core enqueue is unconditional | known bug; P1 atomic acceptance regression |
| cancel versus natural completion/continuation | Core terminal-race tests plus Host `runChainCancelled` | partial fix exists; move to execution abort in P1/P2 |
| disconnect versus continuation | cleanup cancels only current active run and does not set chain cancellation | known bug; P1 regression |
| pending approval then disconnect | `cleanup()` denies all pending approvals | preserve, later move to execution/process interaction owner |
| background Agent Task starts after later prepare | registered runner reads mutable latest `agentSpawnDeps` | known bug; P1 immutable task context regression |
| Workflow waiting versus actor terminal | Workflow projection/service tests distinguish waiting snapshots | preserve |
| Task revival | Core awaited-task revival and Host task-revival suites | preserve |
| child Agent terminal versus interactive terminal | Agent/task tests plus Host episode driver ownership | explicit coordinator integration assertion in P4 |
| ACP/CLI/WS construction and cleanup | construction inventory above plus adapter/CLI/Host suites | migrate together in P3 |

The explicitly deferred P0 gaps are not compatibility promises. Each is tied to
the phase where the needed lifecycle seam first exists, so tests can assert the
target contract without preserving the current bug.

## Dependency Direction

Current manifests permit the target direction: Host depends on
`server-runtime`; `server-runtime` depends on Core and agent-runtime and does
not depend on Host. ACP and CLI depend on Host. IM gateway depends on SDK and
server-runtime, not Host directly. Coordinator code must therefore remain
transport-neutral in server-runtime and receive an opaque driver from Host.

## Last Verified

- Status: Verified
- Date: 2026-07-14T00:00:00+0800
- Read: the Host/runtime/server/main, Core run/session/storage lock,
  agent-runtime workflow/agent/task, server-runtime workflow/convenience,
  ACP, CLI, IM gateway production entrypoints named by the coordinator plan,
  their package manifests, and focused tests.
- Tests: Host protocol characterization (same-runtime async start and two
  connections/same session); Core cancel/terminal/revival command focused
  cases; agent-runtime full Workflow and Task focused suites. All passed.
