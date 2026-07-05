# Repeated Expected Denial Outcome

## Record

- Pattern ID: `repeated-expected-denial-outcome`
- Status: `fixed`
- First seen: 2026-07-02
- Last seen: 2026-07-02
- Fixed: 2026-07-02
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 1 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

A read-only real `openai/gpt-5.4-mini` run asked for parent `bash` plus an
awaited background `agent` task. The first `bash` call was correctly denied by
read-only policy (`TOOL_DENIED`) because the shell command declared write side
effects. The model repeated the same bash command, and core emitted a synthetic
`REPEATED_TOOL_CALL_SKIPPED` failure.

The background agent task completed successfully, `trace verify` passed, and
session structure was valid, but before the fix the completed parent run was
marked failing because the synthetic repeated-tool failure remained unresolved.

## Root Cause

The original `TOOL_DENIED` is treated as an expected policy denial by outcome
classification. Before the fix, the repeated-tool guard stored only the
previous failed target's key, code, and message, then emitted a generic
`REPEATED_TOOL_CALL_SKIPPED` failure for the retry. That synthetic failure did
not carry expected-denial semantics, so outcome/reporting classified it as
unresolved.

The same nudge message also used read/path recovery wording for every prior
failure (`offset/limit`, directory, listing tool), which was misleading for
shell policy denials.

Fixed 2026-07-02 in core by carrying prior same-target failure category into
the repeated-tool guard, using policy/approval-specific repeated-denial
guidance, and classifying repeated expected denials as expected-denial
derivatives in both run outcome and trace diagnostics.

## Diagnostic Move

For repeated-tool failures after a policy denial:

```bash
node packages/cli/dist/index.js trace events "$trace" --type tool.failed --jsonl
node packages/cli/dist/index.js trace events "$trace" --type run.completed --jsonl
node packages/cli/dist/index.js trace report "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
```

Check whether the prior failure was an expected denial (`TOOL_DENIED`,
approval denial, or policy denial) before treating the repeated skip as a
runtime/tool execution defect.

## Prevention

- Keep prior failure category/policy metadata in repeated-tool state.
- Emit policy-specific repeated-denial guidance instead of read/path guidance.
- Preserve generic category-based semantics: repeated skips after
  policy/approval denials are expected-denial derivatives; ordinary repeated
  arg/runtime failures keep their normal recovered/unresolved handling.
- Keep focused regressions for read-only denied bash followed by one repeated
  same-target bash call, including trace-summary expected-denial counts.

## Fix Verification

Focused regressions and checks:

```bash
npm --workspace @sparkwright/core test -- test/run.test.ts test/run-outcome.test.ts test/trace.test.ts
npm --workspace @sparkwright/core run typecheck
npm run build --workspace @sparkwright/core
npm run check:dist-fresh
```

Historical real mini trace replay:

```bash
node packages/cli/dist/index.js trace summary /tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl --format text
node packages/cli/dist/index.js trace report /tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl --format text
node packages/cli/dist/index.js trace verify /tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl --format text
```

Replay result after fix: `errors: 0`, `expected denials: 2`
(`TOOL_DENIED:1`, `REPEATED_TOOL_CALL_SKIPPED:1`), `unresolved tool
failures: 0`, `recovered tool failures: 0`, `trace verify` status `ok`.
`trace report` no longer reports unresolved tool failures; the only remaining
finding is `LOW_NET_PROGRESS` from the original exploratory run shape.

## Evidence

- Run note:
  [../runs/2026-07-02-real-mini-bg-agent-bash-shell-qa.md](../runs/2026-07-02-real-mini-bg-agent-bash-shell-qa.md)
- Trace:
  `/tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl`
- Source:
  `packages/core/src/run.ts` repeated-tool nudge and semantic target logic;
  `packages/core/src/run-outcome.ts` expected-denial classification;
  `packages/core/src/trace-diagnostics.ts` expected-denial summary counts.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/shell.md](../coverage/shell.md)
- Matrix: [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md),
  [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
