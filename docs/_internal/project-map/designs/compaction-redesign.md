# Design: Compaction Redesign (unified CompactionResult + tiered stages + session extractors)

> **Rev 3 — implementation alignment doc.** The deterministic
> substrate/session extractor path and opt-in LLM-backed Tier3 session
> summarizer are implemented. Remaining work is background auto-trigger
> productization, broader measurement/corpus practice, task-router
> generalization, and the separate auto-auth triage line. This is a design
> target, not a routing map. The active contract for compaction today lives in
> [../maps/runtime/context-compaction.md](../maps/runtime/context-compaction.md),
> `packages/core/src/pipeline.ts`, `packages/core/src/context-dedup.ts`, and
> `packages/host/src/runtime.ts`. All file:line refs verified 2026-06-21.

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
  `CompactionResult` / stage protocol, not two parallel implementations.
- **Deterministic by default stays the identity**: inspectable, reproducible,
  idempotent, evidence-preserving. LLM summarization is opt-in, gated, and
  correctly placed — never the default path.
- **Control decisions never depend on the reporting plane** (cost).
- **Measurable**: every compaction pass reports what it freed, so later tuning
  has a ruler.

## 2. Proposed Decisions

| #   | Decision                                                                   | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | Two parallel implementations                                               | **Unify onto a shared `CompactionResult` protocol + a layered stage taxonomy — NOT the bare `Compactor`.** `Compactor.compact()` returns only `ContextItem[]` (context.ts:138); the no-op/yield invariants need a result that carries `freedChars`/`skippedReason`/`warnings` (today only on `CompactionPipelineResult`, pipeline.ts:107). Session compaction becomes its own tier of deterministic stages, not a host string renderer.                                                                                                                                   |
| ②   | LLM summarizer default                                                     | **Off by default; opt-in, strongly gated, last-resort.** Default path stays deterministic — this is an inspectability/reproducibility requirement, not a perf choice.                                                                                                                                                                                                                                                                                                                                                                                                     |
| ③   | LLM summarizer placement                                                   | **Session cold path, not runtime hot path.** Cold path is off the critical loop, density-bound, the artifact is reused across turns (amortized), and lands as a cache-friendly session block.                                                                                                                                                                                                                                                                                                                                                                             |
| ④   | Three operation tiers                                                      | **Make `dedup` / `evict` / `summarize` first-class**, each with its own gate. Today they are mixed in one ordered list distinguished only by thresholds; `evict` is lossy but disguised as compaction. The existing runtime stages are `tool_result`-only (context-dedup.ts:119/137); **session turns are `user`/`assistant` items (runtime.ts:3520), so reusing them on turns is a no-op** — the session tier needs its own deterministic stages (turn-pair budget, assistant-answer extraction, duplicate-turn/goal merge, decision/constraint/file-path preservation). |
| ⑤   | Control-plane trigger (layered)                                            | **Layer the control signal by tier.** Tier 1/2 (deterministic dedup/evict) gate on always-known pressure/token/char only — never cost. Tier 3 (LLM) gates on pressure **plus** explicit opt-in **plus** a budget/token cap **plus** a pricing/unknown-cost policy: unknown cost must NOT make an expensive LLM easier to trigger. `gateStageByUsage`'s `minCostUsd` is the canonical way to defer the LLM summarizer (CONTEXT_PLANE.md:117), so it stays — for Tier 3 only.                                                                                               |
| ⑥   | Structure-aware extraction                                                 | **Build the deterministic extractive tier before reaching for an LLM.** Keep signatures/outline/schema, drop bodies. Captures most of the density-regime benefit at none of the LLM cost.                                                                                                                                                                                                                                                                                                                                                                                 |
| ⑦   | Cache-stable prefix model                                                  | **Do not touch.** Pass1 append-only / Pass2 break and the `stable/session/turn/volatile` cachePolicy tiers are correct and load-bearing; the redesign builds within them.                                                                                                                                                                                                                                                                                                                                                                                                 |
| ⑧   | Symptom patches (pricing table, short-session guard, throughRunId warning) | **Do NOT land standalone first.** They are leaves of A/B; after the roots are fixed they either disappear or become one line. Fixing leaves first welds logic onto the wrong structure.                                                                                                                                                                                                                                                                                                                                                                                   |

