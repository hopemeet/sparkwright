# TUI Static Header Stale Model Label

## Record

- Pattern ID: `tui-static-header-stale-model`
- Status: `fixed`
- First seen: 2026-06-24
- Last seen: 2026-06-24
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

After switching the model in the TUI (`/model` dialog commit), the `model …`
line in the top welcome header keeps showing the original/default model. It never
updates to the newly selected model.

## Root Cause

The top header is row 0 of the `EventStream` `<Static>` items array
(`packages/tui/src/components/event-stream.tsx` — `HeaderRow`, fed by
`props.header.modelLabel`). Ink `<Static>` renders each item exactly once and
never repaints committed rows. `EventStream` is keyed only on
`state.clearGeneration` (`packages/tui/src/app.tsx:1520`), which remounts only on
`/clear` and `/new` — not on a model change.

So when `/model` commits, `setModelOverride` updates `effModel` → `modelLabel`
and the component re-renders, but the already-committed header row is frozen at
its first-render value. The default model is "永远" displayed at the top.

The reactive model indicator (`StatusBar`, `packages/tui/src/components/status-bar.tsx`)
does reflect `modelLabel` correctly, but it only renders while
`status === "running" || "awaiting-approval"` (`app.tsx:1533`). When idle —
exactly the window right after a `/model` switch and before the next run — there
is no live model indicator on screen, leaving only the stale header. A
`success` toast (`{model} (next run)`) confirms the switch transiently.

## Fix

Partially fixed 2026-06-24 in `packages/tui/src/app.tsx`
(`commitModelSelection`).

- `/model` commits now append a TUI-local `tui.notice` row
  (`model -> <ref> (next run)`) so the model switch lands in committed
  scrollback without remounting `EventStream`. A no-op pick (same model) closes
  the dialog silently. Covered by `packages/tui/test/event-stream-render.test.ts`.
- The static header remains keyed only by `state.clearGeneration`; the model is
  not included in `EventStream`'s key, avoiding the
  `tui-static-header-duplication` regression.

NOT YET DONE: the idle live-line model indicator. `StatusBar` still renders only
while `status === "running" || "awaiting-approval"` (`app.tsx:1536`), so at rest
there is still no on-screen readout of the current model — only the (by-design)
session-start header and the scrollback notice from the last switch. If product
wants an at-rest "current model" indicator, that remains open.

## Diagnostic Move

Read source first — this is a deterministic `<Static>` contract, not model
variance. Confirm: (1) the header label is inside the `<Static>` items list,
(2) `EventStream`'s `key=` does not include the model, (3) the only other model
display gates on run status. PTY capture optional; if used, commit a `/model`
switch while idle and assert the top `model …` line is unchanged.

## Owner Layer

TUI rendering (`packages/tui`).

## Fix Directions

1. (Scrollback-native, preferred) On `/model` commit, append a committed
   transcript row (e.g. a `tui.notice`-style line `model → <ref>`) so the switch
   lands durably in scrollback instead of only a transient toast. Leaves the
   one-time header as a record of the session's starting model.
2. Make the idle live line carry the current model so there is always an
   accurate on-screen indicator — but weigh against the minimal-chrome
   preference (no always-pinned boxes).
3. Do NOT simply add the model to `EventStream`'s `key` — that reprints the
   whole brand banner into scrollback on every switch (regresses toward
   `tui-static-header-duplication`).

Implemented 2026-06-24: direction 1 only. Direction 2 (idle live-line carrying
the current model) is NOT implemented — `StatusBar` still gates on
running/approval. `/config` still shows resolved configuration rather than the
runtime override; classify that separately if product wants `/config` to expose
active runtime state too.

## Related

- Failure: [./tui-static-header-duplication.md](./tui-static-header-duplication.md)
- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
