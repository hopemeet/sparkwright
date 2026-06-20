# Context Compaction

## Purpose

Context compaction reduces completed session history into explicit summary
context while keeping raw trace and session evidence intact.

See [../session/resume-replay.md](../session/resume-replay.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/context.ts`
- `packages/core/src/context-dedup.ts`
- `packages/core/src/session.ts`
- `packages/host/src/runtime.ts`
- `docs/reference/CONTEXT_PLANE.md`
- `docs/reference/RUN_EVENTS.md`

## Data Flow

```txt
completed prior turns
  -> host loadCompletedConversationTurns()
  -> renderSessionCompactSummary()
  -> compact.json
  -> sessionCompactArtifactToContextItem()
  -> future run context
```

## Contracts

- Raw trace and canonical transcript remain intact after compaction.
- Compaction changes future context, not history.
- `session-compact.v1` artifacts include source run ids and size metadata.
- `context.compaction_*` events describe runtime compaction when implemented/emitted.
- Context omission diagnostics may keep source provenance from metadata, while
  provider prompt source labels use the model-visible projection and must not
  expose host absolute paths.
- Observation one-line compaction keeps dynamic `spawn_agent` child-answer
  finality facts in collapsed rows (`role`, `childRunId`, `finality`, and
  step-limit/truncation markers), rather than reducing child results to only
  char/line counts.

## Consumers

- Host `session.compact`.
- TUI `/compact`.
- Future run prompt/context assembly.
- Trace timeline when compaction events are present.

## Change Checklist

- Do not delete or rewrite trace/session history during compaction.
- Keep compact artifacts explicit about source run ids.
- Check prompt-cache and context-layer metadata.
- Update `CONTEXT_PLANE.md` if context stability semantics change.

## Known Debts

- Current host compaction is deterministic summary text, not a full semantic summarizer.
- Long sessions can still create replay/context noise.
- Runtime and session compaction are two parallel implementations (core
  `Compactor`/`ContextItem[]` vs host `renderSessionCompactSummary` string
  concat); short-session compact can grow, and a `throughRunId` miss silently
  full-replays. Proposed fix and A→B→C migration:
  [../../designs/compaction-redesign.md](../../designs/compaction-redesign.md).

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/context.ts`, `packages/core/src/context-dedup.ts`, `packages/host/src/runtime.ts`, `packages/core/test/context.test.ts`, `packages/core/test/runtime-guardrails.test.ts`, `packages/host/test/spawn-agent.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/context.test.ts test/runtime-guardrails.test.ts`; `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts`.
