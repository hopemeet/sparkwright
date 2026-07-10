# CLI Workflow Nested Help Side Effects

## Record

- Pattern ID: `cli-workflow-nested-help-side-effects`
- Status: `fixed`
- First seen: 2026-07-07
- Last seen: 2026-07-07
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

Nested workflow help commands are not intercepted uniformly:

- `workflow list --help` executes `workflow list` instead of printing usage.
- `workflow inspect --help` treats `--help` as a workflow name and exits with
  `Workflow not found: --help`.
- `workflow resume --help` treats `--help` as a workflow run id, enters host
  failure handling, and writes a failed trace under the workspace session root.

## Root Cause

The general help interception path covers the top-level `workflow --help` route
but does not recognize subcommand-local help before workflow argument parsing,
asset lookup, or resume host setup.

## Fix

Fixed 2026-07-07 by registering `workflow` with the CLI's nested-help early
interceptor. Regression coverage now runs `workflow
list|inspect|resume|distill|shadow --help` with a malformed config and asserts
that help exits before config parsing or session creation.

## Diagnostic Move

Run nested help commands from an isolated workspace or session root and check
both output and side effects:

```bash
node packages/cli/dist/index.js workflow list --help
node packages/cli/dist/index.js workflow inspect --help
node packages/cli/dist/index.js workflow resume --help
find <workspace>/.sparkwright/sessions -maxdepth 2 -name trace.jsonl
```

Help paths should exit 0 with usage text and must not create session traces.

## Prevention

- Extend `helpForArgs()` / workflow parser coverage for
  `workflow list|inspect|resume|distill|shadow --help`.
- Add CLI tests with a bad config or isolated session root to assert no
  config/model/session/trace setup happens for recognized help paths.

## Related

- Coverage: [../coverage/config-schema.md](../coverage/config-schema.md)
- Related pattern: [cli-run-resume-help-starts-run.md](cli-run-resume-help-starts-run.md)
- Run notes: [../runs/2026-07-07-real-sonnet-broad-qa.md](../runs/2026-07-07-real-sonnet-broad-qa.md)
