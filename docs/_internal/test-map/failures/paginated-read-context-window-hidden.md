# Paginated Read Context Window Hidden

## Record

- Pattern ID: `paginated-read-context-window-hidden`
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

A real `openai/gpt-5.4-mini` read-only run paged through
`PROJECT_NOTES.md` correctly and the `read` tool returned a window containing
`NEEDLE_PAGE_3=alpha-4300`, but the final model answer said the value was not
found.

Trace inspection showed the `tool.completed` payload contained the needle, but
every `prompt.built` payload omitted it. Earlier windows were replaced as
superseded reads, and long `content` strings were reduced to a short
`{type,length,preview}` object before reaching the model.

## Root Cause

Two context layers disagreed with the host read contract:

- `file_read_dedup` keyed reads only by file path, so different paginated line
  windows of the same file could supersede each other.
- `DefaultObservationFormatter` kept only the generic 2k preview of long nested
  strings, while host `read` returned up to 60k chars per page. The model never
  saw most of the page it had technically read.

## Diagnostic Move

For a large-file read failure, compare three facts:

- `tool.completed.payload.output.startLine/endLine/content` contains the target.
- `prompt.built` selected context contains the target value, not just the user
  request string.
- Context markers such as `superseded by later read` use the same file window,
  not only the same path.

## Prevention

- Preserve file read metadata (`startLine`, `endLine`, `totalLines`) into
  context item metadata.
- Deduplicate repeated reads by file window when line metadata is available.
- Keep host read pages within the model-visible observation budget and make the
  tool description mention both line and character bounds.

## Fix

- 2026-06-29: `packages/core/src/context.ts` now lifts read window metadata and
  uses a read-specific 6000-char observation budget.
- 2026-06-29: `packages/core/src/context-dedup.ts` keys file-read dedup by
  `filePath#lines:start-end` when line metadata exists.
- 2026-06-29: `packages/host/src/tools.ts` lowered the host read page character
  ceiling to 6000 and updated the tool description to say windows are character
  bounded.
- Verified with focused core/host tests and a real mini run that found
  `FOUND: line 4300 — NEEDLE_PAGE_3=alpha-4300`.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note: [../runs/2026-06-29-real-mini-remaining-tool-qa.md](../runs/2026-06-29-real-mini-remaining-tool-qa.md)
