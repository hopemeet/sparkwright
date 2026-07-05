# Review: spawn_agent child truncation & parent re-spawn loop

> Source: real-model read-only multi-agent QA run
> `openai/gpt-5.4-mini`, trace `.sparkwright/sessions/qa-mini-multiagent-trace-20260620-1/trace.jsonl`
> All file:line references verified against source on branch `fix/surface-skill-load-failures`.

## TL;DR

The trace design is sound (parent/child attribution, child trace, terminal state,
`session check`, `trace report` all work and correctly flagged the run as `failed`).
The real defect is in the **runtime/harness control layer**: soft constraints never
become hard boundaries, and an incomplete child result produces too weak a runtime
signal. A mid/weak model (the trigger, not the root cause) then re-spawned 8 times and
read the same files 50× without any in-run brake.

Root-cause chain (verified):
1. Child tasks were too large for the effective step budget.
2. A truncated child (`completed` + `stepLimitReached=true`) is wrapped as a **successful**
   tool result — the parent's signal is ambiguous.
3. Context compaction collapses old `spawn_agent` results to a one-line summary that
   **drops** `stepLimitReached` / `truncated` / `role` / `childRunId`.
4. The doom-loop guard only catches verbatim-arg repeats or repeats of a *failed/no-op*
   target — semantically duplicate re-spawns and successful re-reads sail through.
5. The main agent's budget is wide (`maxModelCalls=80`); `LOW_NET_PROGRESS` only exists
   as a post-hoc report, not a runtime brake.

## Key mechanics (confirmed)

- **A `step` = one model turn**, not one tool call. A turn can batch multiple tool calls.
  Loop: `while (state.step <= this.maxSteps)` — [run.ts:1042](../../../packages/core/src/run.ts).
- **Child `maxSteps`: default 8, hard cap 16** —
  [runtime.ts:3451](../../../packages/host/src/runtime.ts) (`?? 8`),
  [runtime.ts:3462](../../../packages/host/src/runtime.ts) (`Math.min(maxSteps, 16)`).
- **Main agent maxSteps is NOT a fixed small number** — `resolveMainAgentMaxSteps`
  [runtime.ts:2746](../../../packages/host/src/runtime.ts): explicit `profile.maxSteps`,
  else `runBudget.maxModelCalls` (80 in this run), else backstop **100**
  ([runtime.ts:2736](../../../packages/host/src/runtime.ts)). By design the main agent
  binds on the *resource* axis, not a step cap (ADR 0009).

## Decision already made: do NOT set child cap == main agent maxSteps

Tying the child cap to the parent's maxSteps means raising it from 16 to 80–100. That:
- destroys the child's containment semantics (a child could run as long as the whole main agent);
- inflates **larger sibling fan-out / aggregate child spend** — one parent turn can spawn many
  siblings, and child usage folds into the parent tracker, so a higher cap multiplies total spend
  across siblings even without recursion;
- contradicts ADR 0009 (main agent intentionally avoids a tight step cap; children are the
  opposite — they are meant to be bounded by one).

Scope note on recursion: **nested dynamic spawn is already prohibited** — the dynamic
`spawn_agent` child is granted only `read_file`/`glob`/`grep`/`list_dir` and its tool
description states it "cannot write, run shell commands, or spawn further agents"
([runtime.ts:3192](../../../packages/host/src/runtime.ts)); the child has no `spawn_agent`
tool at all. So grandchild blowup is not the dynamic-path risk. The **config-defined
delegate / other agent paths** can still nest and remain bounded by
`assertSubagentDepthAllowed({ maxDepth })`
([runtime.ts:3006](../../../packages/host/src/runtime.ts),
[runtime.ts:3251](../../../packages/host/src/runtime.ts)) — keep that as the depth guard
rather than leaning on the child step cap.

If the cap should grow at all, keep it an **absolute, modest** value decoupled from the
parent (e.g. 16 → 24/32), or scale it **down by depth** / bound it by the parent's
*remaining* budget. The operating value stays the per-spawn `maxSteps` argument; the cap
is only a safety ceiling.

---

## Fixes (ranked: cleanest → most regression-prone)

