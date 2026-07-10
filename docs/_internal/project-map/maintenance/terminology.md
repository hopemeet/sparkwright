# Terminology

## Purpose

Keep overloaded words stable across docs and code review.

## Contracts

- `run`: one core execution with one `runId`, run-local event sequence, run record, result, and optional checkpoint.
- `session`: a grouping of related runs with `sessionId`, `session.json`, and session event stream.
- `trace`: append-only run event evidence, usually `trace.jsonl`.
- `summary`: derived aggregate over trace events.
- `timeline`: derived phase projection over trace events.
- `verify`: structural trace validation.
- `consistency`: session directory validation across session files, trace, metadata, and run files.
- `transcript.jsonl`: file-store transcript projection for session/agent trace.
- TUI `/export`: Markdown export of TUI session events; not canonical trace.
- `checkpoint`: resumable run snapshot; not an event stream replacement.
- `replay`: projection of persisted events into session/context/display order; not full process restoration.
- `compaction`: future-context summarization that keeps raw history intact.
- `capability`: configured power that can affect context, tools, side effects, or automation.

## Consumers

- Project-map docs.
- Code review discussion.
- Reference docs updates.

## Change Checklist

- Add a term here when a review reveals repeated ambiguity.
- Link to the source contract instead of redefining long behavior here.
- Keep terms consistent with `docs/reference/STATE_AND_TRACE_MODEL.md`.

## Known Debts

- `transcript` is overloaded between file-store transcript and TUI export; prefer explicit names in new docs.

## Last Verified

- Status: Read-only
- Date: 2026-06-18
- Read: `docs/reference/STATE_AND_TRACE_MODEL.md`, `packages/core/src/trace.ts`, `packages/tui/src/lib/transcript.ts`.
- Tests: not run; documentation-only map pass.