## 3. Pre-Implementation Compaction Surface (inventory)

The table below records the source state that motivated this redesign before
the rev 2 implementation. The current contract lives in
[../maps/runtime/context-compaction.md](../maps/runtime/context-compaction.md).
At the time of this inventory, there were two compaction mechanisms that shared
only the word "compact"; they shared no code, protocol, representation, or
invariants.

| Aspect             | Runtime layer                                          | Session layer                                                      |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Location           | `packages/core`                                        | `packages/host` (bespoke)                                          |
| Representation     | `ContextItem[]`                                        | `CompletedConversationTurn[]` → string                             |
| Protocol           | `Compactor` / `CompactionStage` (pipeline.ts:61)       | none                                                               |
| Trigger gate       | `shouldRun` + `usageMeetsGate` (pipeline.ts:279)       | none (unconditional render)                                        |
| Yield accounting   | `CompactionResult.freedChars` (pipeline.ts:59)         | none                                                               |
| Failure handling   | `compactor-fallback` fail-open (compactor-fallback.ts) | none                                                               |
| Idempotent / no-op | yes                                                    | no (can grow short sessions)                                       |
| Entry point        | core primitive, every entrypoint reuses it             | HostRuntime/TUI/ACP only; no CLI (cli.ts:262 routes only `resume`) |

Implementation note (2026-06-21): P1/P3 work routes session compaction through
`compactSessionTurns()` and session-specific stages, extends the protocol result
shape, adds CLI `session compact`, and supports opt-in model-backed Tier3
session summarization. Background auto-trigger remains future run-loop work.

### 3.1 Key source facts (verified 2026-06-21)

- The five runtime stages are real and registered via
  `createDefaultCompactionStages` (pipeline.ts:705): `tool_result_budget`
  (pipeline.ts:450), `file_read_dedup` (context-dedup.ts:132),
  `observation_one_line` (context-dedup.ts:254), `clear_tool_uses`
  (pipeline.ts:512), `snip` (pipeline.ts:641). Stages "never call out to an LLM,
  are idempotent" (context-dedup.ts:5). **All dedup/one-line stages are
  `tool_result`-only** (context-dedup.ts:137) — they pass `user`/`assistant`
  items through untouched, so they do nothing for session turns.
- Session compact now routes through core `compactSessionTurns()` and writes
  `session-compact.v2` `compact.json` only when the result has net savings.
- **Read path is already unified**: a follow-up run's `loadConversationHistory`
  (runtime.ts:1828) projects both prior turns (`conversationTurnContextItems`,
  runtime.ts:1854) and the compact artifact
  (`sessionCompactArtifactToContextItem`, session.ts) into `ContextItem[]`. The
  asymmetry is only on the **write/compaction** path. This is what makes root A
  tractable.
- `loadConversationHistory` splices the compact item then replays only turns
  after `throughRunId`; if `throughRunId` is not found the compact content is
  not injected and an explicit conversation-layer warning item is added.
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

Two parallel implementations existed in the pre-implementation inventory (§3).
Every one of the following symptoms was a direct projection of the empty right
column of the §3 table:

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
  Tier 1 dedup      file_read_dedup, one_line ✓    NEW turn-level dedup
  Tier 2 evict      clear_tool_uses, snip ✓        NEW old-turn truncation
  Tier 3 summarize  ObservationSummarizer          NEW SessionSummarizer
                    (tool-batch, stays)            (cold-path history, gated)
  ───────────────────────────────────────────────────────────────────────────
  substrate: shared CompactionResult protocol over ContextItem[]   (root A)
