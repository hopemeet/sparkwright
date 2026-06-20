# Export Diagnostics

## Purpose

Clarify the difference between trace diagnostics and TUI human transcript export.

This is a high-risk confusion point: `/export` is useful, but it is not the
canonical trace or a session consistency report.

## Main Files

- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/lib/tool-display.ts`
- `packages/tui/src/lib/transcript.ts`
- `packages/tui/src/app.tsx`
- `packages/host/src/runtime.ts`
- `packages/core/src/trace.ts`

## Data Flow

```txt
TUI currentSessionEvents
  -> renderTranscript()
  -> .sparkwright/exports/session-<id>-<timestamp>.md

session trace.jsonl
  -> summary/timeline/verify/consistency
  -> session diagnostics
```

## Contracts

- TUI `/export` writes Markdown under `.sparkwright/exports/`.
- TUI `/export` uses `currentSessionEvents` in the controller, not `trace.jsonl` directly.
- The export renderer groups user goal, assistant stream text, tools, writes, approvals, terminal events, and a compact raw-events tail.
- Tool result sections may reconstruct the tool name from the earlier `tool.requested` event when terminal tool events only carry `toolCallId`.
- Tool request/result presentation uses the same `lib/tool-display.ts` summaries as live TUI rendering, with export mode summarizing structured envelopes instead of dumping raw JSON.
- Live `EventStream` renders `subagent.*` rows as a depth-aware tree from
  structured facts. `/export` remains a transcript/export surface, not a
  replacement for `trace report`; auditability findings belong in trace
  diagnostics.
- Unknown events are listed compactly so the export is not fully silent about unsupported events.
- Internal/low-signal runtime machinery is filtered through
  `isInternalTranscriptEvent()` shared with live event rendering. The TUI
  wrapper delegates to protocol `isInternalTranscriptEventType()`; add new
  internal event names there instead of duplicating switch cases in transcript
  or live rendering.
- Trace diagnostics remain source-of-truth for structural checks.

## Consumers

- TUI users sharing or reviewing a conversation.
- Maintainers comparing product transcript UX against trace diagnostics.

## Change Checklist

- Do not add diagnostic claims to `/export` unless backed by trace/session inspection.
- If `renderTranscript()` supports a new event family, check event-store replay and session switch behavior.
- If a tool payload needs a special display rule, add it to `lib/tool-display.ts` and cover both live event stream and transcript export expectations.
- If export should include persisted history, confirm it loads from session trace first.
- Keep this separate from `trace verify` and `session check` semantics.

## Known Debts

- `/export` is still a transcript, not the trace report; users needing run health should use `trace report` or session diagnostics.
- Session metadata completion state is less prominent in current product views than raw diagnostics.
- Structured tool outputs are summarized for readability; use `/events`, trace commands, or session diagnostics for full payload inspection.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/tui/src/app.tsx`, `packages/tui/src/components/capabilities-panel.tsx`, `packages/tui/src/components/event-stream.tsx`, `packages/tui/src/components/skill-review-dialog.tsx`, `packages/tui/src/lib/event-type.ts`, `packages/tui/src/lib/path-display.ts`, `packages/tui/src/lib/transcript.ts`, `packages/tui/test/capabilities-panel-render.test.tsx`, `packages/tui/test/event-stream-render.test.ts`, `packages/tui/test/path-display.test.ts`, `packages/tui/test/skill-review-dialog-render.test.tsx`, `packages/tui/test/transcript.test.ts`, `packages/protocol/src/index.ts`.
- Tests: `npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts`; `npm --workspace @sparkwright/tui run build`.
