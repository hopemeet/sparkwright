# Design: Compaction Redesign (unified Compactor substrate + three tiers)

> **Proposed — pre-implementation alignment doc. Nothing here is built yet.**
> This is a design target, not a routing map. The active contract for compaction
> today lives in [../maps/runtime/context-compaction.md](../maps/runtime/context-compaction.md),
> `packages/core/src/pipeline.ts`, `packages/core/src/context-dedup.ts`, and
> `packages/host/src/runtime.ts`. Use this doc to agree on the shape and the
> A→B→C migration order before any code moves. All file:line refs verified
> 2026-06-21.

## 1. Background & Goals

A read-only real-model QA pass over context/content compaction
(`openai/gpt-5.4-mini`) returned `passed with issues`. The basic links work —
runtime deterministic compaction fires before hard overflow, manual session
compact is consumed by a follow-up run, trace/session evidence stays intact —
but a cluster of issues surfaced: cost reported `unavailable` for every run,
short-session compact grew instead of shrank (`originalCharCount: 1179` →
`summaryCharCount: 1365`), the semantic-summarizer slot is empty, and the
session-compact path is only reachable through HostRuntime/TUI.

The key finding from source triage: **these are not independent bugs.** They are
symptoms of three structural root causes. Patching each symptom welds temporary
logic onto two implementations that should not coexist. This redesign fixes the
roots in order.

Goals:

- **One compaction substrate**: runtime and session compaction share the
  `Compactor`/`ContextItem[]` protocol, not two parallel implementations.
- **Deterministic by default stays the identity**: inspectable, reproducible,
  idempotent, evidence-preserving. LLM summarization is opt-in, gated, and
  correctly placed — never the default path.
- **Control decisions never depend on the reporting plane** (cost).
- **Measurable**: every compaction pass reports what it freed, so later tuning
  has a ruler.

## 2. Proposed Decisions

| #   | Decision                                                                   | Choice                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | Two parallel implementations                                               | **Unify onto a shared `CompactionResult` protocol + a layered stage taxonomy — NOT the bare `Compactor`.** `Compactor.compact()` returns only `ContextItem[]` (context.ts:138); the no-op/yield invariants need a result that carries `freedChars`/`skippedReason`/`warnings` (today only on `CompactionPipelineResult`, pipeline.ts:107). Session compaction becomes its own tier of deterministic stages, not a host string renderer. |
| ②   | LLM summarizer default                                                     | **Off by default; opt-in, strongly gated, last-resort.** Default path stays deterministic — this is an inspectability/reproducibility requirement, not a perf choice.                                  |
| ③   | LLM summarizer placement                                                   | **Session cold path, not runtime hot path.** Cold path is off the critical loop, density-bound, the artifact is reused across turns (amortized), and lands as a cache-friendly session block.          |
| ④   | Three operation tiers                                                      | **Make `dedup` / `evict` / `summarize` first-class**, each with its own gate. Today they are mixed in one ordered list distinguished only by thresholds; `evict` is lossy but disguised as compaction. The existing runtime stages are `tool_result`-only (context-dedup.ts:119/137); **session turns are `user`/`assistant` items (runtime.ts:3520), so reusing them on turns is a no-op** — the session tier needs its own deterministic stages (turn-pair budget, assistant-answer extraction, duplicate-turn/goal merge, decision/constraint/file-path preservation). |
| ⑤   | Control-plane trigger (layered)                                            | **Layer the control signal by tier.** Tier 1/2 (deterministic dedup/evict) gate on always-known pressure/token/char only — never cost. Tier 3 (LLM) gates on pressure **plus** explicit opt-in **plus** a budget/token cap **plus** a pricing/unknown-cost policy: unknown cost must NOT make an expensive LLM easier to trigger. `gateStageByUsage`'s `minCostUsd` is the canonical way to defer the LLM summarizer (CONTEXT_PLANE.md:117), so it stays — for Tier 3 only. |
| ⑥   | Structure-aware extraction                                                 | **Build the deterministic extractive tier before reaching for an LLM.** Keep signatures/outline/schema, drop bodies. Captures most of the density-regime benefit at none of the LLM cost.              |
| ⑦   | Cache-stable prefix model                                                  | **Do not touch.** Pass1 append-only / Pass2 break and the `stable/session/turn/volatile` cachePolicy tiers are correct and load-bearing; the redesign builds within them.                              |
| ⑧   | Symptom patches (pricing table, short-session guard, throughRunId warning) | **Do NOT land standalone first.** They are leaves of A/B; after the roots are fixed they either disappear or become one line. Fixing leaves first welds logic onto the wrong structure.                |

