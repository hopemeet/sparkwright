# 2026-06-24 TUI Logic / Usability / Rigor QA

## Summary

- Scenario: User direction "测测这个项目的tui，逻辑、易用性、科学性上" — exercise the
  TUI on logic, usability, and reporting rigor via real-model PTY capture.
- Coverage: read-only run lifecycle, usage-line accuracy vs trace, narrow-width
  (`60`-col) `/help` panel, and unrecognized-slash-command dispatch.
- Result: `pass` (no product bug). Rendering and reporting rigor pass; one
  narrow UX tradeoff noted in slash-command dispatch.
- Reusable lesson: An unrecognized `/command` is submitted to the model as a
  goal — but this is **intentional**, not a bug. The fall-through is load-bearing
  (it supports `/path`-style goals like `/etc/hosts is broken`), and prefix
  typos are already caught by the suggestion panel. Initially over-called as a
  `product_bug`; corrected after reading `detectSlash` + the registry.

## Test Setup

- Prompt shape: `strong` (read-only question), plus deterministic UI inputs
  (`/help`, `/nonexistentcmd`).
- Model class: real `openai/gpt-5.4-nano`.
- Capabilities: default toolset (read_file/glob/grep/shell/...); read-only.
- Permission/approval posture: read-only; no writes, no approvals triggered.
- Workspace/config isolation: temp fixture under `/tmp/sw-tui-qa.*` with a
  README + `src/index.js`; user config resolved the nano model.
- Trace level: `debug`. Terminal sizes `120x32`, `80x24`, `60x30`.
- Harness: PTY + `pyte` via `/tmp/tui-venv` (system python is PEP-668 managed;
  pyte installed into a venv).
- Environment note: workspace `dist` was stale at start; rebuilt with
  `npm run build` before any TUI capture (`check-dist-fresh` then clean).

## Stable Evidence

- Read-only run completed; final answer rendered under a single `SparkWright`
  header, no raw JSON, input border aligned at 120 cols.
- Usage line `usage ctx 5.2k · in 5.2k (3.1k cached) / out 49 · calls 1 model /
  0 tool` matched the final `usage.updated` payload exactly: input 5181,
  cached 3072, output 49, modelCalls 1, toolCalls 0, contextTokens 5181. Cost
  correctly hidden (`costStatus: unavailable`, missing_pricing). `trace verify`
  = `status: ok`, 0 findings.
- `/help` at 60 cols rendered a clean bordered panel with text wrapped inside
  the border and a `28 more ↓` scroll affordance; aligned right border.

## Non-Invariants Observed

- nano did not call its read tools for "what does the add function do?"; it
  asked the user to paste the code instead. `model_variance` /
  `prompt_underspecified`, not a TUI defect.
- A mid-stream `__DUMP__` showed a momentarily truncated input bottom border
  while assistant text was streaming; treated as a transient capture artifact
  (prior runs warned about `pyte` border false positives), not classified.

## Failures

- Product failure: none.
- UX tradeoff (not a bug): `/nonexistentcmd` + Enter submits the literal text to
  the model as a goal. Re-audit of `input-box.tsx` (`detectSlash` line ~1133;
  submit lines ~557-567) shows the unresolved-slash → `onSubmit` fall-through is
  intentional and load-bearing — it lets `/path`-style goals
  (`/etc/hosts is broken`, `/api/users returns 500`) reach the model. Prefix
  typos (`/session`) are already caught by `registry.search` suggestions with
  ghost completion + Enter-to-accept (verified on screen). Only a non-prefix
  typo / invented command falls through, and that is ambiguous with a one-token
  slash goal.
- Cause bucket: `test_bug` — I initially over-called this a `product_bug`;
  corrected after reading source.
- Count update: caution note `failures/tui-unknown-slash-command-to-model.md`
  (reframed from product_bug to a do-not-misclassify watch note).

## Related (CLI, out of TUI scope)

- `node packages/cli/dist/index.js --version` is interpreted as a run goal
  (fires a real model call) instead of printing a version. CLI-layer; noted for
  follow-up, not fixed here.

## Coverage Update

- Page: `coverage/tui-rendering.md` — added 60-col `/help` pass, usage-line vs
  trace rigor check, and the unknown-slash-command gap under Weak/Untested.

## Follow-Up

- Decide intended behavior for unrecognized `/`-prefixed input (inline error +
  suggestions vs. forward-as-goal). Recommend catching it locally.
- Add a focused input-box test asserting an unknown slash command does not call
  `onSubmit`.
