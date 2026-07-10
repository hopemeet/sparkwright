# Change Checklists

## Purpose

Shared checklist for high-risk SparkWright changes. Use this with the relevant
module and map pages before opening a larger change.

## Main Files

- `docs/_internal/project-map/README.md`
- `docs/reference/STATE_AND_TRACE_MODEL.md`
- `docs/reference/RUN_EVENTS.md`
- `docs/reference/PROTOCOL.md`
- `docs/reference/HOST_PROTOCOL.md`

## Contracts

- Do not change trace/session/runtime behavior without checking every consumer.
- Do not treat derived diagnostics as canonical state.
- Do not treat TUI export as trace inspection.

## Change Checklist

- Trace event changed: update core trace filters, summary/timeline/verify, `RUN_EVENTS.md`, schemas, docs, and CLI/TUI rendering.
- Session layout changed: update `STATE_AND_TRACE_MODEL.md`, consistency/repair, host session methods, CLI session commands, TUI session flows.
- Host protocol changed: update `packages/protocol`, host runtime, SDKs, CLI/TUI clients, `HOST_PROTOCOL.md`.
- Tool changed: update policy metadata, approval behavior, trace payload size, tool result summaries, tests.
- Workspace write changed: update approval path, artifacts, write-pair diagnostics, rollback/checkpoint behavior.
- Capability changed: update capability inspect, trace events, config docs, CLI/TUI surface.
- Install/path layout changed: update `doctor paths`, install/uninstall docs,
  source install smoke, and capability/state layering notes; verify user XDG
  config/state and project `.sparkwright` directories are not deleted by
  uninstall.
- Root build/check gate changed: verify `npm run build && npm run
check:dist-fresh` when the gate depends on compiled `dist/` freshness.
- Resume changed: update checkpoint behavior, from-trace fallback, CLI/host paths, TUI replay assumptions.

## Consumers

- Maintainers touching runtime, trace, session, tool, host, CLI, or TUI code.

## Known Debts

- This checklist is intentionally general. Add file-specific links to the root project-map README when repeated misses occur.

## Last Verified

- Status: Read-only
- Date: 2026-06-20
- Read: project-map cleanup audit.
- Tests: not run; documentation-only map pass.
