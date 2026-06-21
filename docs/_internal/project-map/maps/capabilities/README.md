# Capability Maps

## Purpose

Capability maps explain how optional power enters a run: skills, MCP, agents,
cron, shell/task tools, and capability inspection.

## Main Files

- `packages/host/src/runtime.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/toolset.ts`
- `packages/host/src/tools.ts`
- `packages/skills/src/*`
- `packages/mcp-adapter/src/index.ts`
- `packages/agent-runtime/src/*`
- `packages/cron/src/*`

## Data Flow

```txt
config + workspace capability roots
  -> host capability preparation
  -> host tool catalog
  -> CLI diagnostic catalog profile for direct-core/cron runs
  -> tools/context/events/snapshot
  -> run context and capability.inspect
```

## Contracts

- Capabilities affect model input, tool availability, policy, or side effects and must be trace-visible.
- Capability inspection is diagnostic; it does not replace run trace.
- File-authored capabilities use builtin/user/project roots; config-declared
  capabilities such as MCP servers, ACP delegates, external-command delegates,
  hooks, and verification remain in config rather than directory discovery.
- Config-declared capabilities can live in JSON or YAML config files. Host owns
  parsing, same-layer conflict diagnostics, and serialization helpers; CLI/TUI
  and managed capability tools should reuse those helpers when mutating config.
- `capability.inspect` should report runtime tools from the host catalog so sources/deferred flags match the actual run surface.
- Workspace-write capability includes the whole-file `write_file` tool in
  addition to anchored edits and unified patches; capability inventories and
  selector filtering should expose all three from the host catalog.
- Host tool catalog entries keep source metadata only; unused exposure metadata
  was removed.
- CLI `capabilities inspect` derives its `tools.available` diagnostic inventory from the host runtime snapshot, with delegate/MCP labels layered on top for display.
- Direct-core and cron non-host runs use the host CLI diagnostic catalog profile for concrete tool definitions, so capability config (`disabled`/`defer`) applies consistently there too.
- Top-level `tools.use`, `tools.allowed`, `tools.disabled`, and `tools.defer`
  are the active tool configuration fields; legacy `capabilities.tools` is
  rejected at config validation. `use` keeps high-level selector groups,
  `allowed` keeps only listed concrete tool names, `disabled` removes concrete
  names even if otherwise selected, and `defer` only changes schema loading for
  tools that remain.
- `capabilities inspect` displays configured selectors and the final runtime
  inventory, so selector filtering must happen before snapshots and diagnostic
  inventories are built.
- Agent profiles can also carry `use` selectors; configured and dynamic
  delegate tools must derive child catalogs from the intersected profile/tool
  selectors and enforce `capabilities.agents.maxDepth` before starting nested
  work.
- Regression and smoke scripts must not recreate removed tool allowlists; use
  the default tool surface or top-level negative filters.
- Real-model skill capability regression preserves JSON/YAML config layers,
  recognizes top-level `providers` and grouped `identity.providers`, and should
  use `capabilities inspect` evidence rather than a local hard-coded tool list.
- Capability roots and generated state have different persistence rules.
- Source-install/path changes are covered by `npm run source:install-smoke`,
  which verifies package install layout, `doctor paths`, installed CLI/TUI/ACP
  entrypoints, deterministic run behavior, and uninstall boundaries.
- IM gateway config/state use XDG paths only; `~/.sparkwright` is reserved for
  source-installed program files.
- Cron state and host crash logs are user state under XDG state, not project
  capability roots.

## Consumers

- Host runtime.
- CLI `capabilities inspect`.
- TUI capabilities panel and create flows.
- Trace timeline for capability events.

## Change Checklist

- Read the relevant child page: [skills.md](skills.md), [mcp.md](mcp.md), [agents.md](agents.md), or [cron.md](cron.md).

## Known Debts

- Capability layering and self-evolution are evolving; keep stable runtime behavior separate from design proposals.
- CLI `tools list` has been removed; use `capabilities inspect` for tool inventory and `tools allow|disable|defer` for config writes.
- Do not add one-off direct-core/cron tools for capability smokes; exercise the same coding tools used by host runs.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/host/src/tool-catalog.ts`, `packages/host/src/tool-selectors.ts`, `packages/host/src/tools.ts`, `packages/project-context/src/index.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/runners/direct-core-runner.ts`, `packages/tui/src/components/capabilities-panel.tsx`, `packages/tui/src/lib/create-capability.ts`, `scripts/regression-real-skill-capabilities.mjs`, `packages/host/test/tools.test.ts`, `packages/tui/test/capabilities-panel-render.test.tsx`, `packages/tui/test/create-capability.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`; `npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx`; `npm --workspace @sparkwright/tui test -- test/create-capability.test.ts`; `npm run build`; `npm run check:dist-fresh`; `npm run regression:real-skill-capabilities`.