**Build order:** do **F2's metadata plumbing before F1's renderer** — F1 has nothing to
render until the spawn fields are lifted onto `ContextItem.metadata`. So land
`extractObservationMetadata` (F2 part 1) first, then the renderer (F1), then F2 part 2
(the warning text), then F3 → F4 → F5. The ranking below is by risk, not build order.

### F1 — Preserve child fields in the collapsed one-line summary  **(highest value, lowest risk)**

**Problem.** `defaultOneLineRender` only emits `toolName` / `status` / `exitCode` / char+line
counts — [context-dedup.ts:312-324](../../../packages/core/src/context-dedup.ts). Once an old
`spawn_agent` result is collapsed, the parent sees `status=completed` and loses
`stepLimitReached`, `truncated`, `role`, `childRunId`.

Precise role (don't overstate): at step 2 the parent *did* see the full
`stepLimitReached=true` on the uncollapsed child result and chose to continue direct-read
anyway. Compaction later collapsed those older `spawn_agent` results to a one-line summary,
which is the **major amplifier / proximate cause after compaction** of the re-spawn loop —
not the sole/direct cause. The model's initial choice to keep reading is upstream of this.

**Change.** When the collapsed item is a `spawn_agent` tool result, append the surviving
signal to the one-line render, e.g.
`[spawn_agent] status=completed role=<role> child=<childRunId> partial=true(stepLimit) 3568 chars …`.
Pull these from `item.metadata` (they must be present there — see F2).

**Risk.** Low. One renderer, additive output. Keep the line short so it doesn't defeat the
purpose of collapsing.

**Tests.** Unit test on the one-line renderer: a `spawn_agent` result with
`stepLimitReached=true` collapses to a line that still contains `partial`/`stepLimit` and
the `role`/`childRunId`; a roomy child does not.

### F2 — Turn `completed + stepLimitReached=true` into a hard structured warning to the parent

**Problem.** `spawn_agent` only throws when `result.signal !== "completed"`
([runtime.ts:3382](../../../packages/host/src/runtime.ts)). A truncated child
(`completed` + `stepLimitReached=true`) returns a normal `completed` tool result. The field
*is* already on the uncompacted output ([runtime.ts:3361](../../../packages/host/src/runtime.ts))
with a comment about letting the parent caveat — but the signal is too soft and is lost on
collapse (F1).

**Implementation landing point (specific).** The `ContextItem.metadata` that
`defaultOneLineRender` (F1) reads is **not** the `spawn_agent` output object — it is produced
by `DefaultObservationFormatter` via `extractObservationMetadata(toolName, output)`
([context.ts:345](../../../packages/core/src/context.ts), called from
[context.ts:312-339](../../../packages/core/src/context.ts)). Today that function only lifts
`path` / `exitCode` / `truncated` / `hasMore` / `nextOffset` from output. Note the **trap**:
it already lifts a generic `output.truncated` ([context.ts:363](../../../packages/core/src/context.ts)),
but `spawn_agent`'s output has **no** `truncated` field — only `signal` / `stepLimitReached`
/ `role` / `childRunId` ([runtime.ts:3354](../../../packages/host/src/runtime.ts)). So the
generic branch never fires for spawn results.

**Change.** Two parts, plumbing first:
1. In `extractObservationMetadata`, add a `spawn_agent` branch that lifts `childRunId`,
   `role`, `stepLimitReached`, a derived `finality` (`"partial"` when
   `stepLimitReached===true`, else `"complete"`), and `truncated` into the returned metadata
   — so they land on `ContextItem.metadata` and survive compaction.
2. For `completed + stepLimitReached=true`, keep the result `completed` (don't break salvage)
   and inject an explicit structured warning into the result text the parent reads, e.g.
   "This child hit its step budget and wrapped up early; its answer may be incomplete. Do not
   re-spawn the same scope — raise `maxSteps` or summarize from the partial result."

**Risk.** Low/medium. Don't change the `signal` (downstream treats non-`completed` as failure
and triggers the salvage/throw path). Pure additive metadata + message text. If
`DefaultObservationFormatter` is swapped via `observationFormatter` option, the spawn fields
won't appear — acceptable (the renderer just degrades to today's behavior).

**Tests.** A child that wraps up at the step limit yields a `completed` result whose metadata
carries `stepLimitReached=true` / `finality=partial` and whose message contains the warning.

### F3 — Semantic dedupe for `spawn_agent` (nudge before re-spawning the same scope)

