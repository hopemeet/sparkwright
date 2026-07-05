# Trace Sequential Pagination Low Progress

## Record

- Pattern ID: `trace-sequential-pagination-low-progress`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

After the read pagination visibility fix, a real mini trace completed
successfully and reported the target line/value. `trace verify` was ok, but
`trace report` returned `passed_with_issues` with `LOW_NET_PROGRESS` because it
treated five sequential pages of the same file as duplicate reads.

## Root Cause

The report's low-progress heuristic used path-level duplicate read counts from
`workspace.read`. For paginated `read` calls, path-level aggregation is still
useful summary data, but it is not proof of an unchanged repeated read window.

## Diagnostic Move

When a report flags duplicate reads, compare `tool.completed` read outputs:

- identical `path` plus identical `startLine/endLine` means the same window was
  repeated
- identical `path` with advancing `startLine/endLine/nextOffset` is sequential
  pagination and should not by itself trigger low-progress evidence

## Prevention

Use read window identity for low-progress duplicate-read evidence while keeping
public summary/top duplicate read counts path-based for compatibility.

## Fix

- 2026-06-29: `packages/core/src/trace-diagnostics.ts` now collects repeated
  read windows from `tool.completed` output and feeds that to
  `LOW_NET_PROGRESS`.
- Added `packages/core/test/trace.test.ts` coverage proving sequential
  paginated reads keep path-level `topDuplicateReads` but do not emit
  `LOW_NET_PROGRESS`.
- Re-running the real mini pagination trace changed `trace report` from
  `passed_with_issues` to `ok`.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-06-29-real-mini-remaining-tool-qa.md](../runs/2026-06-29-real-mini-remaining-tool-qa.md)
