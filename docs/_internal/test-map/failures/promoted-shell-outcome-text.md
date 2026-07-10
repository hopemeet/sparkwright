# Promoted Shell Outcome Text

## Record

- Pattern ID: `promoted-shell-outcome-text`
- Status: `retired`
- First seen: 2026-06-22
- Last seen: 2026-06-22
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

A promoted shell command writes a file that survives and is later read by the
parent run, but the CLI terminal outcome says no workspace changes were made.

## Root Cause

The final outcome text appears to count only managed `workspace.write.completed`
events. Promoted shell writes are intentionally tracked as
`workspace.write.untracked_access_granted`, so the text can be true for managed
writes while misleading about actual workspace mutation.

## Diagnostic Move

Compare CLI final outcome text, fixture `git status`, `workspace.write.*`
events, and `workspace.write.untracked_access_granted` events after a promoted
shell writes inside the workspace.

## Prevention

- Adjust CLI outcome text to distinguish "no managed workspace writes" from
  "untracked write-capable shell/process access occurred".
- Add a CLI outcome test for promoted shell write survival.

## Resolution

- Fixed 2026-06-23: CLI run outcome aggregation now counts
  `workspace.write.untracked_access_granted` separately as untracked
  write-capable boundaries and no longer emits a plain "No workspace changes
  were made" outcome when only this boundary occurred.
- Regression: `npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts`.

## Related

- Coverage: [../coverage/shell.md](../coverage/shell.md)
