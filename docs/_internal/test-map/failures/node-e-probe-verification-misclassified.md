# Node E Probe Verification Misclassified

## Record

- Pattern ID: `node-e-probe-verification-misclassified`
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

A mixed real-mini shell trace intentionally ran an unrelated failing command:

```bash
node -e "console.error(\"intentional unrelated failure\"); process.exit(7)"
```

The same run also had a real `npm test` failure that was later recovered by a
successful `npm test`. `trace report` correctly kept the run non-clean, but it
classified the `node -e` probe as unresolved verification and emitted
`UNRESOLVED_VERIFICATION_FAILURES`.

## Root Cause

`run-outcome.ts` treats any non-probe command as verification-relevant when the
goal is verification-like. `node -e` was not in the probe list, so ad-hoc Node
snippets polluted the verification failure ledger.

`trace-diagnostics.ts` also preferred persisted `run.completed.commandOutcome`
snapshots even when the raw debug trace still had complete shell command
arguments, so re-running report on an old debug trace could keep stale
classification.

## Diagnostic Move

For shell failure reports, compare:

- `commandFailures.total`
- `commandFailures.verification.total/unresolved`
- raw `tool.requested.arguments.command`
- whether the command is a test/check runner or an ad-hoc probe (`node -e`)

If raw debug events retain command args, report diagnostics should recompute
classification rather than trust stale persisted snapshots.

## Prevention

- Treat `node -e` as a probe/ad-hoc command unless it is wrapped by an explicit
  test runner.
- Prefer recomputed command outcomes when raw shell command evidence is
  complete; keep persisted snapshots for standard/legacy traces without args.

## Fix

- 2026-06-29: `packages/core/src/run-outcome.ts` now classifies `node -e` as a
  probe command.
- 2026-06-29: `packages/core/src/trace-diagnostics.ts` recomputes command
  outcomes when all shell completions have command evidence.
- Added focused coverage in `packages/core/test/run-outcome.test.ts` and
  `packages/core/test/trace.test.ts`.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/shell.md](../coverage/shell.md)
- Run note: [../runs/2026-06-29-real-mini-remaining-tool-qa.md](../runs/2026-06-29-real-mini-remaining-tool-qa.md)