```

Runtime and session are separate stage families on a shared result protocol —
**not** the same stages reused (the runtime dedup stages are `tool_result`-only
and no-op on session turns), and **not** the same summarizer relocated (the two
summarizers have different lifecycles). See decisions ① and ④.

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
`ObservationSummarizer` (pipeline.ts:339) is a _tool-batch_ summary injected
into the next turn (`createPendingSummary`, run.ts:1480) — a runtime per-step
concern with its own lifecycle; keep it where it is. The cold-path need is a
_session-history_ summarizer over completed turns — a new, separate
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
  behavior change. Aggregate `appliedStages[].freedChars` (pipeline.ts:107) and
  surface it on the **existing** `context.compaction.completed` metadata
  (events.ts:84) and/or the terminal `run.completed` outcome summary — **do not
  add a new `compaction.summary` event** unless a consumer genuinely needs one
  (avoid widening the event family / schema / RUN_EVENTS surface). Record cache
  hit/miss (`cacheReadTokens`, usage.ts:183); derive a `dedup-freed /
total-freed` regime ratio.
- **P1 (M-L)**: **Root A — unify result protocol + add session-tier stages.**
  Define the shared `CompactionResult` (`freedChars`/`skippedReason`/`warnings`)
  so the no-op/skip invariant is expressible. `renderSessionCompactSummary`
  (runtime.ts:3539) stops concatenating strings and runs **new session-tier
  deterministic stages** over the projected turns (not the `tool_result`-only
  runtime stages, which no-op on `user`/`assistant` items): turn-pair budget,
  assistant-answer extraction, duplicate-turn/goal merge, decision/constraint/
  file-path preservation. Wrap `compactSession` (runtime.ts:2319) in
  `compactor-fallback`. Add `session compact` CLI subcommand (cli.ts:262).
- **P2 (S-M)**: **Root B — layer the control signal (decision ⑤).** Tier 1/2
  gating drops `minCostUsd` and uses pressure/token/char only; unknown cost
  fails safe toward deterministic compaction. **Tier 3 (LLM) keeps a cost/budget
  gate** (`gateStageByUsage` `minCostUsd`, CONTEXT*PLANE.md:117) plus explicit
  opt-in and a token cap; unknown pricing must default toward \_not* firing the
  LLM. Demotes the stale pricing table from a control-logic bug (for
  deterministic tiers) to a budget-policy input (for Tier 3).
- **P3 (L)**: **Root C — layered tiers + new session summarizer seam.** Add
  `tier: "dedup" | "extract" | "evict" | "summarize"` to `CompactionStage`
  (pipeline.ts union); gate tiers separately. Add a **new**
  `SessionSummarizer`/`ContextSummarizer` seam for cold-path history (do NOT
  move the per-step `ObservationSummarizer`, pipeline.ts:339 — different
  lifecycle; it stays). Add the deterministic structure-aware extractive stage
  (decision ⑥) as the Tier-2.5 step before any LLM.
- **Backlog**: Open points ①–⑤ (§7), each hung on its tier.

**Ordering logic**: P0 gives the ruler so A/B/C can prove no regression and
classify regime; P1 collapses the skeleton (result protocol + session stages);
P2 layers the control signal; only then is touching the LLM (P3) worthwhile. Do
**not** front-load the symptom patches (decision ⑧).

### 6.1 P1 expected change list (to be confirmed at implementation)

Migration surface is wider than runtime/cli/map — `compactSession` is a protocol
result consumed across host/SDK/TUI:

- `core`: define `CompactionResult` (`freedChars`/`skippedReason`/`warnings`);
  new session-tier deterministic stages (separate from the `tool_result`-only
  runtime stages).
- `runtime.ts`: `renderSessionCompactSummary` → run session-tier stages;
  `compactSession` wrapped in fallback; short-session returns `skipped` (no-op
  invariant) so `summaryCharCount <= originalCharCount` always; `throughRunId`-miss
  (runtime.ts:1846) emits an explicit warning instead of silent full replay.
- `protocol` + SDK: extend the `session.compact` result shape with
  `freedChars`, `skippedReason`, and `warnings`; artifact persistence is a clean
  `session-compact.v2` shape with top-level `freedChars`.
- `tui`: `run-controller.ts:393` currently reads `compactedRunCount === 0` as
  "no completed turns yet" — must distinguish that from a real
  no-gain/`skipped` outcome, and surface `warnings` in the toast.
- `cli.ts`: add `session compact` subcommand (read/trigger; format-preserving).
- docs: `docs/reference/HOST_PROTOCOL.md` (result shape), `CONTEXT_PLANE.md`,
  `RUN_EVENTS.md` if any event metadata changes.
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

- P0: rollup appears on `context.compaction.completed` metadata / `run.completed`
  outcome (no new event); no behavior diff (additive only).
- P1: extend `session-compact.test.ts` — short session returns `skipped` and
  `summaryCharCount <= originalCharCount` always holds; unsupported/stale
  compact artifacts are not injected; session-tier stages preserve golden
  coding-session signals and produce positive `freedChars` on repetitive
  multi-turn sessions (and the runtime `tool_result`-only stages are NOT relied
  on for turns).
- P2: deterministic tiers gate identically whether `costStatus` is priced or
  `"unavailable"` (pressure-only); the Tier-3 LLM gate does NOT fire when pricing
  is unknown and no explicit opt-in/budget is set.
- P3: regime ratio drives Tier-3 wake; `pipeline-stages.test.ts` covers per-tier
  gating; the per-step `ObservationSummarizer` seam is unchanged.
- **LLM session-summary fidelity rubric** (gates Tier-3 acceptance, not just the
  sentinel test): a summary must preserve the user's hard constraints,
  unfinished items, failures/denials, file paths, decisions, `sourceRunIds`,
  sub-agent partial/finality markers, approval state, and write state.
  Sentinel-token survival is necessary but not sufficient.
- Closing `npm run release:check`.

## 9. Tier 3 — LLM session summarizer (detailed design)

Status: **implemented, opt-in.** P3a–P3c are done; this section records the
Tier-3 seam and gates so deterministic work below it stays the floor. Background
auto-trigger productization, broader measurement/corpus practice, task-router
generalization, and auto-auth triage remain pending.

### 9.1 Prerequisites (must land before Tier 3 is even measurable)

The deterministic floor must be measurable before Tier 3 can be evaluated. Two
implementation-review findings were fixed in Rev 2:

- **Extraction tier separated from dedup.** `createSessionTurnExtractionStage`
  is lossy, so it reports `tier: "extract"` rather than poisoning
  `freedByTier.dedup`. The dedup/total ratio now represents genuine redundancy.
- **No silent final-render truncation.** Surviving raw turns render their full
  content in the persisted deterministic summary. Any future lossy render step
  must add an explicit marker/warning so Tier 3's fidelity baseline remains
  auditable.

**P3a–P3d implementation status.** The cold path now has the deterministic
floor, model-backed Tier 3 routing, and measurement hooks:

- `ContextUsageHint` carries `costStatus` / `costUnavailableReasons`, and
  `buildUsageHint` forwards those fields so the session summarizer can
  distinguish unknown cost from a real `$0` estimate.
- `loadCompletedConversationTurns` attaches trace-derived `SessionTraceFacts`
  for approvals, workspace writes, and sub-agent finality; deterministic
  replacement stages carry those facts forward so extraction/eviction does not
  erase the oracle input.
- `extractSessionSignals` is exported as structured `SessionSignals` covering
  constraints, exact literals/sentinel tokens, paths, status, source runs,
  approvals, workspace writes, and sub-agents. The `literal` class is enforced
  verbatim (self-reported coverage cannot waive it), so a paraphrase that drops
  an exact token the user asked to preserve is rejected even when the source
  constraint line is compacted past its 180-char prefix.
- The Tier 3 stage is a dedicated `tier: "summarize"` session stage. It records
  source-over-cap, unknown-cost policy skip, summarizer failure/decline,
  no-savings, and oracle rejection in `warnings` / metadata rather than relying
  on runtime compaction events.
- `tasks.<name>.budget` exists in shared config and generated schema. Host
  `llm`/task routing now resolves through the existing model factory:
  provider/scripted refs use the model-backed summarizer; deterministic refs use
  `createDeterministicSessionSummarizer()` as a preview with an explicit
  warning.
- Accepted model-backed summaries record `summaryFingerprint`; every result
  carries P3d `measurement`, and `measureSessionCompactionCorpus()` supports
  density-regime corpus evaluation.

**Three gates (the rest of §9 details each).** Tier 3 must pass three orthogonal
gates; conflating them is the main failure mode. This is root B generalized:
**the control plane depends only on always-enforceable quantities (char/token
caps); the reporting plane (USD cost) is best-effort and its absence must never
masquerade as a control signal.**

1. **Wake gate** (9.3) — _should_ we summarize now? density-bound + high
   pressure + deterministic tiers insufficient. Manual `/compact --llm` bypasses
   the wake gate (the user asked).
2. **Spend / safety gate** (9.4) — are we _allowed_ to spend? explicit opt-in +
   an enforceable `maxSourceChars` floor + `maxOutputTokens`. Independent of the
   wake gate; auto must pass both.
3. **Acceptance gate** (9.5) — is the result _trustworthy_? the structured
   `SessionSignals` oracle passes, else deterministic fallback + warning.

### 9.2 Seam: `SessionSummarizer` (separate from `ObservationSummarizer`)

A new cold-path interface, NOT the per-step `ObservationSummarizer`
(pipeline.ts:339 — different lifecycle; leave it untouched, decision ③).

```ts
export interface SessionSummarizer {
  summarizeSession(input: {
    // deterministic Tier-1/2 output (already deduped/extracted/evicted),
    // so the LLM compresses density, not redundancy:
    items: ContextItem[];
    // the signals the deterministic extractor already found — the LLM's
    // required-coverage checklist (see 9.5):
    requiredSignals: SessionSignals;
    sourceRunIds: RunId[];
    // maxSourceChars is the enforceable floor; maxInputTokens/maxCostUsd are
    // refinements only when a tokenizer/pricing exist (see 9.4):
    budget: {
      maxSourceChars: number;
      maxOutputTokens: number;
      maxInputTokens?: number;
      maxCostUsd?: number;
      unknownCostPolicy?: "skip" | "token_cap_only";
    };
    abortSignal?: AbortSignal;
  }): Promise<SessionSummaryResult | null>; // null ⇒ decline, fall back
}
```

`SessionSummaryResult` carries the summary text **plus** self-reported coverage
so the oracle (9.5) can verify rather than trust. The summarizer operates as a
`tier: "summarize"` stage and reuses the `CompactionResult` accounting shape, but
fail-open is **not** automatic: the session path passes no `events` and does not
go through `compactor-fallback` (9.1 blocker), so the Tier 3 stage must
**explicitly** write `summarizer_failed`/`oracle_rejected`/`over_budget` into
`warnings`/`metadata` and return the deterministic fallback itself.

### 9.3 Wake policy — Gate 1: when Tier 3 runs at all

This gate is orthogonal to the spend gate (9.4); auto must pass both, and
**manual `/compact --llm` bypasses this wake gate** (but not the spend or
acceptance gates). Tier 3 fires only when **all** hold (AND):

- regime is **density-bound** — `freedByTier.dedup / totalFreed` is low while
  `extract`/`evict` could not relieve pressure enough. This keeps true
  redundancy separate from lossy deterministic compression.
- context-window pressure clears a high threshold (reuse the
  `minContextWindowPressure` threshold _semantics_ from CONTEXT_PLANE.md:117 —
  **not** the `gateStageByUsage` helper itself, which the dedicated gate in 9.4
  replaces).
- **explicit opt-in** is set (config flag). Off by default (decision ②).

In the redundancy-bound regime (the agent-loop common case) Tier 3 never wakes —
the deterministic floor already handled it, and an LLM there is negative value.

### 9.4 Spend / safety gate — Gate 2 (Tier-3 only)

The governing principle (root B generalized): **unknown pricing must NOT block
token/char-bounded execution.** Gating execution on an unknown USD figure is
gating the control plane on the reporting plane — the exact anti-pattern root B
named. The real worst-case bound is the char/token cap, not "is the price
known".

Enforceable floor vs refinements:

- **`maxSourceChars` is the mandatory, always-enforceable input floor.** It needs
  no tokenizer or pricing — it is the deterministic bound on the cost driver
  (summarization is input-dominated, so an output cap alone under-bounds spend).
- `maxOutputTokens` is also required (bounds the generated tail).
- `maxInputTokens` (needs a tokenizer) and `maxCostUsd` (needs pricing) are
  **refinements layered on top when those signals exist** — never the floor.

Behavior:

- **Source over `maxSourceChars` ⇒ skip the LLM, deterministic fallback.** v1 does
  **not** chunk: chunking turns one call into N and re-introduces unbounded spend
  under unknown price. Any future chunking MUST carry `maxChunks`/`maxDepth`.
- **Known pricing** ⇒ `maxCostUsd` can additionally be enforced.
- **Unknown pricing** (`costStatus:"unavailable"`/`missing_pricing`) ⇒ execution
  still runs, bounded by the char/token caps; the result records
  `costStatus: "unavailable"` in `warnings`/`metadata`. Do **not** claim
  `maxCostUsd` was honored, and do **not** silently ignore it either (the
  original QA bug).
- **Auto + an explicit `maxCostUsd` set + unknown pricing** ⇒ the user asked for
  a USD ceiling we cannot honor, so respect intent: default **`unknownCostPolicy:
