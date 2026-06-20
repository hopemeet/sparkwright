# Workspace Writes

## Purpose

Workspace writes are controlled mutations to user project state. They must be
policy-checked, approval-gated when needed, trace-visible, and artifact-backed.

See [approvals.md](approvals.md) and [../runtime/tool-orchestration.md](../runtime/tool-orchestration.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/workspace.ts`
- `packages/core/src/workspace-checkpoint.ts`
- `packages/core/src/anchored-edit.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/host/src/workspace-snapshot.ts`

## Data Flow

```txt
tool proposes write
  -> policy
  -> approval if required
  -> artifact/diff
  -> workspace.write.completed or workspace.write.denied/skipped
```

## Contracts

- Accepted anchored edits still flow through normal workspace write events.
- Large diffs should be artifacts, not only inline payloads.
- `workspace.write.denied` is a valid terminal write outcome.
- Shell writes, managed capability mutations, and delegate child writes must
  still leave trace evidence. In-process delegate child writes are surfaced to
  the parent summary by rolling up the child run's own
  `workspace.write.completed` events onto `subagent.*` payloads.
- External command delegates with read/write workspace access are an explicit
  audit boundary: they emit `workspace.write.untracked_access_granted` when
  direct access is granted. The marker means access-granted /
  untracked-write-capable only; it does not assert that a write occurred, does
  not name files, and does not increment managed workspace write counts.
- MCP tools are normal external tools. If they write files without using
  managed `workspace.write.*`, those writes are not counted as managed
  workspace writes; stdio MCP servers default to neutral cwd to avoid accidental
  relative-path project writes.

## Consumers

- Core policy and run loop.
- CLI/TUI approval UX.
- Trace summary safety counts.
- CLI run summaries separate managed writes from untracked write-capable
  external processes.
- Session consistency checks.

## Change Checklist

- Check write request/completed/denied/skipped event pairing.
- Check artifact creation and redaction.
- Check workspace escape detection.
- Check shell mutation rollback behavior if shell can write.
- Check static MCP workspace-cwd disclosures when configured MCP servers opt in
  to project cwd.

## Known Debts

- Human reports should add higher-signal findings for untracked write-capable
  external commands; summary counting now separates that boundary from managed
  workspace writes.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/core/src/events.ts`, `packages/host/src/tools.ts`, `packages/host/src/shell.ts`, `packages/host/src/runtime.ts`, `packages/host/src/external-command-agent.ts`, `packages/host/src/workspace-snapshot.ts`, `packages/cli/src/cli.ts`, `docs/reference/PROTOCOL.md`, `docs/reference/RUN_EVENTS.md`, `schemas/event.schema.json`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "external command delegate|read-write workspace access|capabilities inspect"`; `npm --workspace @sparkwright/core run build`; `npm --workspace @sparkwright/cli run build`.
