# Direct Core Required Verifier Omitted

## Record

- Pattern ID: `direct-core-required-verifier-omitted`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

The Host and direct-Core CLI entries load the same workspace configuration and
real model, but only the Host executes a required verification profile after a
write. Direct Core persists no workflow-hook or extension receipt and returns a
clean assessment with exit 0.

## Root Cause

`packages/cli/src/runners/direct-core-runner.ts` assembles configured workflow
hooks and the documented command directly. It does not reuse the Host's
canonical hook assembly in
`packages/host/src/runtime/run-preparation-operations.ts`, which also installs
configured verification hooks.

## Diagnostic Move

Run the same target-bound write under Host and `--direct-core`, then compare
profile invocation events, `FactLedger.verificationResults`, terminal
`RunAssessment`, and CLI output/exit.

## Prevention

- Reuse the canonical verification/workflow-hook assembly across supported
  entries, or fail loudly when Direct Core cannot honor required verification.
- Keep a parity test with a required profile and a model that does not run the
  verifier itself.

## Evidence

- Host control: session `session_mrrhxelnl0w6wz9r`, run
  `run_mrrhxesi2tfwq2tu`.
- Direct-Core reproduction: session `session_mrri67ad99137amk`, run
  `run_mrri67b2u978j4rw`.
- Direct-Core trace:
  `/Applications/xgw/projects/AI-native/project/test/qa_cli_agent_20260719_outcome/.sparkwright/sessions/session_mrri67ad99137amk/trace.jsonl`.

## Fix

- 2026-07-19: Direct Core now calls Host's canonical
  `assembleRuntimeWorkflowHooks()` instead of assembling a reduced local hook
  list.
- A direct-Core CLI regression performs a write under a required profile and
  asserts the verifier receipt and user-facing pass summary.
- Full CLI coverage passed (191 tests).

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-07-19-real-terra-refactor-qa-follow-up.md](../runs/2026-07-19-real-terra-refactor-qa-follow-up.md)
