# Run Notes

Run notes are small records of test sessions whose result depends on prompt,
model, capability posture, environment, or timing. They are the evidence trail
behind coverage confidence and failure counts.

Do not paste raw terminal output here. Keep enough detail for a maintainer to
understand what was attempted, whether the result is reusable, and which
coverage or failure files changed.

## When To Add A Run Note

Add one when:

- a real provider/model was used
- a prompt was varied to test route robustness
- a capability set, permission mode, or environment changed the result
- failure-hunting found a new pattern or repeated an existing one
- a previously weak or untested coverage area became more or less confident

Skip one when:

- a deterministic focused gate passed and coverage/failure state did not change
- the run only checked formatting or docs
- the result is already represented by a package-local test failure and no
  reusable lesson was learned

## Naming

Use:

```txt
YYYY-MM-DD-<short-area>-<short-result>.md
```

Examples:

- `2026-06-22-shell-timeout-pass.md`
- `2026-06-22-trace-subagent-partial.md`
- `2026-06-22-real-model-skill-loop.md`

## Update Rules

- Link to scenario IDs and coverage pages.
- Record prompt shape, model class, capability posture, and environment.
- Classify failures using the cause vocabulary in
  [../README.md](../README.md#failure-cause-vocabulary).
- If an existing failure pattern repeats, increment that failure file's count.
- If a new reusable lesson appears, add a failure-pattern file before finalizing
  the run note.
