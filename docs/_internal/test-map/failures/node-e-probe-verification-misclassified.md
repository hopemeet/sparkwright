# Node E Probe Verification Misclassified

## Record

- Pattern ID: `node-e-probe-verification-misclassified`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-07-19
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     2 |
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

At the time, `trace-diagnostics.ts` also preferred a persisted compact command
snapshot even when the raw debug trace still had complete shell command
arguments, so re-running report could keep stale classification. That compact
format has since been removed in favor of the terminal FactLedger.

## Diagnostic Move

For shell failure reports, compare:

- `commandFailures.total`
- `commandFailures.verification.total/unresolved`
- raw `tool.requested.arguments.command`
- whether the command is a test/check runner or an ad-hoc probe (`node -e`)

If raw debug events retain command args, report diagnostics should recompute
classification rather than trust stale persisted snapshots.

## Prevention

- Never use goal prose to grant verifier authority. Explicit test/check command
  shapes and structured verifier provenance are the only formal sources.
- Consume the persisted terminal FactLedger when available; replay through the
  same projector only for incomplete traces.

## Fix

- 2026-06-29: `packages/core/src/run-outcome.ts` now classifies `node -e` as a
  probe command.
- 2026-06-29: `packages/core/src/trace-diagnostics.ts` recomputes command
  outcomes when all shell completions have command evidence.
- Added focused coverage in `packages/core/test/run-outcome.test.ts` and
  `packages/core/test/trace.test.ts`.

## Reopened General Case

On 2026-07-19, current-source real Terra showed that the command-specific
`node -e` mitigation did not remove the underlying goal-prose authority. With
no configured verifier, a goal containing `Verify` caused ordinary
`node diagnostic.js` exit 7 to become a formal failed verification and caused
ordinary `node diagnostic-ok.js` exit 0 to become a formal passed receipt.
The final answers explicitly denied making a verification claim.

- Failing control: session `session_mrrhzln9a0tdci8t`, run
  `run_mrrhzlu2d1vlg57d`.
- Passing control: session `session_mrri12viaczwn31n`, run
  `run_mrri132c36a3h0t4`.
- Trace root:
  `/Applications/xgw/projects/AI-native/project/test/qa_cli_agent_20260719_outcome/ordinary_command/.sparkwright/sessions`.

The remaining root is `FactLedger.observeGoal()` plus
`isVerificationGoal(goal)`: once the goal matches `/verify|test/`, every
non-probe command is verification-relevant and `run-assessment.ts` projects it
as formal verification. Prevention must remove goal prose as verifier
authority, not extend the probe allowlist one command at a time.

## General Fix

- 2026-07-19: removed goal-text observation and `isVerificationGoal()`.
  Ordinary shell commands no longer become verification facts because a goal
  contains `verify` or `test`; only explicit verification command shapes and
  structured verifier hooks produce receipts.
- Added a positive/negative ordinary-command regression under verification-like
  goal prose in `packages/core/test/fact-ledger.test.ts`.
- Full Core coverage passed (640 tests).

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/shell.md](../coverage/shell.md)
- Run note: [../runs/2026-06-29-real-mini-remaining-tool-qa.md](../runs/2026-06-29-real-mini-remaining-tool-qa.md)
