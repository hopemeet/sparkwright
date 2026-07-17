# Project Map

## Purpose

This directory is an internal maintenance map for SparkWright. It is not user
documentation. Read it before changing cross-cutting runtime behavior, and
update it after changing module boundaries, event contracts, storage layouts, or
developer-facing diagnostics.

The map is deliberately short. It should point maintainers to the right files,
contracts, and adjacent maps before they edit code.

Source code, schemas, tests, and public reference docs remain the source of
truth. The structured project map, proposals, and test map are versioned in this
checkout; keep their updates in the same commit/PR as the behavior change.
Ephemeral internal run notes and uncatalogued scratch material remain ignored.

For verification routing, scenario design, stochastic run notes, and historical
failure patterns, use [../test-map/README.md](../test-map/README.md) alongside
this project map.

## How To Use Before Development

1. Find the touched file or capability in [Touch File -> Read Docs](#touch-file---read-docs).
2. Read the module page first, then the relevant flow map.
3. Check the module's `Owns / Does Not Own` boundary before moving logic.
4. Check `Change Checklist` and [maintenance/change-checklists.md](maintenance/change-checklists.md).
5. Use [../test-map/routes/](../test-map/routes/) to choose focused
   verification routes.
6. If the change touches trace, session, runtime, TUI, CLI, approvals, or
   tools, assume there is at least one downstream consumer.

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

The project map is hot-path coverage, not a complete package encyclopedia.
Dedicated module pages exist for runtime, product, and capability packages that
most often define cross-cutting contracts. Thin clients, provider bridges,
storage adapters, gateways, and experimental/service edges are grouped under
[modules/edge-packages.md](modules/edge-packages.md) until repeated work
justifies a dedicated module page.

## Designs

Design docs in [designs/](designs/) are catalog entries, not routing targets —
read them for the shape and rationale of a planned or completed change, then
follow the active maps below for the current contract.

- [designs/multi-agent-supervision.md](designs/multi-agent-supervision.md) —
  Active staged refactor for converging Agent invocation identity, lifecycle,
  resource admission, and adapter ownership without adding a generic actor bus.
  Active contracts: [modules/agent-runtime.md](modules/agent-runtime.md),
  [modules/host.md](modules/host.md), and
  [maps/capabilities/agents.md](maps/capabilities/agents.md).

- [designs/asset-package-governance-redirection-review.md](designs/asset-package-governance-redirection-review.md) —
  Adjudicated review handoff: records the frozen scope redirection that keeps
  managed change Skill-only, separates filesystem reconciliation, establishes
  package identity v2 and Workflow executable snapshots, redirects ordinary
  Agent authoring to Markdown, and keeps Agent/Workflow stats diagnostic-only.
  It is decision history, not the implementation master or an active runtime
  contract.

- [designs/skill-managed-change-redesign.md](designs/skill-managed-change-redesign.md) —
  Implementation-ready master design: preserves completed Skill Phase 1/2,
  freezes package identity v2 and external-change safety, requires Workflow
  executable package pinning, limits Agent authoring to validated Markdown,
  defines trace-derived policy-aware stats, and defers Skill identity
  continuity/reconciliation to Phase 7. Active contracts:
  [modules/skills.md](modules/skills.md), [modules/host.md](modules/host.md),
  [modules/tui.md](modules/tui.md),
  [maps/capabilities/skill-evolution.md](maps/capabilities/skill-evolution.md),
  and [maps/safety/approvals.md](maps/safety/approvals.md).

- [designs/compaction-redesign.md](designs/compaction-redesign.md) —
  Historical/implemented design: shared compaction result/stage substrate,
  session compact artifacts, deterministic/model-backed summarization paths,
  and measurement reporting are implemented; background auto-trigger remains a
  follow-up. Active map:
  [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md).
- [designs/config-redesign.md](designs/config-redesign.md) — Historical
  (implemented): config selector tools + YAML starter. Active contract:
  [modules/host.md](modules/host.md).
- [designs/hooks-control-plane-refactor.md](designs/hooks-control-plane-refactor.md) —
  Implemented through the clean P3/P4/P5 checkpoint: active-rule inspection
  exposes configured workflow hooks, configured event hooks,
  verification projection hooks, and documented-command degenerate verifiers
  through capability snapshots; workflow lifecycle names are canonical-only; event
  subscribers live under `capabilities.hooks.events`; command/http/agent action
  paths exist. Prompt actions, broader trigger vocabulary, and batch lifecycles
  remain design work. Active contracts:
  [modules/core.md](modules/core.md),
  [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md).
- [designs/internal-actor-inbox.md](designs/internal-actor-inbox.md) —
  Partially implemented design: Step 0 + Step 1 generalize the existing task
  notification sink into split actor producer/consumer interfaces in
  agent-runtime, with workflow notification inputs as the design probe. Host
  receiver policy extraction and workflow actor runtime remain future slices.
  Active contracts remain:
  [modules/agent-runtime.md](modules/agent-runtime.md),
  [modules/host.md](modules/host.md),
  [maps/runtime/run-loop.md](maps/runtime/run-loop.md), and
  [maps/capabilities/agents.md](maps/capabilities/agents.md).
- [designs/multi-model.md](designs/multi-model.md) — Implemented simplified
  MVP: session compaction model routing, dynamic `spawn_agent` `spawnModel`,
  and configured in-process delegate `profile.model` / `delegateModel` defaults
  use raw refs with parent-model inheritance. Logical aliases, model
  allowlists/budgets, and per-logical model usage keying are deferred out of the
  MVP. Active model construction contract: [modules/host.md](modules/host.md).

## Touch File -> Read Docs

- `packages/core/src/trace.ts`, `packages/core/src/trace-codec.ts`, `packages/core/src/trace-diagnostics.ts`, `packages/core/src/run-health.ts`, `packages/core/src/trace-session-consistency.ts`, or `packages/core/src/trace-store.ts`: [modules/core.md](modules/core.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/core/src/context.ts` or `packages/core/src/path-display.ts`: [modules/core.md](modules/core.md), [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/core/src/events.ts` or `packages/core/src/workflow-hooks.ts`: [modules/core.md](modules/core.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/core/src/environment.ts`: [modules/core.md](modules/core.md), [maps/safety/shell.md](maps/safety/shell.md)
- `packages/core/src/fact-ledger.ts`, `packages/core/src/fact-classifier.ts`, or `packages/core/src/run-outcome.ts`: [modules/core.md](modules/core.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/core/src/file-atomic.ts`: [modules/core.md](modules/core.md), [modules/agent-runtime.md](modules/agent-runtime.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/core/src/session.ts`: [modules/core.md](modules/core.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md)
- `packages/core/src/run-budget.ts`: [modules/core.md](modules/core.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/capabilities/agents.md](maps/capabilities/agents.md)
- `packages/core/src/run.ts`: [modules/core.md](modules/core.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/safety/approvals.md](maps/safety/approvals.md)
- `packages/core/src/policy.ts` or `packages/core/src/approval-policy.ts`: [modules/core.md](modules/core.md), [maps/safety/approvals.md](maps/safety/approvals.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/core/src/workspace.ts` or `packages/core/src/workspace-checkpoint.ts`: [modules/core.md](modules/core.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md)
- `packages/core/src/usage.ts`: [modules/core.md](modules/core.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/host/src/config.ts` or `packages/host/src/config-zod-schema.ts`: [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/host/src/config/*`: [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/host/src/tool-identities.ts`, `packages/host/src/tool-catalog.ts`, `packages/host/src/tool-selectors.ts`, or `packages/host/src/tool-surface.ts`: [modules/host.md](modules/host.md), [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/host/src/model-builder.ts` or `packages/host/src/model-factory.ts`: [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md), [maps/runtime/context-compaction.md](maps/runtime/context-compaction.md)
- `packages/host/src/runtime.ts`, `packages/host/src/run-access.ts`, `packages/host/src/run-security-plan.ts`, or `packages/host/src/run-policy.ts`: [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/capabilities/mcp.md](maps/capabilities/mcp.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/host/src/runtime/*`: [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/capabilities/mcp.md](maps/capabilities/mcp.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/host/src/host-execution.ts`, `packages/host/src/execution-plan.ts`, or `packages/host/src/execution-resources.ts`: [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md)
- `packages/host/src/host-service.ts` or `packages/host/src/workspace-context.ts`: [modules/host.md](modules/host.md), [modules/edge-packages.md](modules/edge-packages.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md)
- `packages/host/src/client-input.ts`: [modules/host.md](modules/host.md), [modules/cli.md](modules/cli.md), [modules/tui.md](modules/tui.md), [modules/protocol.md](modules/protocol.md)
- `packages/core/src/access-mode.ts` (`run.accessMode` -> `permissionMode`/`shouldWrite` compile + clamp): [modules/host.md](modules/host.md), [modules/protocol.md](modules/protocol.md), [maps/safety/approvals.md](maps/safety/approvals.md)
- `packages/host/src/workflow-hooks.ts`, `packages/host/src/active-rules.ts`, or `packages/host/src/traced-process-runner.ts`: [modules/host.md](modules/host.md), [modules/core.md](modules/core.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `packages/acp-client-adapter/src/worker.ts`, `packages/host/src/acp-child-agent.ts`, `packages/host/src/external-command-agent.ts`, `packages/host/src/workspace-lease-coordinator.ts`, `packages/host/src/delegate-capability.ts`, `packages/host/src/delegate-runner.ts`, `packages/host/src/indexed-delegate-tool.ts`, or `packages/host/src/agent-profiles.ts`: [modules/host.md](modules/host.md), [modules/agent-runtime.md](modules/agent-runtime.md), [maps/capabilities/agents.md](maps/capabilities/agents.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/host/src/workflows.ts`, `packages/host/src/workflow-projection.ts`, `packages/host/src/workflow-node-api.ts`, `packages/host/src/workflow-distill.ts`, `packages/host/src/workflow-shadow.ts`, `packages/host/src/workflow-trace-observation.ts`, `sparkwright workflow list|inspect|distill|shadow`, or `sparkwright run --workflow`: [modules/host.md](modules/host.md), [modules/cli.md](modules/cli.md), [modules/protocol.md](modules/protocol.md), [maps/capabilities/README.md](maps/capabilities/README.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/cli/src/cli.ts`, `packages/cli/src/runners/direct-core-runner.ts`, or `packages/cli/src/runners/host-runner.ts`: [modules/cli.md](modules/cli.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/safety/approvals.md](maps/safety/approvals.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/cli/src/commands/*` or `packages/cli/src/parser/*`: [modules/cli.md](modules/cli.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/cli/test/support/*`: [modules/cli.md](modules/cli.md)
- `packages/cli/src/event-format.ts`: [modules/cli.md](modules/cli.md), [modules/protocol.md](modules/protocol.md), [maps/trace/summary-timeline-verify.md](maps/trace/summary-timeline-verify.md)
- `scripts/build-workspaces.mjs`, `scripts/check-dist-fresh.mjs`, `scripts/stamp-workspace-build.mjs`, or workspace `package.json` build scripts: [modules/cli.md](modules/cli.md)
- `scripts/copy-cli-schemas.mjs`, `scripts/generate-config-schema.ts`, or CLI-packaged/generated config schemas: [modules/cli.md](modules/cli.md), [modules/host.md](modules/host.md)
- `scripts/regression-real-model.mjs`, `scripts/regression-real-skill-capabilities.mjs`, or `scripts/lib/real-model-config.mjs`: [modules/cli.md](modules/cli.md), [modules/host.md](modules/host.md)
- `packages/tui/src/app.tsx`: [modules/tui.md](modules/tui.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/tui/src/lib/permission.ts`: [modules/tui.md](modules/tui.md), [modules/host.md](modules/host.md), [maps/safety/approvals.md](maps/safety/approvals.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md)
- `packages/tui/src/lib/keybindings.ts`: [modules/tui.md](modules/tui.md)
- `packages/tui/src/lib/config.ts` or `packages/tui/src/lib/create-capability.ts`: [modules/tui.md](modules/tui.md), [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/tui/src/state/run-controller.ts`: [modules/tui.md](modules/tui.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/tui/src/components/activity-panel.tsx`, `packages/tui/src/components/event-stream.tsx`, `packages/tui/src/components/status-bar.tsx`, `packages/tui/src/components/config-panel.tsx`, `packages/tui/src/components/capabilities-panel.tsx`, `packages/tui/src/components/skill-review-dialog.tsx`, `packages/tui/src/components/workflow-panel.tsx`, `packages/tui/src/lib/path-display.ts`, `packages/tui/src/lib/task-activity.ts`, `packages/tui/src/lib/workflow-display.ts`, `packages/tui/src/lib/transcript.ts`, or `packages/tui/src/lib/tool-display.ts`: [modules/tui.md](modules/tui.md), [modules/protocol.md](modules/protocol.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/tui/src/state/use-workflow-actions.ts`: [modules/tui.md](modules/tui.md), [modules/host.md](modules/host.md), [modules/protocol.md](modules/protocol.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/tui/src/lib/event-type.ts`: [modules/tui.md](modules/tui.md), [modules/protocol.md](modules/protocol.md), [maps/trace/export-diagnostics.md](maps/trace/export-diagnostics.md)
- `packages/protocol/src/index.ts`: [modules/protocol.md](modules/protocol.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/safety/approvals.md](maps/safety/approvals.md)
- `packages/acp-adapter/src/*` or `packages/acp-client-adapter/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [modules/protocol.md](modules/protocol.md), [modules/host.md](modules/host.md), [maps/capabilities/agents.md](maps/capabilities/agents.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/sdk-core/src/*`, `packages/sdk-node/src/*`, or `packages/sdk-browser/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [modules/protocol.md](modules/protocol.md), [modules/host.md](modules/host.md)
- `packages/host/src/tool-catalog.ts` or `packages/host/src/tools.ts`: [modules/host.md](modules/host.md), [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/host/src/tool-selectors.ts`: [modules/host.md](modules/host.md), [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/host/src/shell.ts`: [modules/host.md](modules/host.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/shell-tool/src/*`: [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/safety/shell.md](maps/safety/shell.md)
- `packages/host/src/workspace-snapshot.ts`: [modules/host.md](modules/host.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/shell-sandbox/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [modules/host.md](modules/host.md), [modules/mcp-adapter.md](modules/mcp-adapter.md), [maps/safety/shell.md](maps/safety/shell.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md)
- `packages/project-context/src/index.ts`: [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md)
- `packages/project-commands/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [modules/tui.md](modules/tui.md), [maps/safety/shell.md](maps/safety/shell.md)
- `packages/skills/src/*` or `packages/host/src/skill-*`: [modules/skills.md](modules/skills.md), [maps/capabilities/skills.md](maps/capabilities/skills.md)
- `packages/host/src/skill-command-service.ts`, `sparkwright skills create`,
  TUI `/create skill`, or TUI `/skill-create`:
  [modules/skills.md](modules/skills.md), [modules/host.md](modules/host.md),
  [modules/cli.md](modules/cli.md), [modules/tui.md](modules/tui.md),
  [maps/capabilities/skill-evolution.md](maps/capabilities/skill-evolution.md).
- `packages/skills/src/markdown-folder-asset.ts`: [modules/skills.md](modules/skills.md), [modules/host.md](modules/host.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/host/src/skill-evolution.ts` or `sparkwright skills proposals|history|restore`: [modules/skills.md](modules/skills.md), [maps/capabilities/skill-evolution.md](maps/capabilities/skill-evolution.md)
- `packages/mcp-adapter/src/index.ts`: [modules/mcp-adapter.md](modules/mcp-adapter.md), [maps/capabilities/mcp.md](maps/capabilities/mcp.md), [maps/safety/shell.md](maps/safety/shell.md)
- `packages/mcp-adapter/src/*`: [modules/mcp-adapter.md](modules/mcp-adapter.md), [maps/capabilities/mcp.md](maps/capabilities/mcp.md), [maps/safety/shell.md](maps/safety/shell.md)
- `packages/coding-tools/src/*`: [modules/coding-tools.md](modules/coding-tools.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/safety/workspace-writes.md](maps/safety/workspace-writes.md)
- `packages/core/src/runtime/*`: [modules/core.md](modules/core.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/runtime/tool-orchestration.md](maps/runtime/tool-orchestration.md), [maps/safety/approvals.md](maps/safety/approvals.md)
- `packages/cron/src/*`: [maps/capabilities/cron.md](maps/capabilities/cron.md), [modules/cli.md](modules/cli.md), [modules/tui.md](modules/tui.md), [modules/host.md](modules/host.md)
- `packages/agent-runtime/src/*`: [modules/agent-runtime.md](modules/agent-runtime.md), [maps/capabilities/agents.md](maps/capabilities/agents.md), [maps/capabilities/cron.md](maps/capabilities/cron.md)
- `packages/agent-runtime/src/tasks/notifications.ts`, `packages/agent-runtime/src/tasks/file-notifications.ts`, or `packages/agent-runtime/src/tasks/manager.ts` notification delivery: [modules/agent-runtime.md](modules/agent-runtime.md), [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/capabilities/agents.md](maps/capabilities/agents.md)
- `packages/agent-runtime/src/workflows/*`: [modules/agent-runtime.md](modules/agent-runtime.md), [modules/protocol.md](modules/protocol.md), [maps/capabilities/README.md](maps/capabilities/README.md)
- `packages/agent-runtime/src/workflows/store.ts`, `packages/agent-runtime/src/workflows/journal.ts`, or `packages/agent-runtime/src/doc-store/index.ts` workflow persistence changes: [modules/agent-runtime.md](modules/agent-runtime.md), [modules/host.md](modules/host.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/agent-runtime/src/workflows/control.ts`, `packages/agent-runtime/src/workflows/control-processor.ts`, or `workflow.control`: [modules/agent-runtime.md](modules/agent-runtime.md), [modules/host.md](modules/host.md), [modules/protocol.md](modules/protocol.md), [modules/edge-packages.md](modules/edge-packages.md), [maps/session/session-store.md](maps/session/session-store.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/agent-runtime/src/workflows/workers.ts`, `packages/server-runtime/src/workflow-supervisor.ts`, or durable workflow worker ownership: [modules/agent-runtime.md](modules/agent-runtime.md), [modules/host.md](modules/host.md), [modules/edge-packages.md](modules/edge-packages.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/server-runtime/src/workflow-service.ts`, `sparkwright workflow service *`, or `workflow start --detach`: [modules/edge-packages.md](modules/edge-packages.md), [modules/cli.md](modules/cli.md), [modules/host.md](modules/host.md), [maps/session/resume-replay.md](maps/session/resume-replay.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/agent-runtime/src/workflows/channels.ts`, `packages/server-runtime/src/workflow-channel-coordinator.ts`, `workflow.control.process`, or durable workflow channel delivery: [modules/agent-runtime.md](modules/agent-runtime.md), [modules/edge-packages.md](modules/edge-packages.md), [modules/host.md](modules/host.md), [modules/protocol.md](modules/protocol.md), [modules/tui.md](modules/tui.md), [modules/cli.md](modules/cli.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)
- `packages/provider-ai-sdk/src/*` or `packages/provider-registry/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [modules/host.md](modules/host.md), [designs/multi-model.md](designs/multi-model.md)
- `packages/server-runtime/src/execution-lanes.ts` or Host interactive lane scheduling: [modules/edge-packages.md](modules/edge-packages.md), [modules/host.md](modules/host.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [designs/host-execution-lane-p0-baseline.md](designs/host-execution-lane-p0-baseline.md)
- Other `packages/server-runtime/src/*`, `packages/streaming-runtime/src/*`, or `packages/memory-file-store/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [modules/core.md](modules/core.md), [maps/runtime/run-loop.md](maps/runtime/run-loop.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/trace-perfetto/src/*`: [modules/edge-packages.md](modules/edge-packages.md), [maps/trace/raw-trace.md](maps/trace/raw-trace.md)
- `packages/host/src/im-control.ts`, `packages/im-gateway/src/*`, or ordinary IM session control: [modules/edge-packages.md](modules/edge-packages.md), [modules/protocol.md](modules/protocol.md), [modules/host.md](modules/host.md), [maps/safety/approvals.md](maps/safety/approvals.md), [maps/session/session-store.md](maps/session/session-store.md)
- `packages/host/src/connection.ts`, `packages/host/src/transport-ws.ts`, `packages/host/src/transport-stdio.ts`, `packages/host/src/server.ts`, or Host connection authentication/principal derivation: [modules/host.md](modules/host.md), [modules/protocol.md](modules/protocol.md), [modules/edge-packages.md](modules/edge-packages.md), [maps/safety/approvals.md](maps/safety/approvals.md), [maps/session/resume-replay.md](maps/session/resume-replay.md)

## Trace / Session / Export Rule

`trace.jsonl` is the canonical raw event log. `trace summary`, `trace timeline`,
`trace report`, and `trace verify` are diagnostic views derived from it. TUI
`/export` is a human-readable Markdown transcript derived from live/in-memory
TUI events; it is not a trace diagnostic report and must not replace
trace/session inspection.

## Last Verified

- Status: Verified
- Date: 2026-07-17T13:00:00+0800
- Scope: tool/capability semantics are single-source: exposure tiers are
  public/advanced/infrastructure/internal with `list_dir` canonical advanced;
  delegate snapshots expose only the required current-run approval fact; replay
  risk is derived only from governance idempotency.
- Read: Core tool/run contracts, Host catalog/delegate/capability assembly,
  protocol/schema/fixtures, CLI/TUI capability consumers, MCP/Cron/Agent tool
  definitions, public references, and routed project/test-map pages.
- Tests: Core replay 2/2; Host tools 88/88 and capability/delegate protocol
  14/14; CLI capability 3/3; TUI capability 8/8; MCP adapter 34/34; Cron 20/20;
  affected package typechecks.

- Status: Verified
- Date: 2026-07-17T11:02:45+0800
- Scope: model-facing runtime DTOs are single-shape: Task scheduling accepts
  only `mode`, Todo writes accept only `title`/`status`/optional `priority`, and
  Core interaction is approval-only. Durable Task state and rich internal Todo
  ledger fields remain intact.
- Read: Agent Runtime Task/Todo maps and sources, Core interaction/run surface,
  Host/CLI/Streaming Runtime approval adapters, TUI Todo projection, public
  references, and relevant test-map coverage/routes.
- Tests: Agent Runtime Task/Todo 99/99; Core interaction/approval 18/18;
  Host task/approval 12/12; CLI approval 4/4; TUI Todo 11/11; affected package
  typechecks; schema/test typechecks; project-map drift; full release gate.

- Status: Verified
- Date: 2026-07-17T09:43:00+0800
- Scope: external configuration now has one canonical input shape: identity,
  policy, run, and UI-owned fields are grouped-only; active root fields remain
  workspace, shell foreground timing, tools, tasks, and capabilities. Removed
  root aliases, shell.sandbox, grouped-vs-flat conflicts, and the TUI second
  parser are gone.
- Read: Host schema/contracts/loader, CLI init/writers/doctor/real-regression
  helpers, TUI config projection, generated schema and fixtures, public config
  references, and routed project/test-map pages.
- Tests: Host config/protocol 115/115; CLI config schema 6/6 and full 155/155;
  TUI config/capability/status consumers 17/17; Agent Runtime, Host, CLI, and
  TUI typechecks; repository test typecheck; schema check; project-map drift;
  full release gate including regression matrix and install smokes.

- Status: Verified
- Date: 2026-07-17T08:25:00+0800
- Scope: ACP and external-command delegate tool results identify their
  configured profile only through canonical `agentProfileId`. Removed the
  duplicate top-level `agentId` result field and the same alias from external
  nonzero-exit error metadata.
- Read: Host ACP/external-command adapters and result types, direct delegate
  runner, Host/CLI/TUI result and lifecycle consumers, Core trace projections,
  public process-delegate references, and focused tests.
- Checked with no contract update needed: parent-visible lifecycle metadata
  retains parent/trace actor `agentId`, `childAgentId`, and `agentProfileId`;
  child run/session identity, Agent Runtime lifecycle, protocol wire shapes,
  raw trace envelopes, workspace access, and Shell sandboxing are unchanged.
- Tests: Host ACP/external-command 30/30 and delegate protocol 8/8; CLI direct
  delegate 1/1; Core trace 4/4; Host and repository test typechecks passed.

- Status: Verified
- Date: 2026-07-17T01:07:28+0800
- Scope: external-command delegate results expose only canonical per-stream
  `stdoutTruncated` and `stderrTruncated` facts. Removed the aggregate
  `outputTruncated` compatibility field from the tool result, terminal
  `subagent.completed` payload, result type, and tests.
- Read: Host external-command adapter and direct delegate runner, Core process
  output and trace consumers, CLI direct-run serializer, Agent capability and
  test maps, public process-output references, and focused tests.
- Checked with no contract update needed: Agent Runtime lifecycle, workspace
  access and Shell sandboxing, and ShellTool's independent artifact-aware
  `outputTruncated` field.
- Tests: Host external-command 20/20 and delegate protocol 8/8; CLI direct
  delegate 1/1; Core subagent/delegate trace 4/4; Host build/typecheck and
  repository test typecheck; project-map drift; full release gate passed.

- Status: Verified
- Date: 2026-07-17T00:08:26+0800
- Scope: Agent direct delegate exposure now has one configuration path:
  `exposure`, `pinnedDelegates`, and per-profile `exposeAsDelegate`. Removed the
  old global boolean reader, resolver/filter branches, CLI preservation, and
  generated schema property.
- Read: Host, CLI, Agent Runtime, Agent/capability maps, public Agent guidance,
  config schema, and focused tests.
- Checked with no contract update needed: provider/model resolution,
  workspace-write approval, Shell protection, trace/session envelopes, and TUI
  capability rendering.
- Tests: Host Agent/config/tools 184/184; focused Host protocol 4/4; CLI
  Agent/delegate/capability 9/9; Agent Runtime, Host, and CLI typechecks;
  repository test typecheck; schema check; project-map drift; full release gate.

- Status: Verified
- Date: 2026-07-16T23:55:17+0800
- Scope: model-facing Markdown Agent authoring has one explicit inheritance
  marker, `model: "inherit"`; the `model: "default"` compatibility reader and
  schema branch were removed. Config/runtime model defaults are unchanged.
- Read: Host `create_agent` schema/parser, Agent discovery validation, current
  Agent/capability/tool maps, public guidance/manual, and focused tests.
- Checked with no contract update needed: provider construction, configured
  Agent `spawnModel`/`delegateModel`, policy/approval, trace, and session paths.
- Tests: Host Agent profile/tools 125/125; Host capability protocol 5/5; CLI
  Agent/capability routes 7/7; Host and CLI typechecks; repository test
  typecheck; project-map drift; full release gate.

- Status: Verified
- Date: 2026-07-16T23:38:00+0800
- Scope: Markdown Agent identity is filename-only. Host no longer reads a
  frontmatter `id` override or the hidden model-tool `id` argument; config
  profile ids remain the canonical configured-profile route.
- Read: Host Agent profile discovery/authoring, Agent Runtime profile carrier,
  Agent capability docs, collision/report consumers, and focused tests.
- Checked with no contract update needed: workspace-write approval, Shell
  capability protection, raw trace collision events, protocol payloads, and
  config profile identity are unchanged.
- Tests: Host Agent profile/tools 125/125; focused Host protocol collision 1/1;
  CLI Agent/capability routes 7/7; Host, Agent Runtime, and CLI typechecks;
  repository test typecheck; project-map drift; full release gate.

- Status: Verified
- Date: 2026-07-16T23:05:00+0800
- Scope: Task and Workflow notification producers/consumers now use the
  canonical `ActorNotificationSink` / `ActorInbox` interfaces directly; the
  task-specific sink, duplicate queue view, adapter accessors, and legacy task
  notification durable shape were removed.
- Read: Agent Runtime notification implementations/manager/tests, Host revival
  and projection, workflow channel consumers, examples/reference docs, and
  routed runtime/Agent/Cron maps.
- Checked with no contract update needed: Core `NotificationSource`, protocol,
  trace, Cron scheduling, workflow record/control persistence, and external
  transport semantics are unchanged.
- Tests: Agent Runtime task/workflow 90/90; Host task/workflow/protocol/Agent 122/122;
  server-runtime 3/3; IM gateway 6/6; repository test typecheck; full release
  gate.

- Status: Verified
- Date: 2026-07-16T22:26:54+0800
- Scope: Workflow durable persistence is journal-only; record/event sidecar
  readers, mirror writers, and lazy import were removed while Host/CLI/TUI
  list, get, resume, and event consumers continue through `FileWorkflowStore`.
- Read: Agent Runtime workflow store/journal/tests; Host, CLI, TUI,
  server-runtime, protocol, current persistence docs, and workflow test maps.
- Tests: Agent Runtime workflow focused suite/typecheck; Host workflow/protocol
  focused suites/typecheck; repository test typecheck; project-map drift; full
  release gate.

- Status: Verified
- Date: 2026-07-16
- Scope: Host protocol 2.0 removed `run.failed.error` across producer, schema,
  protocol helpers, SDK, CLI, TUI, ACP, IM Gateway, fixtures, and reference docs;
  `failure` is the only terminal failure envelope.

- Status: Verified
- Date: 2026-07-16
- Scope: built-in model-facing tools now have one exact callable/configuration
  identity (`read`, `write`, `edit`, `bash`); the Core alias registry, Host
  normalization, protocol alias metadata, and old documentation paths were
  removed together.
- Read: tool orchestration, Host catalogs/selectors/inspection, coding and shell
  factories, CLI/TUI consumers, schemas, fixtures, and routed tests.

- Status: Verified
- Date: 2026-07-16T10:13:52+0800
- Scope: retired the unused server-runtime compatibility composition stack and
  misleading durable dispatcher alias, leaving only production execution-lane,
  in-flight dispatch, and Workflow coordination exports.
- Read: server-runtime exports/tests/README, all workspace source consumers,
  edge-package ownership, run-loop/session routing, and package test routes.
- Tests: server-runtime 23/23 focused tests, all downstream typechecks, and the
  full `npm run release:check` gate passed.

- Status: Verified
- Date: 2026-07-16T09:29:05+0800
- Scope: integrated the progressive large-file split with the five post-fork
  main refactors; preserved current behavior behind config/runtime facades and
  added repository-owned dependency/map guardrails.
- Read: all merged CLI/Core/coding-tools/Host modules, conflict resolutions,
  routed maps, test routes, and static guard scripts.
- Tests: focused Host 259/259, typechecks, import graph/internal/package/map
  gates, and the full release gate passed.

- Status: Verified
- Date: 2026-07-16T08:56:29+0800
- Scope: routed workspace mutation admission through its sole canonical lease
  coordinator after deleting the deprecated Agent-arbiter surface.
- Read: Host coordinator and all production/test imports plus routed Agent,
  workspace-write, Shell, trace, and supervision pages.
- Tests: focused Host 70/70, Host typecheck, and the full release gate passed.

- Status: Verified
- Date: 2026-07-15
- Scope: routed the consolidated `tool-surface.ts`, exact command-evidence
  rule, removed `run.started` visibility projection, and explicit Workflow
  terminal ownership through Host/Core/run-loop/trace/test-map pages.
- Read: catalog-to-execution chain, Todo continuation, Workflow projection and
  finalization, raw trace consumers, and linked ownership boundaries.
- Tests: Core/Host/agent-runtime focused suites, affected typechecks, and full
  `npm run release:check` passed.

- Status: Verified
- Date: 2026-07-15
- Scope: added directory-level routing for the progressive large-file split
  hotspots and introduced repository-owned drift/import graph guardrails.
- Read: all routed Host/CLI/Core/coding-tools/MCP module and runtime, safety,
  session, trace, capability, and test-map pages required by the campaign.
- Tests: package/internal/import graph checks; CLI characterization and
  outcome/config/parity suites; CLI/test typechecks; deterministic repo-pilot;
  worktree and `--base origin/main` drift modes.

- Status: Verified
- Date: 2026-07-14
- Scope: routed actor-notification kind narrowing through agent-runtime, Agent
  communication, and the internal actor inbox/supervision designs.
- Read: typed actor unions, all production task/workflow sources and consumers,
  durable adapters, Host receiver bridge, and linked maps.
- Checked with no contract update needed: `maps/capabilities/cron.md`, Core
  `NotificationSource`, Host task revival, workflow durable formats, protocol,
  trace, and external transports are unchanged.
- Tests: agent-runtime task/workflow/channel 99/99; downstream Host,
  server-runtime, and IM gateway focused suites; full `npm run release:check`.

- Status: Verified
- Date: 2026-07-14
- Scope: routed Core descendant-tree budget accounts, Agent inheritance, and
  checkpoint preservation through the run-loop, Agent, and resume maps.
- Read: affected Core/agent-runtime source, active supervision design, extension
  interface, and linked project-map pages.
- Checked with no contract update needed: Host workspace admission,
  `maps/safety/approvals.md`, forced-continuation budgets, Workflow run-chain
  budgets, protocol event families, process delegate execution, and
  `maps/capabilities/cron.md` remain unchanged. Tool-call reservation was
  updated in `maps/runtime/tool-orchestration.md`.
- Tests: Core budget/run/resume/trace 275/275; agent-runtime Agent suites 65/65;
  Host Agent/process/arbiter suites 102/102; affected typechecks/build passed.

- Status: Verified
- Date: 2026-07-14
- Scope: routed the process-local Agent workspace arbiter and portable
  asynchronous admission seam through Host, agent-runtime, Agents, workspace
  safety, and the active supervision design.
- Read: all affected implementation paths and linked project-map pages.
- Checked with no contract update needed: protocol payloads, raw event schema,
  trace/session/resume derivation, run-loop/tool orchestration, capability
  overview, MCP, Cron, shell sandbox semantics, and Core write authorization
  remain unchanged.
- Tests: agent-runtime Agent/invocation/supervisor/ledger 60/60; Host focused
  Agent/process suites 162/162; affected typechecks/build passed.

- Status: Verified
- Date: 2026-07-14
- Scope: routed the AgentSupervisor lifecycle convergence through
  agent-runtime, Host/indexed/process adapters, raw trace, and protocol docs.
- Read: active design, all production `subagent.*` emitters, traced process
  start signaling, and linked maps.
- Checked with no contract update needed: the Core module, capability overview,
  shell/process execution semantics, trace summary derivation, session replay,
  MCP, Cron, and workspace-write authorization; only Agent lifecycle
  admission/projection changed.
- Tests: agent-runtime supervisor/invocation/Agent and Host Agent/process
  lifecycle focused suites passed.

- Status: Verified
- Date: 2026-07-14
- Scope: cataloged the active multi-Agent supervision refactor and routed its
  prepared invocation boundary through agent-runtime, Host, Agents, and raw
  trace maps.
- Read: active design, implementation/adapters, protocol event docs, and all
  linked map pages.
- Checked with no contract update needed: Cron consumes task/runtime exports but
  does not construct or observe child Agent invocation lifecycles.
- Tests: prepared invocation/Agent and Host lifecycle focused suites passed.

- Status: Verified
- Date: 2026-07-14
- Scope: routed the first multi-Agent mechanical split through the Host indexed
  delegate module and agent-runtime `agents/` contracts/ledger boundary.
- Read: Host and agent-runtime module maps plus the Agents capability map.
- Checked with no contract update needed: Cron, run-loop, tool orchestration,
  resume/replay, capability overview, MCP, workspace writes, and raw trace; this
  stage only relocates existing implementations and keeps runtime assembly and
  observable behavior unchanged.
- Tests: focused agent-runtime ledger/AgentTool and Host indexed delegate suites;
  affected typechecks and builds passed.

- Status: Verified
- Date: 2026-07-12T08:25:00+0800
- Scope: added the shared Skill command-service hot spot and routed all four
  create entrypoints to the active evolution/module maps.
- Read: `packages/host/src/skill-command-service.ts`, model tool, CLI and both
  TUI create adapters.
- Tests: host/CLI/TUI focused entrypoint suites, affected typechecks, and full
  `npm run release:check` on the same source tree.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: cataloged the active Skill managed-change redesign and routed its
  implemented safe authored-create slice through skills/host/TUI, runtime,
  approval, and resume maps.
- Read: `designs/skill-managed-change-redesign.md` and every linked active map.
- Tests: host Skill focused suites, affected typechecks, TUI approval focused
  suites, and full `npm run release:check`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② route update: read-confidentiality defaults now route through
  core policy, host config/runtime/protocol, CLI run plumbing, TUI config
  compatibility, safety/tool/trace maps, and resume/session routed pages. No
  new hot-path source file needed a root routing entry.
- Read: `packages/core/src/policy.ts`, `packages/host/src/config.ts`,
  `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`,
  `packages/protocol/src/index.ts`, `packages/tui/src/lib/config.ts`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts
test/workspace.test.ts`; `npm --workspace @sparkwright/host test --
test/config.test.ts test/client-run.test.ts`; `npm --workspace
@sparkwright/protocol test`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "confidential"`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-06T20:08:48+0800
- Scope: C8-bundles deletion kept Skill routing on the package/capability maps
  and recorded that `packages/skills/src/bundles.ts` plus its tests were
  retired rather than remaining routed hot spots.
- Read: `packages/skills/src/index.ts`, deleted
  `packages/skills/src/bundles.ts`, deleted
  `packages/skills/test/bundles.test.ts`,
  `docs/_internal/project-map/modules/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skills.md`.
- Tests: `npm --workspace @sparkwright/skills test`;
  `npm --workspace @sparkwright/skills run typecheck`;
  `npm --workspace @sparkwright/skills run build`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a route update: `workflow shadow` and shared
  workflow trace observation now route through host/CLI workflow docs while
  remaining offline/read-only. No protocol/TUI/live-run routing was added.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `packages/host/src/workflow-shadow.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; `npm
--workspace @sparkwright/cli test -- test/cli.test.ts -t "shadows a workflow
asset|distills a session trace|lists and inspects workflow assets"`;
  `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review hardening route: `parallel` now
  requires explicit pass routing and rejects pass edges into branch nodes,
  branch-local `verify` is fail-closed, delegate_parallel infrastructure throws
  become branch runtime errors, runtime terminal failures preserve branch
  diagnostics, and fresh workflow pre-create leases no longer emit misleading
  adoption events. Protocol/CLI/capability surfaces remain unchanged.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/agent-runtime/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
diagnostics"`; `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts -t "lease"`; `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts`; `npm --workspace
@sparkwright/agent-runtime test -- test/workflows.test.ts`.

- Status: Verified
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 routing update: bounded `parallel` / `join`
  nodes route through host workflow parsing/projection and agent-runtime
  durable `parallelBranches` state. All-delegate fan-out reuses the existing
  `delegate_parallel` tool while honoring `maxConcurrency`; join barriers match
  branch state to the unique producer parallel node. Workflow assets still do
  not expose `workflow_start` or a second scheduler/cancellation bus.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/machine.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
-t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T15:31:20+0800
- Scope: workflow-runtime-v1 P4 routing update: workflow script nodes and the
  stdio JSON-RPC node API route through host workflow parsing/projection,
  `workflow-node-api.ts`, `TracedProcessRunner`, shell-sandbox/access clamps,
  and agent-runtime portable workflow types. Core run-loop behavior remains
  workflow-unaware; workflow assets stay request-selected capabilities, not a
  model-facing `workflow_start` surface.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `packages/agent-runtime/src/workflows/types.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts
test/traced-process-runner.test.ts test/external-command-agent.test.ts`;
  `npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts`;
  `npm run release:check`.

- Status: Verified
- Date: 2026-07-05T13:59:13+0800
- Scope: P3 review follow-up routing update: workflow Step 4b.1 catalog
  narrowing now preserves deferred-tool discovery via scoped `tool_search` over
  the filtered worker catalog, and the workflow PreToolUse fallback compares
  allowed tools canonically (`read` permits worker tool `read`). Routed
  through host, tool-orchestration, and capability maps; no public
  protocol/schema change.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts -t "narrows model worker
catalogs|keeps scoped tool_search"`; `npm --workspace @sparkwright/host test
-- test/workflow-hooks.test.ts -t "blocks tools outside|PreToolUse"`.

- Status: Verified
- Date: 2026-07-05T12:23:15+0800
- Scope: workflow-runtime-v1 P3 Step 4b.3 routing update: D11 resolved as no
  `workflow_start` model-facing tool in P3. The checked boundary is host tool
  catalog/capability inventory absence plus proposal wording; no protocol
  schema/reference contract changes were needed.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `packages/host/src/runtime.ts`, `packages/host/src/tool-catalog.ts`,
  `packages/host/src/tool-identities.ts`.
- Tests: `rg -n "workflow_start" packages/host/src packages/host/test
packages/cli/test packages/protocol/src docs/reference`; `npm run
release:check`.

- Status: Verified
- Date: 2026-07-05T12:15:55+0800
- Scope: workflow-runtime-v1 P3 Step 4b.2 routing update: node-level workflow
  `model`/`runBudget` parsing and worker-entry application route through host,
  agent-runtime workflow types, run-loop, tool-orchestration, and capability
  maps; protocol/schema reference docs need no new wire contract for this
  slice.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `packages/host/src/runtime.ts`, `packages/host/src/workflows.ts`,
  `packages/agent-runtime/src/workflows/types.ts`.
- Tests: `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/agent-runtime run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts`; `npm --workspace
@sparkwright/host test -- test/protocol.test.ts -t
"workflow|budget|model"`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow projection acceptance ladder|resumes workflow
runs through the host actor episode driver|run resume through the host"`;
  `npm --workspace @sparkwright/core test -- test/run.test.ts -t
"budget|workflow source budget"`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-05T09:01:34+0800
- Scope: P2 post-review routing update: workflow fresh-run lease adoption,
  todo-supervised terminal finalization/reject handling, workflow actor inbox
  consumption, latest-passed resume re-verification, and waiting-state store
  invariants were routed through host, agent-runtime, and resume-replay maps.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/session/resume-replay.md`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts`; `npm --workspace @sparkwright/host test --
test/workflows.test.ts -t "workflow"`; `npm --workspace @sparkwright/host
test -- test/workflow-hooks.test.ts -t "resume|workflow
projection|projection"`; `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`; `npm run
typecheck:test`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 cross-map update: durable workflow records,
  session-root `workflow-runs/` storage, pinned-definition cross-run resume,
  resume re-verification, workflow list/resume protocol/CLI/SDK surfaces, and
  the D10 no-new-compaction-stage conclusion were routed through existing
  host/agent-runtime/protocol/CLI/session/runtime/trace maps.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/substrate-sequencing.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `docs/_internal/project-map/modules/edge-packages.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/session/session-store.md`,
  `docs/_internal/project-map/maps/session/resume-replay.md`,
  `docs/_internal/project-map/maps/runtime/context-compaction.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts test/doc-store.test.ts`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts test/workflow-hooks.test.ts
-t "workflow"`; `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "workflow|task list|unexpected fields"`; `npm
--workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"`; `npm
--workspace @sparkwright/sdk-core test -- test/client.test.ts`; `npm run
schema:check`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 cross-map update: verification profiles and
  documented-command are host-owned run-level invariants, not implicit workflow
  nodes; delegate child runs no longer inherit global verification/doc-command
  hooks; config/schema rejects `afterWrites.frequency`; outcome/CLI/protocol
  surfaces classify profile and documented-command invariant failures without
  generic workflow double-counting.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run-outcome.test.ts`; `npm --workspace
@sparkwright/host test -- test/workflow-hooks.test.ts
test/documented-command-check.test.ts test/config.test.ts test/tools.test.ts
test/protocol.test.ts -t "createInvariantProjectionHooks|createVerificationWorkflowHooks|documented
command check|verification profiles|afterWrites frequency|runtime workflow
hook assembly|global verifier hooks|resolves profile workflow
hooks|workflow rules|configured verification"`; `npm --workspace
@sparkwright/cli test -- test/run-outcome.test.ts test/cli.test.ts -t
"documented-command|verification profile|shows workflow and event
rules|configured verification profile results"`; `npm run schema:check`;
  `npm --workspace @sparkwright/cli run build`; `npm run check`;
  `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T18:16:44+0800
- Scope: post-review P1.5 closure: removed CLI documented-command live
  post-checks, deleted the dead `verification.stopGate` config surface, kept
  documented-command as a projection verifier checker, and added delegate child
  projection assembly coverage for implicit verification/documented-command
  hooks.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/substrate-sequencing.md`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/index.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/src/run-outcome.ts`,
  `packages/cli/src/cli.ts`,
  `schemas/config.schema.json`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `docs/guides/CONFIGURATION.md`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/cli test --
test/run-outcome.test.ts test/run-outcome-consistency.test.ts`; `npm
--workspace @sparkwright/cli test -- test/documented-command-check.test.ts
test/config-schema.test.ts`; `npm --workspace @sparkwright/host test --
test/config.test.ts -t "verification profiles|invalid verification profile
references"`; `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts test/documented-command-check.test.ts
test/tools.test.ts test/config.test.ts test/protocol.test.ts -t
"workflow|verification|documented-command|documented command|implicit verifier
hooks|profile workflow hooks|delegate_parallel child runs|resolves profile
workflow hooks|verification profiles|invalid verification profile
references"`; `npm run typecheck:test`; `npm run schema:check`; `npm run
release:check`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: routed workflow-runtime-v1 P1.5 deletion work: workflow release gate
  removal, implicit verification/documented-command projection compilation,
  delegate child `workflowHooksForProfile` projection assembly, and
  FactLedger-first verification profile verdicts keyed by explicit
  `verificationSource`, `profile`, and `verifierId` metadata.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/substrate-sequencing.md`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/core/src/fact-classifier.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/src/run-outcome.ts`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `schemas/fixtures/host-message.capability-snapshot.json`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
workflows.test.ts`; `npm --workspace @sparkwright/core test --
test/run-outcome.test.ts test/fact-ledger.test.ts`; `npm --workspace
@sparkwright/host test -- test/workflow-hooks.test.ts
test/documented-command-check.test.ts test/workflows.test.ts
test/protocol.test.ts -t "workflow|verification|documented-command|documented
command"`; `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"profile workflow hooks|delegate_parallel child runs|resolves profile workflow
hooks"`; `npm --workspace @sparkwright/cli test --
test/run-outcome.test.ts test/run-outcome-consistency.test.ts
test/cli.test.ts -t "workflow|verification profile|Verification:|experimental
gate|--workflow"`; `npm --workspace @sparkwright/{agent-runtime,core,host,cli}
run typecheck`.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: routed workflow-runtime-v1 S3 forced-continuation budget work:
  core per-source budget mechanism, `revival` migration, `workflow` source
  registration, `run.budget.exceeded` protocol event, FactLedger budget facts,
  and CLI/TUI visibility boundaries.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/substrate-sequencing.md`,
  `packages/core/src/run.ts`,
  `packages/core/src/types.ts`,
  `packages/core/src/events.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/fact-classifier.ts`,
  `packages/core/src/trace-codec.ts`,
  `packages/protocol/src/index.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/cli/src/event-format.ts`,
  `packages/tui/src/lib/event-type.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run.test.ts -t
"FactLedger|revival|forced-continuation|budget"`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/transcript.test.ts
test/event-stream-render.test.ts -t "budget|internal run machinery"`.

- Status: Verified
- Date: 2026-07-04T09:30:36+0800
- Scope: routed workflow-runtime-v1 S2 FactLedger work: shared fact
  classifiers, live run FactLedger, verification Stop gate ledger reads,
  terminal `run.completed.factLedger`, and trace summary preference for the
  persisted ledger snapshot.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/substrate-sequencing.md`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/fact-classifier.ts`,
  `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/host/src/verification.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run-outcome.test.ts test/run.test.ts
test/trace.test.ts`; `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-04T08:12:53+0800
- Scope: routed workflow-runtime-v1 P0 inspection work: shared
  markdown-folder-asset plumbing, host workflow asset parsing/capability
  snapshots, CLI `workflow list|inspect`, schema-only workflow trace
  vocabulary, workflow run-record pin fields, and reliable workflow waiting
  actor notifications. Core runtime behavior remains unchanged except for
  event-vocabulary reservation.
- Read: `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/substrate-sequencing.md`,
  `packages/skills/src/markdown-folder-asset.ts`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/runtime.ts`,
  `packages/cli/src/cli.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/protocol/src/index.ts`, `packages/core/src/events.ts`,
  `schemas/event.schema.json`, `schemas/host-message.schema.json`.
- Tests: focused skills/host/agent-runtime/CLI vitest routes; related
  workspace typechecks; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-03T08:52:33+0800
- Scope: updated the design catalog entry for Internal Actor Inbox after the
  Step 0 + Step 1 agent-runtime implementation and its typed non-retryable
  actor validation/unsupported-adapter boundaries, retryable capacity overflow,
  and file-backed actor invalid-entry skipping; active routing remains
  agent-runtime plus host/run-loop/tool/trace maps for future receiver-policy
  slices.
- Read: `docs/_internal/project-map/designs/internal-actor-inbox.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/test/tasks.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
typecheck`; `npm --workspace @sparkwright/host test --
test/task-revival.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-02T09:30:00+0800
- Scope: routed the background task lifecycle follow-up across core/host/
  agent-runtime: independent revival forced-continuation budget, cleaned
  `waiting_tasks` race cancellation, detached notification surfacing, and
  `task_create` scheduling validation. Durable detach/resume remains
  proposal-only.
- Read: `docs/_internal/proposals/background-task-lifecycle.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: focused core revival tests and typecheck; agent-runtime task_create/
  notification tests and typecheck; host task-revival/spawn-agent focused tests
  and typecheck.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: routed and refreshed the cross-package background task lifecycle
  implementation through P0-P5: core notification revival, agent-runtime task
  modes/caps/barriers, host task notification bridge and spawn promotion,
  protocol/schema `awaited` and `backgroundTasks`, TUI task state projection,
  governed foreground/background policy, and opt-in depth-bounded nested
  background agent tasks. P4+ durable detach/resume remains proposal-only.
- Read: `docs/_internal/proposals/background-task-lifecycle.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: focused core/agent-runtime/host/protocol/TUI tests and builds for the
  background task lifecycle; `npm run schema:check`; `git diff --check`.

- Status: Verified
- Date: 2026-06-30T01:07:00+0800
- Scope: refreshed TUI/host/protocol routing after adding durable task
  inspection protocol requests and Activity Drawer task browsing, including
  default `activity.open` Ctrl+O and unbound-by-default `events.open` direct
  inspector action.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`,
  `packages/protocol/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`,
  `packages/tui/src/app.tsx`,
  `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/components/status-bar.tsx`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/lib/keybindings.ts`,
  `packages/tui/src/lib/task-activity.ts`,
  `packages/tui/src/lib/tool-display.ts`.
- Tests: `npm --workspace @sparkwright/tui test --
test/activity-panel-render.test.tsx test/status-bar-render.test.tsx
test/toast-store.test.ts test/event-store-active-phase.test.ts
test/keybindings.test.ts test/input-footer.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: root-cause fixes for real-mini tool-surface QA issues: disabled
  discovery no longer leaks `tool_search` prompt guidance, paginated reads
  expose structured `nextOffset` plus backwards-read run-health feedback,
  recovered verification failures no longer produce generic trace report
  command warnings, `run resume --help` is side-effect-free, and TUI
  `/sessions`/`/capabilities` panels align displayed paths/counts with runtime
  configuration and catalog exposure.
- Read: `packages/core/src/context.ts`, `packages/core/src/run-health.ts`,
  `packages/core/src/run.ts`, `packages/core/src/trace-diagnostics.ts`,
  `packages/host/src/tools.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/app.tsx`,
  `packages/tui/src/components/session-list-dialog.tsx`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  relevant focused tests, and routed project/test-map pages.
- Tests: `npm --workspace @sparkwright/core test -- test/context.test.ts
test/run.test.ts test/trace.test.ts`; `npm --workspace @sparkwright/host test
-- test/tools.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "help|run resume"`; `npm --workspace @sparkwright/tui
test -- test/session-list-dialog-render.test.tsx
test/capabilities-panel-render.test.tsx`; typecheck/build for core, host,
  cli, and tui; `node packages/cli/dist/index.js run resume --help`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: refreshed routing for built-in tool surface consolidation: canonical
  public tools are `read`, `write`, `edit`, `bash`, `glob`, and `grep`; advanced
  and infrastructure tools load through discovery and capability inspection
  separates exposure tier from per-run loading.
- Read: `packages/host/src/tool-identities.ts`,
  `packages/host/src/tool-catalog.ts`, `packages/host/src/tool-selectors.ts`,
  `packages/core/src/tools.ts`, `packages/core/src/tool-search.ts`,
  `packages/core/src/context.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `schemas/host-message.schema.json`.
- Tests: `npm --workspace @sparkwright/core test -- test/tool-search.test.ts test/context.test.ts test/run.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx test/tool-request-preview.test.ts test/format-event.test.ts`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: added routing for core approval/policy hot path after fixing
  read-only access-mode safe read approvals, explicit `read` read-only
  governance metadata, and real regression canary drift.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/maps/safety/approvals.md`,
  `packages/core/src/policy.ts`, `packages/core/test/policy.test.ts`,
  `packages/host/src/tools.ts`, `packages/host/test/tools.test.ts`,
  `packages/cli/test/cli.test.ts`, `packages/tui/test/sdk-cutover.test.ts`,
  `scripts/regression-real-skill-capabilities.mjs`,
  `scripts/regression-real-agents.mjs`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts test/access-mode.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts test/permission.test.ts`;
  `npm run build --workspace @sparkwright/core`;
  `npm run build --workspace @sparkwright/host`;
  `npm run build --workspace @sparkwright/cli`;
  `npm run build --workspace @sparkwright/tui`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "read-only access mode|access-mode overrides|accept_edits mode"`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts -t "read-only TUI|approval before running write-capable shell|bypass mode"`;
  `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run regression:real-skill-capabilities`;
  `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run regression:real-agents`;
  real mini CLI read-only trace `session_mqxrirn46qlht3xf` and TUI read-only
  trace `session_tui_mqxrn5zz` verified with 0 approvals and 0 writes.

- Status: Verified
- Date: 2026-06-28T14:13:14+0800
- Scope: refreshed the multi-model design index after implementing the
  simplified `spawnModel` / `delegateModel` MVP and lazy child-scope model
  construction.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/designs/multi-model.md`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/config.ts`, `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/index.ts`, `packages/cli/src/cli.ts`,
  `schemas/config.schema.json`.
- Tests: `npm --workspace @sparkwright/host test --
test/config.test.ts test/tools.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "init"`;
  `npm run schema:check`.
- Prior verification — Date: 2026-06-28T13:34:37+0800
- Scope: refreshed routing after replacing the host process progress JSONL
  inbox with `stdio-v1` stderr token telemetry. The touched hot path spans
  `traced-process-runner.ts`, workflow command hooks, external-command
  delegates, trace filtering/folding, public reference docs, and capability/tool
  orchestration notes.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: refreshed hooks-control-plane routing after the canonical-only P3/P4/P5
  decision: legacy lifecycle values are removed, workflow traces carry one
  `hook` field, event subscribers live under `capabilities.hooks.events`, and
  workflow/event actions support command/http/agent where configured.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: refreshed hooks-control-plane routing after P1/P2 compatibility work:
  documented-command is now an explicit built-in rule pack for inspection and
  active hook metadata, while low-level hook demotion/lifecycle effects are
  documented without lifecycle/action changes.
- Tests: `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`; `npm --workspace @sparkwright/host
run typecheck`; `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli test -- test/documented-command-check.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow
rules in capability inspect"`; `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`.
- Prior verification — Date: 2026-06-27T20:24:22+0800
- Scope: added routing for host active workflow rule descriptors and recorded
  P0 hooks-control-plane inspection as implemented without lifecycle/action
  changes.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "workflow rule|documented-command built-in"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow
rules in capability inspect"`; `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`; `npm run schema:check`.
- Prior verification — Date: 2026-06-27T19:27:28+0800
- Scope: removed `packages/host/src/toolset.ts` routing after deleting the dead
  wrapper and refreshed routing for the touched host/skills cleanup.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/coding-tools.md`,
  `docs/_internal/project-map/modules/skills.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/capabilities/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/runtime/README.md`,
  `packages/host/src/tool-catalog.ts`, `packages/host/src/agent-profiles.ts`,
  `packages/host/src/agent-report.ts`, `packages/host/src/server.ts`,
  `packages/host/src/skill-evolution.ts`,
  `packages/skills/src/loader.ts`, `packages/skills/src/bundles.ts`
  (deleted later by C8-bundles).
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/skills run typecheck`;
  `npm --workspace @sparkwright/host test --
test/agent-profiles.test.ts test/skill-evolution.test.ts
test/protocol.test.ts`; `npm --workspace @sparkwright/skills test --
test/skills.test.ts test/index.test.ts test/bundles.test.ts` (historical);
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "filters
proposals|agents|capabilities inspect"`.
- Prior verification — Date: 2026-06-27T18:53:34+0800
- Scope: normalized map coverage boundaries, added routing for edge packages
  that lacked touch-file entries, and reconciled local ignored docs with the
  "same task / same PR when tracked" maintenance rule.
- Read: `package.json`, `.gitignore`, `README.md`,
  `docs/reference/ARCHITECTURE.md`, `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROVIDER_EDGE.md`, package manifests under `packages/*`,
  source exports/imports for ACP, SDK, provider, server/streaming, shell
  sandbox, project command, trace-perfetto, memory store, and IM gateway edge
  packages.
- Tests: not run; documentation-only routing and consistency pass.
- Prior verification (skills route) — Date: 2026-06-27T17:52:04+0800
- Scope: checked existing `packages/skills/src/*` routing for Skill Runtime v1
  Phase 1 parser/manifest unification; no new touch-file route was needed.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/maintenance/doc-maintenance.md`,
  `docs/_internal/project-map/modules/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `packages/skills/src/index.ts`, `packages/skills/src/manifest.ts`,
  `packages/skills/src/loader.ts`, `packages/skills/src/types.ts`,
  `packages/skills/test/index.test.ts`, `packages/skills/test/skills.test.ts`.
- Tests: `npm --workspace @sparkwright/skills test -- test/skills.test.ts
test/index.test.ts`; `npm --workspace @sparkwright/skills test`;
  `npm --workspace @sparkwright/skills run typecheck`.
- Prior verification — Date: 2026-06-27T01:25:26+0800
- Scope: added routing for markdown-authored agent profiles and delegate runner
  changes; prior trace/session/cron/image routing retained.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/maintenance/doc-maintenance.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `packages/agent-runtime/src/index.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/test/agent-profiles.test.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate|agents|capabilit"`;
  `npm run schema:check`.
- Prior verification (image input) — Date: 2026-06-27T01:06:46+0800
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/maintenance/doc-maintenance.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `packages/host/src/client-input.ts`, `packages/host/src/index.ts`,
  `packages/host/test/client-run.test.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/test/sdk-cutover.test.ts`.
- Tests: `npx prettier --check packages/host/src/client-input.ts packages/host/src/index.ts packages/host/test/client-run.test.ts packages/cli/src/cli.ts packages/tui/src/state/run-controller.ts packages/tui/test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "image attachments"`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts -t "attaches local image"`.
- Prior verification (trace/session/cron) — Date: 2026-06-25T17:16:00+0800
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/maintenance/doc-maintenance.md`,
  `docs/_internal/project-map/designs/trace-diagnostics-refactor.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`,
  `docs/_internal/project-map/maps/session/session-store.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/cron.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `packages/cron/src/runner.ts`, `packages/cron/src/service.ts`,
  `packages/cron/src/tool.ts`,
  `packages/cron/src/store.ts`, `packages/cron/src/schedule.ts`,
  `packages/cli/src/cli.ts`, `packages/tui/src/lib/create-capability.ts`,
  `packages/core/src/trace.ts`, `packages/core/src/trace-codec.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-session-consistency.ts`,
  `packages/core/src/trace-store.ts`, `packages/core/src/index.ts`,
  `packages/core/src/internal.ts`, `packages/tui/src/lib/permission.ts`,
  `packages/core/src/run-outcome.ts`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npx prettier --check packages/core/src/trace.ts packages/core/src/trace-codec.ts packages/core/src/trace-diagnostics.ts packages/core/src/trace-session-consistency.ts packages/core/src/trace-store.ts`;
  `npm run build`; `npm --workspace @sparkwright/streaming-runtime run build`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm --workspace @sparkwright/core test -- test/run.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/cron test -- schedule.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`.
  Also checked for the TUI permission-route update:
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/tui test -- test/config.test.ts test/sdk-cutover.test.ts test/status-bar-render.test.tsx`;
  `npm run schema:check`; `npm run build`; `npm run check:dist-fresh`;
  `git diff --check`.
  For the cron service/tool update:
  `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`;
  `npm --workspace @sparkwright/cron run typecheck`;
  `npm --workspace @sparkwright/cron run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t cron`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "cron|durable"`;
  `npm --workspace @sparkwright/tui test -- test/create-capability.test.ts`;
  deterministic CLI denied-write/approved-write cron run smokes;
  `npm run check:dist-fresh`.
