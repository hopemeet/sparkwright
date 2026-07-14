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
- `session inspect --compaction` is the human audit view for session
  compaction. It uses session artifacts/events as its source, reports
  event/artifact consistency, and does not print compacted summary content.
- Accepted `session.compact` attempts write durable `compact.json` evidence
  with artifact metadata (`summaryFingerprint`, `measurement`, applied/skipped
  stages, warnings). Every successful host `session.compact` response also
  appends a session-local event: `session.compaction.completed` when an artifact
  was written, or `session.compaction.skipped` when no artifact was written.
  These events carry counts, `freedChars`, `measurement`, `artifactPath`,
  optional `skippedReason`, warning codes, and host/reason metadata, but not
  compacted summary content.
- Session Tier 3 uses a dedicated wake/spend/acceptance gate. The spend floor is
  char/token bounded (`maxSourceChars`, `maxOutputTokens`); dollar caps refine
  only when pricing is known, and unknown-cost decisions surface in warnings.
  The host model factory reports `pricing.costStatus` up front; when it is
  `unavailable` with `missing_pricing`, compaction warnings and capability
  inspect use the same reason instead of separate cost heuristics.
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
- Workflow-runtime-v1 D10 verification: the existing compaction substrate can
  express node-boundary span-to-summary through a caller-selected source span
  set plus an explicit verdict/evidenceRefs summary artifact/context item.
  P2 records this conclusion only; it does not add an automatic workflow
  node-boundary compaction trigger or a new `CompactionStage`.

## Consumers

- Host `session.compact`.
- CLI `session compact`.
- TUI `/compact`.
- Future run prompt/context assembly.
- Trace timeline when run-level compaction events are present.
- CLI/host session inspection when session compaction events are present.

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

- Status: Read-only
- Date: 2026-07-15T07:26:47+0800
- Scope: C9 S1 migration touched only the atomic writer used by
  `FileSessionStore` `session.json` saves. Runtime compaction stages, session
  compaction artifact schema, summary acceptance, and context projection are
  unchanged.
- Read: `packages/core/src/session.ts`, `packages/core/src/file-atomic.ts`,
  `packages/agent-runtime/src/doc-store/index.ts`.
- Tests: storage-focused `npm --workspace @sparkwright/core test --
test/session.test.ts` and `npm --workspace @sparkwright/agent-runtime test --
test/doc-store.test.ts`; compaction-specific tests not run for this
  storage-only change.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 D10 review: confirmed no new compaction stage
  is needed for future workflow node-boundary span-to-summary, because the
  existing substrate already accepts caller-selected source material and
  explicit summary artifacts/context items. No implementation was added.
- Read: `packages/core/src/pipeline.ts`,
  `packages/core/src/session-compaction.ts`,
  `packages/core/src/context.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: not run for compaction; P2 made no compaction behavior change.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after context prompt/tool guidance updates; compaction
  artifacts, selected-context layers, and cache stability semantics did not
  change.
- Read: `packages/core/src/context.ts`,
  `packages/project-context/src/index.ts`,
  `packages/core/test/context.test.ts`,
  `docs/_internal/project-map/maps/runtime/context-compaction.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/context.test.ts test/run.test.ts test/trace.test.ts`.

- Status: Verified
- Date: 2026-06-22
- Read: `packages/core/src/pipeline.ts`,
  `packages/core/src/session-compaction.ts`, `packages/core/src/session.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/model-builder.ts`,
  `packages/host/src/model-factory.ts`, `packages/host/src/server.ts`,
  `packages/protocol/src/index.ts`, `packages/cli/src/cli.ts`,
  `packages/core/test/session-compact.test.ts`,
  `packages/host/test/protocol.test.ts`, `packages/cli/test/cli.test.ts`,
  `docs/reference/STATE_AND_TRACE_MODEL.md`,
  `docs/reference/HOST_PROTOCOL.md`, `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`.
- Tests: `npm --workspace @sparkwright/core test -- session-compact.test.ts`;
  `npm --workspace @sparkwright/host test -- model-factory.test.ts protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`.
