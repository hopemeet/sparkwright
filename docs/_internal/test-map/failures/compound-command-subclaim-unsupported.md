# Compound Command Subclaim Is Marked Unsupported

## Record

- Pattern ID: `compound-command-subclaim-unsupported`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

Terra successfully ran:

```text
python3 -m py_compile print_numbers.py test_print_numbers.py && python3 -m unittest -v
```

Its final answer truthfully reported the `python3 -m unittest -v` result, but
the run outcome annotated that subcommand as an unsupported command-success
claim (`completed_with_unsupported_final_claims`). Trace report/verify and
session check otherwise passed.

## Root Cause

`analyzeUnsupportedFinalAnswerClaims()` compares claimed command identities
against the exact successful `commandKey` set. A compound shell command is one
key, so a proven constituent command never matches even when the successful
captured output contains that constituent's test result.

## Resolution

Fixed 2026-07-19 by removing prose command-claim parsing from formal run
semantics. Core assessment records only structured command/profile verifier
facts; a truthful final-answer sentence is no longer accepted or rejected by a
second natural-language outcome system. The real-model unsupported-claim
canary was retired with that feature.

Deterministic evidence: Core outcome/assessment and trace tests pass, and the
CLI no longer renders unsupported-claim status.

## Diagnostic Move

When an unsupported claim is a strict subcommand of a successful `&&` chain,
inspect the raw bash request/result and exit code before treating the final
answer as fabricated.

## Prevention

- Keep formal verification on structured command/profile facts.
- Do not reintroduce command identity parsing from final-answer prose as a
  terminal verdict.

## Evidence

- Trace: `/Applications/xgw/projects/AI-native/project/test/.sparkwright/sessions/session_tui_mrqzfuxm/trace.jsonl`
- Source: `packages/core/src/run-outcome.ts`

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-07-19-real-terra-broad-refactor-qa.md](../runs/2026-07-19-real-terra-broad-refactor-qa.md)
