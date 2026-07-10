# CLI Run Resume Help Starts Run

## Record

- Pattern ID: `cli-run-resume-help-starts-run`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
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

`node packages/cli/dist/index.js run resume --help` does not print help. It
parses `--help` as a run id, fails validation with
`runId must contain only letters, numbers, dot, underscore, or hyphen`, and
writes a failed trace under the current workspace session root.

## Root Cause

The nested `run resume` help path is not intercepted before resume argument
validation and host/failure-trace setup.

## Diagnostic Move

Run the command from an isolated workspace or session root and inspect:

- exit code should be help success, not failed run
- stdout/stderr should contain usage, not host-start failure
- no `.sparkwright/sessions/<id>/trace.jsonl` should be created for help

## Prevention

- Add a CLI parser test for `run resume --help`.
- Keep the general invariant that any recognized `--help` path exits before
  config loading, session allocation, model setup, or trace creation.

## Fix

- 2026-06-29: `packages/cli/src/cli.ts` now handles
  `run resume --help` in `helpForArgs()` before config loading or resume
  parsing. Added `packages/cli/test/cli.test.ts` coverage with a bad config and
  asserted no `.sparkwright/sessions` directory is created.
- Verified with `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"help|run resume"`, `npm --workspace @sparkwright/cli run typecheck`,
  `npm run build --workspace @sparkwright/cli`, direct
  `node packages/cli/dist/index.js run resume --help`, and
  `npm run check:dist-fresh`.

## Related

- Coverage: [../coverage/config-schema.md](../coverage/config-schema.md)
- Run notes: [../runs/2026-06-29-real-mini-tool-surface-followup.md](../runs/2026-06-29-real-mini-tool-surface-followup.md)
