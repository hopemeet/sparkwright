# Tool Orchestration

## Purpose

Tool orchestration governs how model-requested tools are validated, grouped,
policy-checked, approved, executed, traced, and summarized.

See [../safety/workspace-writes.md](../safety/workspace-writes.md), [../safety/shell.md](../safety/shell.md), and [../../modules/coding-tools.md](../../modules/coding-tools.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/tool-orchestration.ts`
- `packages/core/src/tools.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/toolset.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`

## Data Flow

```txt
model tool calls
  -> host tool catalog assembly
  -> CLI diagnostic catalog profile for direct-core/cron when not using a live host
  -> validation/gating
  -> tool.batch/tool.requested events
  -> policy and approval where needed
  -> tool execution
  -> tool.completed/tool.failed
  -> model observation + trace summaries
```

## Contracts

- Tool requests are trace-visible before execution.
- Workspace writes must produce request, approval/policy evidence, artifact/write terminal events.
- Repeated idempotent/no-op calls should not invent false failures.
- Tool progress is advisory; terminal tool state comes from `tool.completed` or `tool.failed`.
- Host runtime tool surfaces should be catalogued before being flattened to
  `ToolDefinition[]`; capability snapshots use catalog source metadata when
  tool governance origin is absent. Catalog entries intentionally do not carry
  separate exposure metadata.
- `workspace.write` includes `write_file`, `edit_anchored_text`, and
  `apply_patch`; new coding tools must be classified by exactly one
  workspace selector before they can appear in filtered catalogs.
- Host catalog filtering treats `tools.use` as the source/capability selector
  boundary, then intersects it with concrete `tools.allowed` before
  `tools.disabled` removes names. This happens before runtime/model descriptors
  are built. `tools.defer` only marks remaining tools for deferred schema
  loading. Generated `tool_search` entries must pass through the same filters
  so they cannot escape a configured selector/allowlist/denylist; selector-kept
  deferred tools implicitly retain `tool_search`.
- Child-agent tool orchestration uses catalog selector paths before child tool
  descriptors or delegate tools are created. Dynamic `spawn_agent` is
  intentionally limited to the read-only child catalog; configured in-process
  delegates use the configured delegate child catalog so child-profile
  `use`/`allowedTools` can expose workspace write tools and `shell` while still
  layering parent run policy and approvals. The configured delegate child run
  receives only the effective profile tool set, so prompt descriptors and
  runtime callability stay aligned.
- Dynamic `spawn_agent` separates tool transport completion from child-answer
  finality. A child answer that lands on the last allowed step can be
  `tool.completed`, while the output metadata/message marks the child answer as
  partial through `stepLimitReached`, `truncated`, and `finality` for trace
  consumers and context compaction.
- In-process delegate child writes are parent-visible through a rollup of the
  child run's own `workspace.write.completed` events onto `subagent.completed`
  (`workspaceWrites`), bridged in `spawnSubAgent` — not a parent-side filesystem
  snapshot. Shell duplicate-loop detection keys on command plus cwd, ignoring
  incidental execution fields such as `timeoutMs`.
- Core duplicate diagnostics distinguish same-concurrent-batch
  `in_flight_duplicate` calls from completed-result repeats. In-flight
  duplicates receive an accurate skipped tool result and do not mark the target
  as failed/no-op for next-turn repeat bookkeeping. Same-batch duplicate
  multiplicity still feeds the repeated-call / doom-loop guard, so pathological
  same-turn fan-out is not hidden by the in-flight diagnostic.
- direct-core/cron diagnostic runs should flatten `createCliDiagnosticToolCatalog`; avoid local shim tools that bypass the same policy/approval/write surfaces.

## Consumers

- Core run loop.
- Host tool catalog plus coding tools, shell, MCP, skills, agents, tasks.
- CLI direct-core and cron runners through `createConfiguredCliTools`.
- Trace timeline and summary.
- TUI event rendering.

## Change Checklist

- Keep tool ids stable enough for approval, grouping, and duplicate diagnostics.
- Check policy metadata and side-effect classifications.
- Check host catalog source metadata and `capability.inspect` parity.
- Check trace payload size and result summarization.
- Add tests for recoverable failures and retries.

## Known Debts

- Duplicate tool calls remain a common diagnostic issue.
- Tool result text can be too verbose for both trace and model context.
- CLI `capabilities inspect` derives diagnostic tool inventory from runtime snapshots; `tools list` has been removed to keep one authoritative tool inventory entry point.
- TUI live rendering and transcript export now share presentation summaries, but trace/model-context result compaction is still a separate backend concern.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/host/src/runtime.ts`, `packages/core/src/context.ts`, `packages/core/src/context-dedup.ts`, `packages/host/test/spawn-agent.test.ts`, `packages/core/test/context.test.ts`, `packages/core/test/runtime-guardrails.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts`; `npm --workspace @sparkwright/core test -- test/context.test.ts test/runtime-guardrails.test.ts`.