"skip"`**, unless the user opts into `"token_cap_only"` (run on the caps,
  accept no USD ceiling). Manual `/compact --llm` still runs under the hard caps;
  provider/scripted model refs use the model-backed summarizer, and
  deterministic refs return an explicit deterministic-preview warning.

The cold-path gate must be **dedicated**, not `gateStageByUsage` — that helper is
bypassed on reactive overflow (pipeline.ts:382). Pressure may relax reactively;
opt-in, the caps, and `unknownCostPolicy` must never be bypassed (see the 9.1
blocker).

### 9.5 Fidelity oracle — Gate 3: the deterministic extractor checks the LLM

The key architectural payoff of doing Tier 3 _after_ the deterministic layer:
the deterministic `extractSessionSignals` (session-compaction.ts:620) becomes
the **automated acceptance oracle** for the LLM summary, turning the §8 rubric
from a human checklist into a gate.

Implementation note: P3b widened the deterministic oracle to include
trace-derived facts. The structured `SessionSignals` set now covers
constraints, exact literals/sentinel tokens, paths, status, source runs,
approval state, workspace write state, and sub-agent finality; the P3c
model-backed path must satisfy this same oracle before its output can replace
deterministic content. The `literal` class closes the gap the sentinel test
exposed: the oracle requires exact-token presence and ignores self-reported
coverage for that class.

The gate itself:

- before accepting an LLM summary, assert every `requiredSignals` entry is
  present in the summary text;
- a summary that silently drops a constraint/path/finality marker the
  deterministic extractor found, or marks that known deterministic signal
  `unknown`, is **rejected** ⇒ fall back to deterministic content (9.6). The
  sentinel test becomes one instance of this general check.

This is why Tier 3 must consume the deterministic output, not bypass it: the
deterministic pass produces both the _input_ (density-only residue) and the
_answer key_ (required signals).

### 9.6 Fallback / fail-open

LLM error, timeout, over-budget, declined (`null`), or **failed oracle** ⇒
return the deterministic `content` unchanged. The session summarizer stage
returns skipped results plus warnings/metadata on failure, and the host
`compactSession()` path remains fail-open around `compactSessionTurns()`.
Compaction must never block or fail because the LLM did.

### 9.7 Determinism, cache, reproducibility

- The LLM artifact is non-deterministic. Mark it: `metadata.mode = "llm"`,
  `modelId`, `nonDeterministic: true`, and keep the deterministic `freedChars` /
  signal coverage alongside.
- It lands as a `session` cachePolicy block (context.ts) — computed once, reused
  across turns, cache-friendly (amortized; off the hot path).
- The trace/QA harness must tolerate a non-deterministic compact artifact:
  assert on **signal coverage**, not byte-equality. Provide a **deterministic
  stub summarizer** so existing reproducible tests stay reproducible.
- The single overwriting `compact.json` (session.ts) needs a **fingerprint** so a
  later run can decide reuse vs recompute vs stale: record `modelId`,
  `promptVersion`, `oracleVersion`, `inputHash`, `sourceRunIds`, `throughRunId`,
  and the effective `budget`. Without it an LLM artifact is unreusable safely.

### 9.8 Safety

- `COMPACTION_SAFETY_PREFIX` (`[CONTEXT COMPACTION — REFERENCE ONLY]`,
  context-safety.ts:42) still wraps the injected summary.
- Input is completed user goals + assistant answers (already model-emitted), not
  raw untrusted tool output, so the injection surface is lower than the runtime
  observation path — but the summarizer prompt must still treat turn content as
  data, not instructions.

### 9.9 Phasing within P3

- **P3a — Done.** Plumbed `costStatus` to the cold path, widened oracle input to
  trace-derived facts, exported structured `SessionSignals`, routed failures
  into `warnings`/`metadata`, and added the dedicated spend gate.
- **P3b — Done.** Added the `SessionSummarizer` seam, deterministic stub, wake /
  spend / acceptance gates, `session.compact` / CLI `--llm` wiring, and
  `tasks.*` budget config (§9.11). Deterministic model refs still return a
  deterministic-preview warning.
- **P3c — Done.** `llm` / `tasks.compaction.enabled` now resolve through the
  host model factory; provider/scripted models run the model-backed
  summarizer, deterministic refs keep the preview path. The acceptance oracle is
  enforced and accepted summaries write `summaryFingerprint` metadata.
- **P3d — Done.** Session compaction results include `measurement`, and core
  exposes `measureSessionCompactionCorpus()` for density-regime corpus checks,
  summary fidelity comparison, and cost/latency amortization metrics.

### 9.10 Test plan additions

- oracle rejects a summary that omits a known constraint/path/finality signal,
  and the result falls back to deterministic content;
- summarizer throw / timeout / over-budget ⇒ deterministic content, run survives;
- deterministic stub path is byte-stable (reproducible harness intact);
- source over `maxSourceChars` ⇒ LLM skipped, deterministic fallback (no chunk);
- unknown pricing does NOT block a token/char-bounded run; auto + explicit
  `maxCostUsd` + unknown pricing ⇒ skip unless `unknownCostPolicy:
