# Agents Capability

## Purpose

Agent capability lets host-configured profiles, delegate tools, and dynamic
spawned agents participate in a run while preserving parent policy, trace, and
session attribution.

See [../../modules/agent-runtime.md](../../modules/agent-runtime.md) and [../../modules/host.md](../../modules/host.md).

## Main Files

- `packages/host/src/runtime.ts`
- `packages/host/src/agent-profiles.ts`
- `packages/host/src/delegate-runner.ts`
- `packages/host/src/delegate-capability.ts`
- `packages/host/src/external-command-agent.ts`
- `packages/host/src/traced-process-runner.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/concurrency/*`

## Data Flow

```txt
configured profiles/delegates
  -> host derives agent profiles
  -> delegate/spawn tools
  -> child run store factory
  -> session/agent trace attribution
```

## Contracts

- Child/delegate runs must remain trace-visible.
- Parent policy and approval rules shape child workspace/tool access.
- Agent ids are used in session trace metadata and agent-specific files.
- Delegate tools are capability surface, not a hidden second runtime.
- Agent profile create/update/remove tools are managed capability mutations and
  emit `capability.mutation.completed` when the project config change is
  applied.
- `create_agent` create results include a `callable` boolean and `callability`
  detail object. Profiles without an effective delegate tool are inspectable but
  not callable by the main agent; `mode=primary` profiles shape the main run and
  are not eligible configured child delegates.
- External ACP and external-command delegates are config-declared agent profile
  metadata exposed through `capabilities.agents.delegateTools`.
- Configured in-process delegates are also exposed through
  `capabilities.agents.delegateTools` with `protocol: "in_process"`, so host
  snapshots, CLI inspect, and TUI capability views use one descriptor source.
  Their descriptor reports profile-selected potential capability, conditional
  approval facts (`approvalRequiredUnderCurrentRun`, `approvalReasons`,
  `approvalRunOptions`), and `gatedByRunWrite` when workspace-write or shell
  access is still behind the parent `--write` gate.
- TUI capability views exclude the built-in primary `main` profile from the
  configured-agent count/list; child/configured profiles and delegate tools
  remain visible.
- Dynamic `spawn_agent` children stay read-only and use the read-only child
  catalog (`read_file`, `glob`, `grep`, `list_dir`).
- Dynamic `spawn_agent` output keeps parent-visible child identity and
  finality separate from tool transport status. A child that reaches its step
  budget after producing an answer can still return a completed tool result, but
  the output must carry `stepLimitReached: true`, `truncated: true`,
  `finality: "partial"`, and a warning-prefixed message so the parent and
  context compaction do not treat the child answer as complete.
- Configured in-process delegates are stable profile-backed children. Host
  expands their `AgentProfile.use` selectors against the configured delegate
  child catalog (workspace read/write coding tools plus `shell` when selected
  in the current runtime surface), intersects inherited selectors and concrete
  `allowedTools`, and passes only the resulting effective tools to the child run
  so prompt descriptors and runtime callability use one tool set.
- Configured in-process delegate child runs share the host approval resolver
  with the parent run for workspace write and shell gates, but keep
  `interactionChannel` unset so delegates do not gain free-form user
  interaction.
- In-process delegate workspace writes are surfaced to the parent run-end
  summary by rolling up the child run's own `workspace.write.completed` events
  onto the parent-visible `subagent.completed`/`subagent.failed` payload
  (`workspaceWrites` count), bridged in `spawnSubAgent`. This replaced an earlier
  parent-side full-workspace filesystem snapshot diff: rollup keeps a single
  source of truth (the child's write events), attributes writes to the actor
  that made them (no time-window misattribution under concurrency), and avoids
  representing one change as two event families. It is sound because the delegate
  child catalog has no untracked writer — `shell` rolls back unmanaged file
  mutations and the child catalog excludes MCP; if MCP is ever added to the
  delegate child catalog, wrap those MCP tools inside the child instead.
  The CLI summary counts `workspaceWrites` via `summarizeWorkspaceMutations`
  (`subagentWrites`).
- `capabilities.agents.maxDepth` is a global nested-spawn ceiling enforced
  before dynamic children, LLM child delegates, ACP delegates, and
  external-command delegates start, including the CLI `delegates run`
  entrypoint. Undefined `maxDepth` still means no configured ceiling.
  Sub-agent lifecycle metadata carries `subagentDepth`, `agentId`,
  `delegateTool`, `entrypoint`, and consistent parent/child run ids for the
  shared depth budget and trace tree.
- External command delegates keep `subagent.*` as their parent-facing lifecycle
  and use `TracedProcessRunner` with `emitLifecycle: false` for shared process
  output, sandbox fallback, timeout, and artifact handling. When a read/write
  external command delegate is granted direct workspace access it emits an
  untracked write-capable marker, not managed write events.

## Consumers

- Host runtime.
- CLI delegates/capability inspection.
- Trace/session diagnostics.

## Change Checklist

- Check parent-child trace attribution and run store paths.
- Check approval-on-spawn and workspace access rules.
- Check capability snapshot and CLI output.
- Check session consistency for subagent lifecycles.

## Known Debts

- Multi-agent semantics are still edge/composition behavior, not fully absorbed core primitives.
- Audited MCP and shell filesystem snapshots remain O(tree) when enabled (the
  in-process delegate path no longer snapshots — it rolls up child write
  events); MCP stdio servers outside the workspace skip snapshots unless args
  reference workspace paths, but large repositories may still need scoped roots
  or mtime prefilters.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/host/src/runtime.ts`, `packages/core/src/context.ts`, `packages/core/src/context-dedup.ts`, `packages/host/test/spawn-agent.test.ts`, `packages/core/test/context.test.ts`, `packages/core/test/runtime-guardrails.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts`; `npm --workspace @sparkwright/core test -- test/context.test.ts test/runtime-guardrails.test.ts`.
