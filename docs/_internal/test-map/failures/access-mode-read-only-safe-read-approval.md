# Read-Only Access Mode Requires Approval For Safe Reads

## Record

- Pattern ID: `access-mode-read-only-safe-read-approval`
- Status: `retired`
- First seen: 2026-06-28
- Last seen: 2026-06-28
- Recorded count: 2

| Cause | Count |
| --- | ---: |
| `product_bug` | 2 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

`--access-mode read-only` compiles to plan/no-write, but safe read tools such
as `read_file` and `glob` emit `approval.requested` with
`reason: Plan mode requires approval.` In non-interactive CLI runs those
approvals are denied, causing a read-only inspection task to complete with
issues. In TUI runs the same request blocks the user behind an approval prompt
for a `risk:safe` read.

## Root Cause

The approval policy treats plan mode as "approve every tool" instead of
"deny writes and risky actions while allowing safe reads." The failing events
carry `risk: safe` and read-only governance, so this is not a model/tool schema
failure.

Fixed on 2026-06-28 by making core plan-mode policy recognize explicit
`risk:"safe"` tools only when they also declare read-only/no-op
`governance.sideEffects`, while still requiring approval for bare,
metadata-incomplete, risky, and write/network/external-side-effect tools. The
host `read_file` descriptor now declares `sideEffects: ["read"]` so the policy
does not need a tool-name special case.

## Diagnostic Move

Run the same read-only prompt once with `--access-mode read-only` and once with
`--access-mode ask`. If only read-only produces `approval.requested` for
`read_file`/`glob`, inspect the approval policy path for plan mode before
changing model prompts or tool descriptors.

## Prevention

Add a deterministic CLI/host regression that `accessMode: "read-only"` allows
safe read tools without approval while still denying workspace writes and risky
side effects. Add a PTY canary if TUI approval rendering changes.

## Related

- Scenarios: real mini read-only CLI repo inspection; real mini TUI read-only
  PTY inspection.
- Coverage: [tui-rendering](../coverage/tui-rendering.md),
  [config-schema](../coverage/config-schema.md)
- Run notes: [2026-06-28-access-mode-real-mini-qa-partial.md](../runs/2026-06-28-access-mode-real-mini-qa-partial.md)
- Fix verification: [2026-06-28-access-mode-fix-verification.md](../runs/2026-06-28-access-mode-fix-verification.md)