## 3. Current Compaction Surface (inventory)

There are two compaction mechanisms that share only the word "compact". They
share no code, protocol, representation, or invariants.

| Aspect             | Runtime layer                                          | Session layer                                                      |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Location           | `packages/core`                                        | `packages/host` (bespoke)                                          |
| Representation     | `ContextItem[]`                                        | `CompletedConversationTurn[]` → string                             |
| Protocol           | `Compactor` / `CompactionStage` (pipeline.ts:61)       | none                                                               |
| Trigger gate       | `shouldRun` + `usageMeetsGate` (pipeline.ts:279)       | none (unconditional render)                                        |
| Yield accounting   | `CompactionStageResult.freedChars` (pipeline.ts:85)    | none                                                               |
| Failure handling   | `compactor-fallback` fail-open (compactor-fallback.ts) | none                                                               |
| Idempotent / no-op | yes                                                    | no (can grow short sessions)                                       |
| Entry point        | core primitive, every entrypoint reuses it             | HostRuntime/TUI/ACP only; no CLI (cli.ts:262 routes only `resume`) |

### 3.1 Key source facts (verified 2026-06-21)

- The five runtime stages are real and registered via
  `createDefaultCompactionStages` (pipeline.ts:705): `tool_result_budget`
  (pipeline.ts:450), `file_read_dedup` (context-dedup.ts:132),
  `observation_one_line` (context-dedup.ts:254), `clear_tool_uses`
  (pipeline.ts:512), `snip` (pipeline.ts:641). Stages "never call out to an LLM,
  are idempotent" (context-dedup.ts:5). **All dedup/one-line stages are
  `tool_result`-only** (context-dedup.ts:137) — they pass `user`/`assistant`
  items through untouched, so they do nothing for session turns.
- Session compact is a standalone string concat: `renderSessionCompactSummary`
  (runtime.ts:3539), written by `compactSession` (runtime.ts:2319) as
  `session-compact.v1` `compact.json`.
- **Read path is already unified**: a follow-up run's `loadConversationHistory`
  (runtime.ts:1828) projects both prior turns (`conversationTurnContextItems`,
  runtime.ts:1854) and the compact artifact
  (`sessionCompactArtifactToContextItem`, session.ts) into `ContextItem[]`. The
  asymmetry is only on the **write/compaction** path. This is what makes root A
  tractable.
- `loadConversationHistory` splices the compact item then replays only turns
  after `throughRunId` (runtime.ts:1846); if `throughRunId` is not found the
  compact is **silently ignored** and all turns replay (no warning).
- The injected session summary always carries `[CONTEXT COMPACTION — REFERENCE
ONLY]` (`COMPACTION_SAFETY_PREFIX`, context-safety.ts:42), re-added
  idempotently on the consume side regardless of what was persisted.
- **Cache awareness already exists and is good**: `assemble` Pass 1 is
  append-only with deterministic per-item truncation that "never moves the
  prompt's cache-stable prefix"; only Pass 2 (genuine overflow) "accept[s] a
  cache break" (context.ts:456). `compilePromptCacheBlocks` (context.ts:1301)
  layers `stable/session/turn/volatile` with a contiguous `stablePrefix`
  (context.ts:1339).
- **Cost-unavailable is correct diagnostics, not a gap**: `applyPricing`
  returns `costStatus:"unavailable"`, `costUnavailableReason:"missing_pricing"`
  when a model has no pricing entry (provider-ai-sdk:466). The
  `OPENAI_MODEL_PRICING` table (provider-ai-sdk:491) has no `gpt-5.x` row, so
  every mini run hits `missing_pricing`. The real defect is that `usageMeetsGate`
  can gate on `minCostUsd` (pipeline.ts:289) — a fragile derived signal that is
  silently undefined for unpriced models. See root B.

## 4. Root Causes

### Root A — No unified compaction abstraction

Two parallel implementations (§3). Every one of the following symptoms is a
direct projection of the empty right column of the §3 table:

- short-session grows ← session path is a renderer, not a Compactor; no
  `freedChars<=0 ⇒ no-op` invariant.
- no session yield metric ← not on the protocol that owns `freedChars`.
- LLM summarizer cannot serve the session layer ← session compact is not a
  `Compactor`.
- session compact has no CLI / cannot be scripted ← it is host-bespoke, not a
  core primitive.

### Root B — Control plane keyed on the reporting plane