**Problem.** The doom-loop guard's `semanticToolTarget` keys `spawn_agent` on the full
JSON args ([run.ts:4128](../../../packages/core/src/run.ts)), so a re-spawn with a different
`role`/`prompt`/`goal` is a brand-new key and is never caught. And the guard only fires when
the prior call on a target **failed/no-op'd** ([run.ts:2352-2359](../../../packages/core/src/run.ts)).

**Existing precedent — reuse it.** The config delegate path already emits a similar note:
"A similar delegation already completed in this parent run; summarize the previous child
result instead of spawning another child agent."
([agent-runtime/src/index.ts:1118](../../../packages/agent-runtime/src/index.ts)). Extend/
mirror that mechanism for the dynamic `spawn_agent` path rather than inventing a parallel one.

**Change.** Add a `spawn_agent`-specific dedupe keyed on a coarse `(parentRunId, role-or-goal scope)`
rather than exact args. On a repeat against a scope that already produced a **partial**
(stepLimitReached) child, nudge/soft-block: "A partial result for this scope already exists —
raise `maxSteps` or summarize instead of re-spawning." Track this per-run alongside existing
loop-guard bookkeeping.

**Risk.** Medium. Needs a scope-normalization heuristic (role vs goal). Make it a nudge first,
not a hard block, to avoid starving legitimate distinct sub-tasks that happen to share a role.

**Tests.** Two spawns with same role/goal scope where the first is partial → second is nudged;
two spawns with genuinely different scopes → both allowed.

### F4 — Move `LOW_NET_PROGRESS` / `REPEATED_TOOL_REQUESTS` from post-hoc report to runtime feedback

**Problem.** These only exist in `trace report` after the fact ([trace.ts:443](../../../packages/core/src/trace.ts)
and nearby). There is no in-run brake on a main agent burning calls with low net progress.

**Change.** Surface a runtime signal (reuse the existing `RuntimeSignal` workflow-hook phase,
[run.ts:2388-2409](../../../packages/core/src/run.ts)) when net progress stays low over a
window of turns, feeding the model a "you are not converging — summarize or stop" directive.

**Risk.** Medium. Needs a "net progress" metric available at runtime (the report computes it
post-hoc; check whether the inputs are cheaply available mid-run). Tune the window to avoid
false positives on legitimately exploratory phases.

**Tests.** A synthetic run with repeated low-progress turns emits the runtime signal at the
expected threshold; a normal run does not.

### F5 — Count successful duplicate reads  **(most regression-prone; do last / optional)**

**Problem.** `read_file`'s `semanticToolTarget` keys on `path` only (ignores offset/limit) —
[run.ts:4118](../../../packages/core/src/run.ts) — but a **successful** read clears
`lastFailedToolTarget` ([run.ts:3067](../../../packages/core/src/run.ts)), by design, to allow
legitimate pagination ([run.ts:2343-2347](../../../packages/core/src/run.ts)). So 50 successful
re-reads of the same file are intentionally let through.

**Change.** Add a separate counter for *successful* reads of the same `path` that nudges after
N repeats — WITHOUT reusing the failure/no-op path, and WITHOUT blocking forward pagination
(distinguish "same path, advancing offset" from "same path, same/overlapping range").

**Risk.** High. Directly collides with the legitimate-pagination exemption. Easy to regress
normal multi-page reads. Only do this if F1–F4 don't sufficiently curb the behavior.

**Tests.** Same path read with advancing offsets → never nudged; same path same range read N
times → nudged after threshold.

---

## Optional: scenario-aware child step room

Not required, but if F1–F4 leave read-heavy QA children still truncating: when a child's
`allowedTools` are read-only retrieval (read_file/grep/list_dir), allow a higher per-spawn
default/cap (e.g. 12–16) while keeping the global default 8 for light spawns. Adds one
heuristic to maintain — lower priority than fixing the signal. Prefer steering children to
**grep-first, line-targeted** tasks over giving them more steps.

## What NOT to change

- Don't bump the global child default 8 — it taxes every cheap spawn and deepens recursion cost.
- Don't tie the child cap to the parent's maxSteps (see decision above).
- Don't flip a truncated child's `signal` away from `completed` — it would trip the
  failure/salvage path. Use metadata + message instead (F2).
