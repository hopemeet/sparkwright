# Project Map

## Purpose

This directory is an internal maintenance map for Sparkwright. It is not user
documentation. Read it before changing cross-cutting runtime behavior, and
update it after changing module boundaries, event contracts, storage layouts, or
developer-facing diagnostics.

The map is deliberately short. It should point maintainers to the right files,
contracts, and adjacent maps before they edit code.

## How To Use Before Development

1. Find the touched file or capability in [Touch File -> Read Docs](#touch-file---read-docs).
2. Read the module page first, then the relevant flow map.
3. Check the module's `Owns / Does Not Own` boundary before moving logic.
4. Check `Change Checklist` and [maintenance/change-checklists.md](maintenance/change-checklists.md).
5. If the change touches trace, session, runtime, TUI, CLI, approvals, or tools, assume there is at least one downstream consumer.

## How To Update After Development

1. Update any map whose `Contracts` changed.
2. Update any module page whose ownership boundary changed.
3. Add new touch-file links here for new hot spots.
4. Move stale claims to `Known Debts` or `Open Questions`; do not leave guesses as facts.
5. Refresh `Last Verified`: set `Status` (`Verified` / `Read-only` / `Stale?` — see [maintenance/doc-maintenance.md](maintenance/doc-maintenance.md#verification-status)), the date, read files, and test status.

## Module Maps Vs Feature Maps

Module maps in [modules/](modules/) describe package ownership and boundaries.
Feature maps in [maps/](maps/) describe behavior that crosses packages.

When a change touches one file but changes a workflow, update both the module
page and the workflow map.

## Designs

Design docs in [designs/](designs/) are catalog entries, not routing targets —
read them for the shape and rationale of a planned or completed change, then
follow the active maps below for the current contract.

- [designs/compaction-redesign.md](designs/compaction-redesign.md) — Proposed
  (pre-implementation): unify runtime + session compaction onto one `Compactor`
  substrate, three tiers (dedup/evict/summarize), A→B→C migration. Active map:
  [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md).
- [designs/config-redesign.md](designs/config-redesign.md) — Historical
  (implemented): config selector tools + YAML starter. Active contract:
  [modules/host.md](modules/host.md).

## Touch File -> Read Docs

- `packages/core/src/trace.ts`: [modules/core.md](modules/core.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/core/src/context.ts` or `packages/core/src/path-display.ts`: [modules/core.md](modules/core.md), [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/core/src/events.ts` or `packages/core/src/workflow-hooks.ts`: [modules/core.md](modules/core.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/core/src/session.ts`: [modules/core.md](modules/core.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md)
- `packages/core/src/run.ts`: [modules/core.md](modules/core.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/safety/approvals.md](maps/safety/approvals.md)
- `packages/core/src/usage.ts`: [modules/core.md](modules/core.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/host/src/config.ts` or `packages/host/src/config-zod-schema.ts`: [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/host/src/runtime.ts`: [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/capabilities/mcp.md](maps/capabilities/mcp.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/host/src/workflow-hooks.ts` or `packages/host/src/traced-process-runner.ts`: [modules/host.md](modules/host.md), [modules/core.md](modules/core.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/host/src/acp-child-agent.ts`, `packages/host/src/external-command-agent.ts`, or `packages/host/src/delegate-capability.ts`: [modules/host.md](modules/host.md), [modules/agent-runtime.md](modules/agent-runtime.md), [maps/capabilities/agents.md](maps/capabilities/agents.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/cli/src/cli.ts`, `packages/cli/src/runners/direct-core-runner.ts`, or `packages/cli/src/runners/host-runner.ts`: [modules/cli.md](modules/cli.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/safety/approvals.md](maps/safety/approvals.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/cli/src/event-format.ts`: [modules/cli.md](modules/cli.md), [modules/protocol.md](modules/protocol.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `scripts/build-workspaces.mjs`, `scripts/check-dist-fresh.mjs`, `scripts/stamp-workspace-build.mjs`, or workspace `package.json` build scripts: [modules/cli.md](modules/cli.md)
- `scripts/copy-cli-schemas.mjs`, `scripts/generate-config-schema.ts`, or CLI-packaged/generated config schemas: [modules/cli.md](modules/cli.md), [modules/host.md](modules/host.md)
- `packages/tui/src/app.tsx`: [modules/tui.md](modules/tui.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/tui/src/lib/config.ts` or `packages/tui/src/lib/create-capability.ts`: [modules/tui.md](modules/tui.md), [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/tui/src/state/run-controller.ts`: [modules/tui.md](modules/tui.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/tui/src/components/event-stream.tsx`, `packages/tui/src/components/config-panel.tsx`, `packages/tui/src/components/capabilities-panel.tsx`, `packages/tui/src/components/skill-review-dialog.tsx`, `packages/tui/src/lib/path-display.ts`, `packages/tui/src/lib/transcript.ts`, or `packages/tui/src/lib/tool-display.ts`: [modules/tui.md](modules/tui.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/tui/src/lib/event-type.ts`: [modules/tui.md](modules/tui.md), [modules/protocol.md](modules/protocol.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md)
- `packages/protocol/src/index.ts`: [modules/protocol.md](modules/protocol.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/safety/approvals.md](maps/safety/approvals.md)
- `packages/acp-adapter/src/event.ts`: [modules/protocol.md](modules/protocol.md), [modules/host.md](modules/host.md)
- `packages/host/src/tool-catalog.ts`, `packages/host/src/tools.ts`, or `packages/host/src/toolset.ts`: [modules/host.md](modules/host.md), [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/host/src/tool-selectors.ts`: [modules/host.md](modules/host.md), [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/host/src/shell.ts`: [modules/host.md](modules/host.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/host/src/workspace-snapshot.ts`: [modules/host.md](modules/host.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/project-context/src/index.ts`: [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/skills/src/*` or `packages/host/src/skill-*`: [modules/skills.md](modules/skills.md), [maps/capabilities/skills.md](maps/capabilities/skills.md)
- `packages/host/src/skill-evolution.ts` or `sparkwright skills proposals|history|restore`: [modules/skills.md](modules/skills.md), [maps/capabilities/skill-evolution.md](maps/capabilities/skill-evolution.md)
- `packages/mcp-adapter/src/index.ts`: [modules/mcp-adapter.md](modules/mcp-adapter.md), [maps/capabilities/mcp.md](maps/capabilities/mcp.md), [maps/safety/shell.md](maps/safety/shell.md)
- `packages/agent-runtime/src/*`: [modules/agent-runtime.md](modules/agent-runtime.md), [maps/capabilities/agents.md](maps/capabilities/agents.md), [maps/capabilities/cron.md](maps/capabilities/cron.md)

## Trace / Session / Export Rule

`trace.jsonl` is the canonical raw event log. `trace summary`, `trace timeline`,
`trace report`, and `trace verify` are diagnostic views derived from it. TUI
`/export` is a human-readable Markdown transcript derived from live/in-memory
TUI events; it is not a trace diagnostic report and must not replace
trace/session inspection.

## Last Verified

- Status: Read-only
- Date: 2026-06-20
- Read: `docs/_internal/project-map/README.md`, `docs/_internal/project-map/maintenance/doc-maintenance.md`, `docs/_internal/project-map/modules/host.md`, `docs/_internal/project-map/modules/cli.md`, `docs/_internal/project-map/maps/capabilities/README.md`, `docs/_internal/project-map/maps/runtime/tool-orchestration.md`, `docs/_internal/project-map/designs/config-redesign.md`.
- Tests: not run; cleanup-only map audit.
