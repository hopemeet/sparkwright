# TUI

## Purpose

`@sparkwright/tui` is the terminal product surface. It drives host runs,
renders live events, browses/resumes sessions, handles approvals, and exports a
human-readable transcript.

See also [../maps/trace/export-diagnostics.md](../maps/trace/export-diagnostics.md) and [../maps/session/resume-replay.md](../maps/session/resume-replay.md).

## Main Files

- `packages/tui/src/app.tsx`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/state/event-store.ts`
- `packages/tui/src/lib/tool-display.ts`
- `packages/tui/src/lib/event-type.ts`
- `packages/tui/src/lib/transcript.ts`
- `packages/tui/src/lib/session-events.ts`
- `packages/tui/src/lib/config.ts`
- `packages/tui/src/lib/create-capability.ts`
- `packages/tui/test/*`

## Owns / Does Not Own

Owns:

- terminal UI state and input handling
- live host client lifecycle through `RunController`
- in-memory event store used for rendering and `/export`
- session list, inspect, switch, fork, compact, and rename flows

Does not own:

- canonical trace persistence
- session store file layout
- trace diagnostic report generation
- core approval semantics

## Contracts

- `RunController` sends `run.start` with the current `sessionId`.
- `/image <path>` attaches a local image to the next submitted goal through
  `run.start.input.parts`; `/clear-images` clears pending attachments before
  submission.
- `switchSession()` reloads persisted events from session trace and replays them into TUI state.
- `/export` writes Markdown under `.sparkwright/exports/`.
- `/export` does not mutate or replace `trace.jsonl`.
- `/export` reconstructs trace-shaped tool sections from `tool.requested`/`tool.completed` pairs when needed.
- Live event rendering and `/export` share TUI tool request/result display summaries through `lib/tool-display.ts`.
- Live event rendering and `/export` also share `isInternalTranscriptEvent()`
  from `lib/event-type.ts`; that wrapper delegates to protocol
  `isInternalTranscriptEventType()` so low-signal runtime machinery stays
  filtered consistently across the TUI event stream, exported transcript raw
  tail, and other clients that use the shared protocol list.
- Live `EventStream` renders `subagent.*` lifecycle rows from structured
  metadata/payload facts (`subagentDepth`, parent/child ids, `entrypoint`,
  `delegateTool`, and terminal state fields). It indents by depth but keeps the
  append-only `<Static>` row contract: each event renders once and is not
  mutated after later child events arrive.
- Ctrl+C is guarded: one press cancels or backs out of the current surface, and
  an idle no-layer prompt requires a second press to exit.
- Long `/sessions` lists keep the selected row visible while navigating; row
  windows are presentation state and do not affect session storage order.
- TUI UI preferences are read from the same config files the host loaded
  (`config.json`, `config.yaml`, or `config.yml`), so same-layer conflict and
  format precedence stays host-owned.
- TUI capability creation flows use host config read/write helpers and preserve
  an existing project YAML file when adding MCP servers or agent profiles.
- TUI-created stdio MCP server configs omit `cwd` by default so the MCP adapter
  can apply neutral-cwd isolation; project cwd access requires an explicit
  later config edit.
- The capabilities panel treats the built-in primary `main` profile as the
  current run's root agent, not as a configured user agent; it is excluded from
  the displayed configured-agent count and list.
- Header and config-panel workspace paths use middle ellipsis when terminal
  width is tight, preserving the basename so deep workspaces stay identifiable
  without wrapping the first screen.
- Capability panels, Skill review metadata, and Skill learn toasts render host
  paths through the shared display-path projection: workspace paths become
  relative and external absolute paths collapse to non-host locators.

## Consumers

- End users running `sparkwright tui`.
- TUI rendering and state tests.
- Host protocol responses and event streams.

## Change Checklist

- Check `RunController` when changing host protocol requests/responses.
- Check `renderTranscript()` when changing event names or exported Markdown expectations.
- Check `lib/tool-display.ts` when changing tool request/result presentation in either live TUI or `/export`.
- Check session list/inspect/fork flows when changing session diagnostics.
- Avoid treating TUI state as canonical storage.

## Known Debts

- Human export is useful but not a full diagnostic report.
- Session completion metadata is not as prominent as trace/session inspection output.
- TUI display summaries are presentation-only; raw trace/session diagnostics remain the source of truth for complete payloads.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/tui/src/app.tsx`, `packages/tui/src/components/capabilities-panel.tsx`, `packages/tui/src/components/config-panel.tsx`, `packages/tui/src/components/event-stream.tsx`, `packages/tui/src/components/layer-renderer.tsx`, `packages/tui/src/components/skill-review-dialog.tsx`, `packages/tui/src/lib/path-display.ts`, `packages/tui/test/capabilities-panel-render.test.tsx`, `packages/tui/test/event-stream-render.test.ts`, `packages/tui/test/path-display.test.ts`, `packages/tui/test/skill-review-dialog-render.test.tsx`, `packages/protocol/src/index.ts`.
- Tests: `npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts`; `npm --workspace @sparkwright/tui run build`.
