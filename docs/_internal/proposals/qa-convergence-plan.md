# QA Convergence Plan

Status: Stub home created 2026-07-06 from C12. The original five-phase plan has
not been found in `docs/_internal/proposals/` or `docs/_internal/reviews/`.
This page gives the active QA convergence work a proposal home without
inventing missing design detail.

## Known Anchors

- Residual six-findings items `#1`, `#3`, `#5`, and `#6` are still open.
- The plan must preserve the principle `保事实、调信号`: raw trace/session facts
  stay intact, while summaries, reports, and diagnostics may tune severity or
  presentation.
- A path primitive is part of the intended convergence, but the exact owner,
  API, and migration steps are待补.
- "Single foreground budget" refers to shell/task `foregroundTimeoutMs`, not the
  core work budget or the S3 forced-turn budget; see
  [`substrate-sequencing.md`](substrate-sequencing.md).
- Fact-preserving finality is an end-state requirement: terminal diagnostics
  must not rewrite raw outcomes to make reports look cleaner.

## Five-Phase Skeleton

The phase names below are placeholders to reserve the five-phase shape. Entries
marked待补 are not implementation commitments.

1. **Path primitive** — 待补. Expected to remove duplicated path interpretation
   in QA/reporting paths before later signal changes depend on it.
2. **Single foreground budget** — 待补. Keep the scope limited to shell/task
   foreground promotion/kill timing unless a later proposal explicitly widens
   it.
3. **Fact-preserving finality** — 待补. Define which raw facts are immutable and
   which report-layer signals may be adjusted.
4. **Residual findings #1/#3/#5/#6** — 待补. Map each remaining finding to one
   of the converged primitives above before implementation.
5. **Closure and archive** — 待补. Move this page to reviews only after the
   residual findings are closed or explicitly superseded.

## Non-Goals Until Filled

- Do not add new QA signals that rewrite raw trace/session facts.
- Do not add another foreground-budget mechanism; consume the existing
  shell/task budget vocabulary.
- Do not implement from this stub alone. The next edit must replace待补 slots
  with sourced details or mark the corresponding phase out of scope.