`usageMeetsGate` may trigger on `minCostUsd`. `costUsd` is best-effort,
provider-dependent, possibly `undefined`. When unknown, the gate silently treats
"unknown" as "below threshold ⇒ don't compact". Compaction must gate on what it
actually cares about — context-window pressure — which is always known. Cost is
a reporting concern, not a control concern.

### Root C — "compaction" conflates three different operations

One ordered stage list mixes three categorically different operations,
distinguished only by gate thresholds:

1. **Redundancy removal** (lossless-ish, idempotent, always safe):
   `file_read_dedup` (superseded reads are genuinely redundant).
2. **Eviction** (pure information loss, last resort): `clear_tool_uses` replaces
   tool bodies with placeholders, `snip` drops the middle. The content was not
   redundant, only old. This is lossy and is currently disguised as
   "deterministic compaction".
3. **Summarization** (semantic, expensive, gated): empty.

Because the system has no first-class concept that these differ, when the real
need is density reduction it falls through to dumb truncation (`snip`/`clear`)
instead of semantic compression.

## 5. Target Architecture

Three tiers × two entrypoints, on one substrate. (See the
`compaction_target_architecture` diagram shared in design discussion.)

```
                    runtime per-step (hot)        session cross-turn (cold)
  Tier 1 dedup      file_read_dedup, one_line ✓    turn-level dedup (new)
  Tier 2 evict      clear_tool_uses, snip ✓        old-turn truncation (new)
  Tier 3 summarize  (empty slot — MISPLACED ✗)  →  LLM home (gated, cache-friendly)
  ───────────────────────────────────────────────────────────────────────────
  substrate: unified Compactor over ContextItem[]   (root A)
```

### 5.1 Invariants (must hold across every phase)

These are the inspectability identity. No phase may break them:

- default path is deterministic;
- raw trace / transcript are never rewritten — compaction only changes "what the
  model sees next", never the evidence record;
- eviction placeholders remain traceable back to original evidence (preserve the
  `clear_tool_uses` placeholder semantics that already carry tool id / role /
  `originalChars`);
- stages are idempotent; `freedChars <= 0 ⇒ no-op` (return input unchanged).
  This requires a result type that carries `freedChars`/`skippedReason` — the
  bare `Compactor` (context.ts:138) cannot express it; see decision ①.

### 5.2 LLM vs deterministic — placement rationale

The choice is not binary; it is regime- and layer-dependent.

- **Redundancy-bound regime dominates agent loops** (QA: 49 reads / 5 unique
  files). Deterministic dedup wins outright; an LLM here is negative value.
- **Density-bound regime** (lots of distinct useful content) is the only place
  semantic compression earns its cost.
- LLM in the compaction path costs: hot-path latency, per-pass token spend,
  non-determinism (breaks the deterministic QA harness), hallucination /
  load-bearing-token loss (the sentinel-token test is exactly this risk),
  prompt-injection laundering of untrusted tool output.

Therefore the LLM summarizer belongs only where ALL hold: off the hot path,
density-bound, the artifact is consumed many times, fidelity loss is tolerable,
reproducibility is not required for that artifact — i.e. the **session cold
path**.

**These are two different seams, not one relocated slot.** The existing
`ObservationSummarizer` (pipeline.ts:339) is a *tool-batch* summary injected
into the next turn (`createPendingSummary`, run.ts:1480) — a runtime per-step
concern with its own lifecycle; keep it where it is. The cold-path need is a
*session-history* summarizer over completed turns — a new, separate
`SessionSummarizer`/`ContextSummarizer` seam. Do not collapse the two
lifecycles into one interface; that was a mis-reading of the source in the first
draft.

**Missing middle**: between dumb truncation and LLM summary sits deterministic
structure-aware extraction (keep signatures/outline/schema, drop bodies). For
SparkWright's domain (code + tool output) this captures most of the density
benefit while keeping every deterministic guarantee. Build this (decision ⑥)
before reaching for an LLM.

## 6. Phasing

- **P0 (XS-S)**: Instrumentation / ruler (open point ⑥ subset). Additive, zero
  behavior change. Aggregate `appliedStages[].freedChars` into a
  `compaction.summary` on `run.completed` (trace.ts); record cache hit/miss
  (`cacheReadTokens`, usage.ts:183); derive a `dedup-freed / total-freed`
  regime ratio.
- **P1 (M)**: **Root A — unify substrate.** `renderSessionCompactSummary`
  (runtime.ts:3539) stops concatenating strings: project turns →
  `ContextItem[]` (reuse `conversationTurnContextItems`) → run a deterministic
  sub-pipeline → persist `compact.json`. Wrap `compactSession`
  (runtime.ts:2319) in `compactor-fallback`. Add `session compact` CLI
  subcommand (cli.ts:262).
