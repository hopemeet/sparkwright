# Context Compaction

## Purpose

Context compaction reduces completed session history into explicit summary
context while keeping raw trace and session evidence intact.

See [../session/resume-replay.md](../session/resume-replay.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/context.ts`
- `packages/core/src/pipeline.ts`
- `packages/core/src/context-dedup.ts`
- `packages/core/src/session-compaction.ts`
- `packages/core/src/session.ts`
- `packages/host/src/runtime.ts`
- `packages/protocol/src/index.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/state/run-controller.ts`
- `docs/reference/CONTEXT_PLANE.md`
- `docs/reference/HOST_PROTOCOL.md`
- `docs/reference/RUN_EVENTS.md`

## Data Flow

```txt
completed prior turns
  -> host loadCompletedConversationTurns()
  -> core compactSessionTurns()
  -> session-specific deterministic stages
  -> compact.json
  -> sessionCompactArtifactToContextItem()
  -> future run context
```

## Contracts

- Raw trace and canonical transcript remain intact after compaction.
- Compaction changes future context, not history.
- `session-compact.v2` artifacts include source run ids, `throughRunId`,
  original/summary char counts, and top-level `freedChars`.
- `CompactionResult` carries `freedChars`, optional `skippedReason`, optional
  `warnings`, and metadata across runtime and session compaction.
- Runtime and session compaction share the pipeline/stage protocol but use
  different stage families: runtime stages own tool observations; session
  stages own completed user/assistant turns.
- `CompactionStage.tier` is `dedup`, `extract`, `evict`, or `summarize`; no-op
  stages (`freedChars <= 0`) are reported as skipped, not applied. `dedup` is
  reserved for genuinely redundant content; lossy deterministic turn extraction
  reports as `extract`.
- `context.compaction.*` events describe runtime stage lifecycle and include
  stage tier plus skip/warning metadata when present.
- `session.compact` returns `freedChars`, optional `skippedReason`, optional
  `warnings`, `measurement`, and writes no artifact when there is no net
  savings. An explicit `llm` request routes through the Tier 3 session
  summarizer: configured provider/scripted models use the model-backed path,
  while deterministic refs use the preview path and return a warning.
- Session Tier 3 uses a dedicated wake/spend/acceptance gate. The spend floor is
  char/token bounded (`maxSourceChars`, `maxOutputTokens`); dollar caps refine
  only when pricing is known, and unknown-cost decisions surface in warnings.
- The acceptance oracle (`verifySessionSummaryCoverage`) extracts a `literal`
  signal class for exact/sentinel tokens — uppercase hyphen/underscore
  identifiers and quoted/backticked literals that sit next to exact-match
  language (`preserve`/`exactly`/`verbatim`/CJK equivalents). Literal signals
  must appear verbatim in the summary; self-reported `coveredSignalIds` /
  `unknownSignalIds` cannot waive their presence, so a paraphrase that drops the
  token is rejected even when the source constraint line is compacted past its
  180-char prefix.
- Accepted model-backed summaries write `summaryFingerprint` metadata
  (`modelId`, prompt/oracle versions, `inputHash`, source run ids, through run,
  and effective budget) so overwriting `compact.json` can still be audited for
  reuse/staleness.
- If a compact artifact's `throughRunId` cannot be anchored to completed turns,
  `loadConversationHistory()` injects a conversation-layer warning item instead
  of silently ignoring the artifact.
- Context omission diagnostics may keep source provenance from metadata, while
  provider prompt source labels use the model-visible projection and must not
  expose host absolute paths.
- Observation one-line compaction keeps dynamic `spawn_agent` child-answer
  finality facts in collapsed rows (`role`, `childRunId`, `finality`, and
  step-limit/truncation markers), rather than reducing child results to only
  char/line counts.

## Consumers

- Host `session.compact`.
- CLI `session compact`.
- TUI `/compact`.
- Future run prompt/context assembly.
- Trace timeline when compaction events are present.

## Change Checklist

- Do not delete or rewrite trace/session history during compaction.
- Keep compact artifacts explicit about source run ids.
- Preserve the split between runtime tool-observation stages and session
  turn-extraction stages.
- Propagate `freedChars`, `skippedReason`, and `warnings` through protocol
  clients when response shapes change.
- Check prompt-cache and context-layer metadata.
- Update `CONTEXT_PLANE.md` if context stability semantics change.

## Known Debts

- Background auto-trigger policy is still not wired into the main run loop;
  model-backed session summarization is opt-in through `llm` or
  `tasks.compaction.enabled` plus the dedicated gates.
- Long sessions can still create replay/context noise if deterministic
  extraction plus old-turn eviction is not enough for a caller's density target.
- Runtime Tier3 summarizer placement is still separate from the session
  summarizer seam.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/pipeline.ts`, `packages/core/src/context-dedup.ts`, `packages/core/src/session-compaction.ts`, `packages/core/src/session.ts`, `packages/host/src/session-summarizer.ts`, `packages/host/src/runtime.ts`, `packages/protocol/src/index.ts`, `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`, `docs/reference/CONTEXT_PLANE.md`, `docs/reference/HOST_PROTOCOL.md`, `docs/reference/RUN_EVENTS.md`.
- Tests: `npm --workspace @sparkwright/core test -- session-compact.test.ts`
  (incl. literal/sentinel oracle regression);
  `npm --workspace @sparkwright/core test -- pipeline-stages.test.ts`;
  `npm --workspace @sparkwright/host test -- protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- cli.test.ts`.
