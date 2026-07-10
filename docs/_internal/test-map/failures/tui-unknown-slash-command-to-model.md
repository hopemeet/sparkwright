# Unresolved Slash Input Is Intentionally Submitted As A Goal

## Record

- Pattern ID: tui-unknown-slash-command-to-model
- Status: `watch`
- First seen: 2026-06-24
- Last seen: 2026-06-24
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     0 |
| `test_bug`              |     1 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

> Diagnostic-caution note (like the `pyte` border false positive): this was
> first written up as a `product_bug` and corrected after reading the source.
> Do **not** classify "unrecognized `/command` reached the model" as a defect
> without checking `detectSlash` + the registry first.

## Symptom

A `/`-prefixed input that does not resolve to a registered command is submitted
to the model as a run goal (real call) instead of producing a local "unknown
command" message. Observed with `/nonexistentcmd`.

## Why It Is Not A Clean Bug

`packages/tui/src/components/input-box.tsx`:

- `detectSlash` (line ~1133) returns slash mode for **any** value starting with
  `/`, not just command-shaped tokens.
- At submit (lines ~557-567) the parsed name is looked up via
  `registry.resolve`; if found it dispatches, otherwise it falls through to
  `props.onSubmit(trimmed)`.

That fall-through is **load-bearing**: it is what lets legitimate goals that
start with a slash reach the model — e.g. `/etc/hosts is misconfigured`,
`/api/users returns 500`, `/usr/local/bin needs fixing`. Blocking unresolved
slash input would break those.

The common typo is already handled: `registry.search` does prefix/substring
matching, so `/session`, `/cap`, etc. surface a suggestion panel with ghost
completion and Enter-to-accept. Only a non-prefix typo (`/sessons`
transposition) or a fully invented `/foo` falls through — and that case is
genuinely ambiguous with a one-token slash goal, so there is no reliable signal
to separate them.

## Diagnostic Move

1. Before calling this a bug, read `detectSlash` and `parseSlashCommand` and
   confirm whether the input was command-shaped or a slash-prefixed goal.
2. Check `registry.search` behavior for the typed query: a prefix/substring
   match means the suggestion panel already covers the case.
3. Only the residual non-prefix-typo class is a real UX paper-cut, and it is a
   product tradeoff, not a defect.

## Prevention

- If the product later wants to catch this narrow class, it must be a
  _non-blocking_ hint gated on a near-match (e.g. small edit distance to a
  command name) with no rest-of-line — never a hard block on unresolved slash
  input, or it will swallow legitimate `/`-prefixed goals.

## Related

- Scenarios: (none)
- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run notes: [../runs/2026-06-24-tui-logic-usability-rigor.md](../runs/2026-06-24-tui-logic-usability-rigor.md)