- **P2 (S)**: **Root B — control plane de-cost.** `usageMeetsGate`
  (pipeline.ts:279/289) drops `minCostUsd` triggering, or treats unknown cost as
  fail-safe-toward-compaction. `costUsd` stays observation-only. Demotes the
  stale pricing table from a control-logic bug to a display blemish.
- **P3 (L)**: **Root C — three tiers + LLM relocation.** Add
  `tier: "dedup" | "evict" | "summarize"` to `CompactionStage`
  (pipeline.ts:43 union); gate tiers separately. Move `ObservationSummarizer`
  wiring from per-step (pipeline.ts:344) to the P1 session Compactor. Add the
  deterministic structure-aware extractive stage (decision ⑥).
- **Backlog**: Open points ①–⑤ (§7), each hung on its tier.

**Ordering logic**: P0 gives the ruler so A/B/C can prove no regression and
classify regime; P1 collapses the skeleton (kills four symptoms at once); P2 is
a clean boundary fix; only then is touching the LLM (P3) worthwhile. Do **not**
front-load the symptom patches (decision ⑧).

### 6.1 P1 expected change list (to be confirmed at implementation)

- `runtime.ts`: `renderSessionCompactSummary` → project-and-compact over
  `ContextItem[]`; `compactSession` wrapped in fallback; short-session returns
  `skipped` (no-op invariant) so `summaryCharCount <= originalCharCount` always;
  `throughRunId`-miss (runtime.ts:1846) emits an explicit warning instead of
  silent full replay.
- `cli.ts`: add `session compact` subcommand (read/trigger; format-preserving).
- `pipeline.ts` / `context-dedup.ts`: expose the deterministic sub-pipeline so
  the session Compactor reuses the same stages (no second implementation).
- project-map: `maps/runtime/context-compaction.md` Contracts + Change
  Checklist; refresh Last Verified.

## 7. Open Questions / Backlog

The skeleton is fixed first; these hang on specific tiers and are taken as
needed. None of them moves the A/B/C skeleton.

- **① Eviction keep-policy** (Tier 2): `snip`/window are recency-based today.
  Relevance-to-current-goal may be better. Internal to Tier 2.
- **② Re-hydration** (Tier 2): `clear_tool_uses` placeholders point back to
  trace — can the model re-fetch a cleared body mid-run if it turns out to need
  it? Today eviction is permanently lossy mid-run.
- **③ Cross-layer budget allocation** (substrate upstream): system prompt, skill
  index, conversation history, tool results compete for the window. Who
  arbitrates the split?
- **④ Session compact lifecycle** (cold entry): when should a session
  auto-compact? Currently manual only. The LLM summary lands as a `session`
  cachePolicy block (computed once, reused across turns ⇒ cache-friendly).
- **⑤ Multi-agent × compaction**: interaction with `extractPartialObservations`
  (parent salvaging a failed child's tool results) and parent/child context.
- **⑥ Measurement / regime classification**: P0 ships the subset; full version
  drives the Tier-3 wake decision (only wake the LLM when a run is classified
  density-bound and the deterministic tiers are exhausted).

## 8. Test Plan

- P0: any run emits the `compaction.summary` rollup; no behavior diff (additive
  only).
- P1: extend `session-compact.test.ts` — short session returns `skipped` and
  `summaryCharCount <= originalCharCount` always holds; `throughRunId`-miss warns
  rather than silently full-replays; P0 metrics show positive session
  `freedChars`. Reuse the same deterministic stages as runtime (no divergence).
- P2: a `costStatus:"unavailable"` usage gates identically to a priced one
  (pressure-only).
- P3: regime ratio drives Tier-3 wake; load-bearing tokens (sentinel test)
  survive the Tier 1/2 path unchanged; `pipeline-stages.test.ts` covers
  per-tier gating.
- Closing `npm run release:check`.

## 9. Last Verified

- Status: Proposed (pre-implementation); nothing built.
- Date: 2026-06-21
- Read: `packages/core/src/pipeline.ts`, `packages/core/src/context-dedup.ts`,
  `packages/core/src/context.ts`, `packages/core/src/session.ts`,
  `packages/core/src/usage.ts`, `packages/core/src/compactor-fallback.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/cli/src/cli.ts`, `packages/provider-ai-sdk/src/index.ts`.
- Evidence: read-only real-model QA (`gpt-5.4-mini`), scenarios A–D, content/
  context compaction.
- Tests: not run; design-only.
