# Run: TUI input/prompt copy-paste ergonomics

- Date: 2026-06-24
- Direction: user asked where TUI input/prompts and copy-paste are awkward —
  specifically "system hints placed in boxes; copying a path also grabs the
  border".
- Harness: source inspection of `packages/tui/src` PLUS a real Ink render of
  `ToastView` (ink `render()` into a fake 80-col stdout, ANSI-stripped) to
  capture the actual committed frame for the `/export` toast.
- Prompt shape: n/a (read-only code QA).
- Result: confirmed. The render is decisive evidence; only the live *mouse
  selection* step remains unobserved (terminal fundamentals).

## Rendered evidence (real Ink output, 80 cols, raw export path)

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ✓ transcript exported                                                      │
│ /Applications/xgw/projects/AI-native/SparkWright/.sparkwright/exports/sess │
│ ion-session_tui_mq4j14hz-2026-06-24T10-30-00.md                            │
╰──────────────────────────────────────────────────────────────────────────╯
```

This confirms, beyond inference: (1) the FULL raw path is rendered (not
shortened); (2) it hard-wraps across two lines; (3) every content line carries
`│ ` on the left and ` │` on the right; (4) NEW — the wrap splits the path
mid-token (`…/exports/sess` | `ion-session_tui_…`), so even a perfect
block/column selection yields a path with a newline injected inside the
filename. So "grabs the border" is only the surface symptom; the deeper defect
is a long raw path forced into a fixed-width bordered box with hard wrapping.

## What is copy-safe (do not regress)

- The committed scrollback transcript (`event-stream.tsx`) uses Ink `<Static>`
  into native scrollback and indents with **spaces** (`paddingX`/`paddingLeft`),
  never border glyphs. Paths on `workspace.read` / `workspace.write` /
  `tool.completed` lines copy cleanly (only a leading label like `read ` or a
  space rides along, no `│`).

## Findings (owner layer · cause bucket) — reviewed for false positives

1. `/export` path is toast-only, raw, AND auto-dismisses — `app.tsx` export
   command + `components/toast.tsx` + `state/toast-store.ts` · `product_bug`.
   Confirmed strongest case. `controller.exportTranscript()` returns the path
   and the ONLY consumer is `toasts.push({ message: path })` (verified: not
   echoed to scrollback, not in the transcript file body). The path is the raw
   absolute path — NOT run through `formatWorkspaceDisplayPath` — so it wraps,
   and the toast is `variant: "success"` → `DEFAULT_DURATION.success = 3000ms`,
   i.e. it **auto-dismisses after 3s**. So there are really two coupled
   problems: (a) within the 3s window, selecting the path also grabs the round
   border + `paddingX`; (b) you are racing a 3s timer to copy it at all. The
   correct fix (emit a border-free scrollback line) resolves BOTH; shortening
   the path alone fixes neither.
2. Raw copyable paths inside a border · `product_bug`, LOW severity:
   `config-panel.tsx:65` (`{attempt.path}`, full path) and
   `session-list-dialog.tsx:367` (`{artifact.path}`) render full paths inside a
   `DialogFrame` round border. Real but minor — these are inspection panels, not
   the primary "give me a path" path like `/export`.
3. NOT a border bug (avoid false positive): panels that route paths through
   `formatWorkspaceDisplayPath` with a `maxCols` (e.g. `capabilities-panel.tsx`
   skill `sourcePath`, `maxCols: 72`; `config-panel` workspace header). For
   in-workspace paths this returns a **relative** path (shorter, still fully
   copyable); for long/out-of-workspace paths it inserts `…` and is
   **intentionally display-only / not copyable regardless of the border**. The
   border is moot here; do not file these as copy bugs.
4. `input-box.tsx` round border around the prompt · theoretical/minor — you
   typed the path yourself, so re-copying it from the input is a rare need.
   Downgraded from the first pass (was overstated).
5. Glued labels in copy-safe scrollback (`read <path>`, `✎ write <path>`) ·
   minor ergonomic, not a border issue.

## Caveat that bounds all of the above

- Default terminal drag-select is line-based and grabs `│`, but iTerm2 /
  Terminal.app / Windows Terminal all support block/column selection
  (Option/Alt+drag) as a workaround. So this is an ergonomic defect, not an
  impossibility. Do not overstate it as "uncopyable".

## Cause classification

- Root: copy ergonomics were a design constraint for the scrollback transcript
  (spaces, no border glyphs) but never for **transient overlays**. The fix is
  not "remove borders" — it is "give every copy-worthy value a border-free
  scrollback echo". `/export` is the one case where that echo is entirely
  missing AND the only copy is on a 3s timer.

## Suggested directions (not yet implemented)

- For `/export`: also write the path to scrollback (a `tui.notice`-style plain
  line) and/or shorten the toast path. The plain scrollback line is the real
  fix — gives a border-free copy target.
- Consider a convention: any path/id meant to be copied gets emitted as a
  border-free scrollback line, with the bordered overlay used only for the
  transient confirmation.
- Optional: OSC 52 "copy to clipboard" affordance so the user never selects at
  all.

## Residual risk / not done

- No PTY screen capture or real terminal mouse-selection test was run; the
  selection behavior is asserted from terminal fundamentals + source, not
  observed. A cell-aware PTY check would make this `Verified`.
- Did not enumerate every `DialogFrame` consumer's path fields.