"token_cap_only"`;
- wake policy stays dormant in a redundancy-bound regime fixture.

### 9.11 Task-model routing & spend authorization

Tier 3 is the first instance of a general pattern: model-backed auxiliary tasks
(compaction, trace/session labeling, signal tidy-up, capability summaries,
issue/diagnostic clustering, approval triage). They share one contract, so the
config and the safety invariants are defined once here, not per task.

**Config — shared `budget` block under `tasks.<name>`** (avoids the per-task
field sprawl config-redesign §7 warns about; common case ≈ `enabled: true`):

```yaml
models:
  default: openai/gpt-5.4
  mini: openai/gpt-5.4-mini # alias, resolved by the existing model-ref resolver
tasks:
  compaction:
    enabled: true
    model: mini # defaults to the current agent model if unset
    budget:
      maxSourceChars: 60000 # enforceable floor (required; internal default ok)
      maxOutputTokens: 1600
      maxCostUsd: 0.05 # refinement; only enforceable when pricing known
      unknownCostPolicy: skip # skip | token_cap_only
```

- **Model selection ≠ spend authorization.** Defaulting `model` to the current
  agent model is fine UX (esp. for manual `/compact --llm`); it does **not**
  grant unlimited background spend. `mini` is **routing only, never a cost
  exemption** — a configured mini can still be `missing_pricing`, so the
  char/token caps and `unknownCostPolicy` still apply to it.
- `model: mini` must resolve through the **existing model-ref resolver + alias
  registry**, not a parallel one (no third model-selection surface).
- The `budget` contract (caps + `unknownCostPolicy`) is **shared across all
  `tasks.*`**, not redefined per task.

**Spend authorization invariant (all `tasks.*`):** execution is bounded by the
char/token caps (always enforceable). USD does **not** enter the hard control
plane — it only refines when pricing is known. The one exception is intent-driven:
when a user **explicitly** sets a USD ceiling and pricing is unknown, auto honors
that stated intent via `unknownCostPolicy` (default `skip`; §9.4) rather than
silently running as if the ceiling held. USD never _enables_ spend that the caps
forbid; it can only cause an explicit-ceiling auto run to defer (root B).

**Authorization red line (system principle, all `tasks.*`):** a model — mini
included — **never grants authority.** It may _triage_ (rank, explain, flag "this
looks dangerous"), feeding a human or a deterministic rule engine. `auto-approve`
may come **only from deterministic allowlist rules** (read-only, known-safe path,
no write, no network, no secrets). The component judging "is this safe" reads the
very content that may be attacking it, so model judgement is advisory, never the
grantor. Same shape as compaction: deterministic floor, model is an enhancement
on top.

## 10. Last Verified

- Status: Rev 3 P3a–P3d implemented. Shared `CompactionResult`, stage tiers,
  deterministic session extractors, host/protocol/TUI/CLI response plumbing,
  v2 compact artifacts, no-savings skip behavior, `SessionSummarizer` seam,
  deterministic Tier 3 preview, model-backed Tier 3 summarizer routing,
  trace-derived oracle signals, dedicated wake/spend gates, `tasks.*.budget`
  config, summary fingerprint metadata, and P3d measurement/corpus reporting
  are implemented.
- Date: 2026-06-21
- Read: `packages/core/src/pipeline.ts`, `packages/core/src/context-dedup.ts`,
  `packages/core/src/session-compaction.ts`, `packages/core/src/context.ts`,
  `packages/core/src/session.ts`, `packages/core/src/usage.ts`,
  `packages/core/src/compactor-fallback.ts`, `packages/core/src/run.ts`,
  `packages/core/src/events.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`, `packages/protocol/src/index.ts`,
  `packages/cli/src/cli.ts`, `packages/provider-ai-sdk/src/index.ts`,
  `packages/tui/src/state/run-controller.ts`, `docs/reference/CONTEXT_PLANE.md`.
- Tests: `npm --workspace @sparkwright/core test -- session-compact.test.ts`;
  `npm --workspace @sparkwright/host test -- config.test.ts protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- cli.test.ts`;
  `npm run typecheck:test -- --pretty false`; `npm run schema:check`;
  `npm run release:check`.
- Evidence: P3b/P3c/P3d QA covers trace-derived oracle signals,
  source-over-`maxSourceChars` fallback, unknown-cost policy skip/run cases,
  oracle rejection fallback including untrusted `coveredSignalIds`,
  redundancy-bound wake dormancy, host config budget integration, model-backed
  scripted summarizer routing, artifact `summaryFingerprint`, protocol/CLI
  `measurement`, corpus regime reporting, oracle rejection for required
  `unknownSignalIds`, summarizer timeout fallback, CLI `--llm`
  deterministic-preview warning, and full release gate.
- Follow-up before background auto-trigger: aux summarizer usage is visible in
  artifact/protocol `measurement`, but a run-loop auto path must also fold that
  usage into the owning run's usage/trace stream rather than leaving background
  spend visible only in the compact artifact.
- Rev 2 corrections (review-driven, all verified against source): substrate is a
  shared `CompactionResult` not the bare `Compactor` (context.ts:138); session
  needs its own stages because runtime dedup is `tool_result`-only
  (context-dedup.ts:137) and turns are `user`/`assistant` (runtime.ts:3520);
  control signal is layered, LLM Tier 3 keeps a cost/budget gate
  (CONTEXT_PLANE.md:117); `ObservationSummarizer` (pipeline.ts:339) stays, add a
  separate `SessionSummarizer`; P0 rollup rides existing
  `context.compaction.completed`, no new event (events.ts:84); migration surface
  includes protocol/schema/SDK/TUI (run-controller.ts:393); fn is
  `createDefaultCompactionStages` (pipeline.ts:705).
- External-provider network QA not run in this verification pass; the
  model-backed path is covered through the scripted adapter, and background
  run-loop auto-trigger remains future work.
