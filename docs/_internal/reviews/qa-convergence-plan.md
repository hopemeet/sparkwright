# QA Convergence Plan

Status: Closed as unsourced planning stub; archived 2026-07-18.

The original five-phase plan was not found in repository history,
`docs/_internal/proposals/`, or `docs/_internal/reviews/`. The numbered
"six-findings" source was also never recovered, so its `#1/#3/#5/#6` labels
cannot be mapped to verifiable requirements without invention. This page is
therefore not an active proposal. It is retained only to explain why the stub
was closed.

Future QA convergence work must start from a source-linked failure pattern,
coverage gap, or scenario under `docs/_internal/test-map/`; current runtime
contracts remain in the project map and source.

## Known Anchors

- The stub named residual six-findings items `#1`, `#3`, `#5`, and `#6`, but
  their source and definitions were never recovered.
- The plan must preserve the principle `保事实、调信号`: raw trace/session facts
  stay intact, while summaries, reports, and diagnostics may tune severity or
  presentation.
- A path primitive is part of the intended convergence, but the exact owner,
  API, and migration steps are待补.
- "Single foreground budget" refers to shell/task `foregroundTimeoutMs`, not the
  core work budget or the S3 forced-turn budget; see
  [`substrate-sequencing.md`](../proposals/substrate-sequencing.md).
- Fact-preserving finality is an end-state requirement: terminal diagnostics
  must not rewrite raw outcomes to make reports look cleaner.

## Historical Five-Phase Skeleton

The phase names below were placeholders only. They are not implementation
commitments and must not be reopened without recovered source evidence.

1. **Path primitive** — 待补. Expected to remove duplicated path interpretation
   in QA/reporting paths before later signal changes depend on it.
2. **Single foreground budget** — 待补. Keep the scope limited to shell/task
   foreground promotion/kill timing unless a later proposal explicitly widens
   it.
3. **Fact-preserving finality** — 待补. Define which raw facts are immutable and
   which report-layer signals may be adjusted.
4. **Residual findings #1/#3/#5/#6** — 待补. Map each remaining finding to one
   of the converged primitives above before implementation.
5. **Closure and archive** — closed by retiring the unsourced stub rather than
   inventing definitions for missing findings.

## Closure Boundary

- Do not add new QA signals that rewrite raw trace/session facts.
- Do not add another foreground-budget mechanism; consume the existing
  shell/task budget vocabulary.
- Do not implement from this stub. A future proposal needs named source
  evidence, current ownership, and test-map coverage; it must not inherit the
  missing finding numbers as requirements.
