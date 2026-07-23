# Tool Search Drops Non-Latin Query Tokens

## Record

- Pattern ID: `tool-search-non-latin-query-empty`
- Status: `fixed`
- First seen: 2026-07-22
- Last seen: 2026-07-23
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

`tool_search` returns no matches for a pure Chinese free-text query even when a
deferred tool has a matching Chinese description. Exact `select:<name>` and
Latin queries still work.

## Root Cause

The tokenizer kept only `[a-z0-9_]`, so a Chinese query produced no tokens and
every descriptor scored zero.

## Diagnostic Move

Test the same deferred catalog with Latin, Chinese, mixed-language, and exact
selector queries. Inspect tokens/ranking before adding a prompt that tells the
model to translate its request.

## Prevention

- Use Unicode-aware tokenization with stable deterministic ranking.
- Keep exact selector behavior independent from free-text tokenization.
- Cover non-Latin descriptor text at the runtime search layer.

## Fix

- 2026-07-23: Core preserves Latin/underscore tokens and adds overlapping CJK
  bigrams, deduplicates tokens, and breaks equal scores by tool name.
- Focused `tool-search.test.ts` coverage verifies a Chinese query discovers the
  matching deferred tool.

## Related

- Coverage: none dedicated; routed through Core tool-search coverage.
- Run notes: none; deterministic reproduction and regression coverage.
