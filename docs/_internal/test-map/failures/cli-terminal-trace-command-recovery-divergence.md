# CLI Terminal And Trace Recovery Disagree

## Record

- Pattern ID: `cli-terminal-trace-command-recovery-divergence`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

A real coding run first executed `python3 -m unittest -v` with exit 1, fixed
the test, then executed a successful `py_compile && unittest` chain. The final
code had 6 passing tests and the offline trace diagnostics reported:

```text
command failures: 0 total
verification failures: 0 total, 0 unresolved
status: ok
```

The live CLI nevertheless printed `Run completed with verification failures;
exiting 1 (1 unresolved command failure, exitCode=1)` after the Todo
reconciliation continuation. Replaying the same events through the current
`cliExitCodeForRun()` returns `0`, so the confirmed contradiction is the live
human text claiming a non-zero exit while the canonical exit projection and
offline diagnostics are clean.

## Root Cause

The divergence is between two projections of the same shell evidence:

- `packages/cli/src/run-outcome.ts`
  `summarizeVerificationCommandFailures()` calls
  `analyzeCommandOutcomes(summary.events)` over raw live events.
- `packages/core/src/trace-diagnostics.ts`
  `commandFailureProjectionForTrace()` groups events by run and prefers each
  persisted `factLedger` through `analyzeCommandOutcomesFromFactLedger()`.

The main run's FactLedger marks the first standalone unittest failure
`stale:true` after a later workspace write, and retains the successful compound
verification as the current fact. Offline diagnostics therefore correctly
project zero failures. The raw-event analyzer does not apply write-epoch
staleness and requires an exact `commandKey` match for recovery; the later
`py_compile && unittest` command cannot recover the earlier standalone
`unittest` key. The CLI consequently prints an unresolved-failure line even
though the canonical persisted ledger has invalidated that failure. The
wording itself hard-codes `exiting 1`, but `cliExitCodeForRun()` independently
consumes the FactLedger-aware completed outcome and returns `0` for these
events.

The separate Todo reconciliation run makes the mismatch more visible but is
not the primary cause. It contributes a second empty FactLedger, while the CLI
warning path continues to aggregate raw events across the live chain.

## Resolution

Fixed 2026-07-19 by making Core persist one `RunAssessment` on every terminal
result/event and making both CLI terminal status and trace diagnostics consume
that object. The live CLI no longer runs an independent raw-event verdict, and
missing assessment fails closed. The Todo reconciliation path that amplified
the discrepancy was removed separately; only durable Workflow records may
continue episodes.

Deterministic evidence: Core trace/outcome coverage, CLI outcome fixtures, Host
execution aggregation, and the full Core/Host package suites pass.

## Diagnostic Move

For a CLI exit that claims unresolved verification, immediately compare raw
bash results, `trace summary`, `trace report`, and every `run.completed`
payload. If offline diagnostics recover the failure but live CLI does not,
classify it as outcome aggregation divergence rather than a failed code change.

## Prevention

- Keep an integration test with fail -> edit -> later successful verification.
- Assert CLI exit code, terminal text, trace summary, report verdict, and
  session check agree.
- Keep CLI verification text and offline trace diagnostics on the same
  persisted assessment.
- Keep the human text and actual exit-code projection on the same assessment; a
  line that says `exiting 1` must never be produced by an independent analyzer.

## Evidence

- Trace: `/Applications/xgw/projects/AI-native/project/test/.sparkwright/sessions/session_mrqzkle329yslud3/trace.jsonl`
- Main run: `run_mrqzklkqxuceu77v`
- Reconciliation run: `run_mrqzl6kgirfqprs4`

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Existing recovery pattern: [trace-recovered-verification-command-failure.md](trace-recovered-verification-command-failure.md)
- Run note: [../runs/2026-07-19-real-terra-broad-refactor-qa.md](../runs/2026-07-19-real-terra-broad-refactor-qa.md)
