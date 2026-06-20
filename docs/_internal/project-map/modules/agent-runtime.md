# Agent Runtime

## Purpose

`@sparkwright/agent-runtime` contains reusable agent-side runtime helpers outside the core run loop: task management, todo ledger supervision, concurrency/worktree coordination, and result protocols.

See also [../maps/capabilities/agents.md](../maps/capabilities/agents.md), [../maps/capabilities/cron.md](../maps/capabilities/cron.md), and [../maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md).

## Main Files

- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/tasks/*`
- `packages/agent-runtime/src/todo/*`
- `packages/agent-runtime/src/concurrency/*`
- `packages/agent-runtime/test/*`

## Owns / Does Not Own

Owns:

- durable task abstractions and task tools
- todo ledger parsing and continuation supervision helpers
- worktree/concurrency coordination utilities
- child/delegate policy helpers used by host integrations

Does not own:

- core run state machine
- host protocol
- model/provider construction
- TUI display state

## Contracts

- Task events are trace-visible through core when executed as tools.
- `task_create` can start external work; read-only task tools inspect state/output.
- Host-owned promoted shell tasks keep durable output in `TaskStore`; host trace
  integration mirrors task output/events without making agent-runtime depend on
  host process runners.
- Todo continuation uses a synthetic goal prefix consumed by TUI replay.
- Agent profile derivation intersects parent/child `use` selectors in the same
  tightening direction as concrete `allowedTools`; `mcp` intersected with
  `mcp:<server>` yields the server selector.
- Spawn helpers project one `MultiAgentFacts` snapshot onto parent-visible
  `subagent.*` lifecycle events: `parentRunId`, `childRunId`, `agentId`,
  `agentProfileId`, `agentName`, `delegateTool`, `entrypoint`, and
  `subagentDepth`.
- `subagent.*` terminal fields (`terminalState`, `stepLimitReached`,
  `truncated`, `stopReason`) are derived from the child run's real `run.*`
  outcome and payload flags; parent emit sites must not set a separate terminal
  state.
- `spawnSubAgent` may receive an explicit approval resolver so configured child
  runs can share the parent host/CLI/TUI approval path without gaining a
  free-form interaction channel.
- `createAgentTool` treats a child result completed with `stepLimitReached` as
  possibly truncated: it returns a warning note and does not store the result in
  the successful delegation cache.

## Consumers

- Host runtime task manager and todo supervisor.
- CLI task commands.
- TUI replay logic that distinguishes continuation goals.

## Change Checklist

- Check host runtime continuation behavior.
- Check TUI replay if todo continuation wording changes.
- Check task CLI and task tools together.
- Keep task output caps and event volume under control.

## Known Debts

- Task/todo behavior spans host, CLI, TUI replay, and trace diagnostics; ownership can be easy to blur.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/agent-runtime/src/index.ts`, `packages/agent-runtime/test/index.test.ts`, `packages/host/src/runtime.ts`, `packages/host/src/delegate-capability.ts`, `packages/host/src/acp-child-agent.ts`, `packages/host/src/external-command-agent.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- index.test.ts`; `npm --workspace @sparkwright/agent-runtime run build`; `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "dynamic spawn_agent|configured in-process delegates write"`.
