# TUI Export Missing User Goal

## Record

- Pattern ID: `tui-export-missing-user-goal`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
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

TUI `/export` can create a Markdown transcript whose `## User` section says
`_(no goal text)_` even though the run trace contains the submitted goal.

Evidence from the PTY run:

- trace `run.created.payload.goal`:
  `Inspect README.md and answer in one short sentence.`
- trace `model.requested.payload.goal` carried the same goal.
- exported Markdown line 12 rendered `_(no goal text)_`.

## Root Cause

Fixed 2026-06-29. `packages/tui/src/lib/transcript.ts` rendered the user section from
`run.started.payload.goal`. In the observed TUI trace, `run.started` only
contained `resolvedModel`; the goal was on `run.created` and `model.requested`.

## Diagnostic Move

Run a deterministic TUI prompt, export, then compare:

```bash
node packages/cli/dist/index.js trace events "$trace" --type run.created --jsonl
node packages/cli/dist/index.js trace events "$trace" --type run.started --jsonl
rg -n "no goal text|<submitted prompt>" "$export_md"
```

If `run.created` has the goal while the export says `_(no goal text)_`, this
pattern reproduced.

## Prevention

`renderTranscript()` now collects a per-run goal from `run.created`,
`model.requested`, and `run.started`, in that order, then renders the `## User`
section once per run. The legacy goal-less `run.started` fallback remains for
old traces that have no goal evidence at all.

Focused coverage:

```bash
npm --workspace @sparkwright/tui test -- test/transcript.test.ts
```

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Project map: [../../project-map/maps/trace/export-diagnostics.md](../../project-map/maps/trace/export-diagnostics.md)
- Run notes: [../runs/2026-06-29-mcp-cron-tui-agent-boundary-qa.md](../runs/2026-06-29-mcp-cron-tui-agent-boundary-qa.md)
