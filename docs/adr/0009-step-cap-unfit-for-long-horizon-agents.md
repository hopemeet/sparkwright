# ADR 0009: Step Count Is Not A Task Budget For Long-Horizon Agents

## Status

Proposed

## Context

The run loop bounds every run with `maxSteps`, defaulting to `8`
(`packages/core/src/run.ts` — `this.maxSteps = options.maxSteps ?? 8`). When a
run reaches that ceiling it calls `this.fail("max_steps_exceeded", ...)`: a hard
failure that discards everything the run produced. The `8` was tuned for the
deterministic golden path and short sub-agent delegations (spawned children are
clamped to `Math.min(maxSteps, 16)` in `packages/host/src/runtime.ts`), where a
run is "make one edit" or "answer one question".

This default leaks into the interactive main agent, where it is the wrong
primitive. Three consecutive triage runs of the same task ("read every file
under `docs/` and summarize each") exposed the failure modes:

1. **Premature give-up under a blind counter.** With only `Step: N` visible to
   the model (no ceiling), the model finished at step 5/8 with a
   self-described-incomplete answer, inventing the constraint "I can't read all
   files in one reply." Budget headroom existed; the model couldn't see it.
2. **Hard crash on loop.** A later run looped — re-globbing, re-reading the same
   files — burned all 8 steps, produced **zero output**, and ended in
   `run.failed / max_steps_exceeded`. ~16 successful reads were discarded.
3. **Visibility alone is insufficient.** After surfacing `Step: N / M` to the
   model, a third run still looped (hammering `read_file` on the `docs/adr`
   *directory* four times — `EISDIR` each time, slipped past the repeated-call
   guard because offset/limit varied) and still hard-failed at 8/8.

The deeper problem: **step count cannot distinguish legitimate long-horizon work
from a runaway loop.** Auto-research, deep agent loops, and broad sweeps
*legitimately* need many steps. A fixed step cap punishes them identically to a
stuck model. Capping low strangles real work; capping high defeats the
circuit-breaker. There is no good single number because step count is the wrong
axis.

Critically, the kernel **already has the right primitive**. `RunBudget`
(`packages/core/src/run.ts:2602–2704`) bounds runs by *resources* —
`maxModelCalls`, `maxToolCalls`, `maxDurationMs`, `maxTokens` — which is what
actually correlates with cost and runaway risk. `maxSteps` is a cruder, parallel
mechanism that the main agent path uses instead of (not alongside) `RunBudget`.

## Decision

Treat `maxSteps` as a coarse backstop, not the task budget. For long-horizon and
interactive runs, bound work along three axes instead of a raw step count:

1. **Resource budget as the safety backstop.** The binding limit for a
   main/research agent is a generous `RunBudget` (tokens / model calls / wall
   clock), not `maxSteps`. `maxSteps` is either decoupled from the interactive
   path or set high enough that it never binds before the resource budget does.
   This keeps the "don't burn $1000" circuit breaker without tying it to step
   count.
2. **No-progress / loop detection as the real runaway killer.** What should stop
   a stuck run is *lack of progress* — repeated or near-identical tool calls,
   re-reading the same paths, repeated identical errors — not a step counter.
   The existing repeated-call guard must be hardened (it currently keys on full
   tool arguments, so a varied `offset`/`limit` slips past; it should key on the
   semantic target, e.g. `path`). This is what separates "killing a loop" from
   "interrupting long work".
3. **Graceful, resumable termination on any ceiling.** Reaching *any* limit
   should force one final wrap-up turn — emit the best-effort partial result and
   a checkpoint — rather than `this.fail()` discarding the work. Long tasks are
   naturally resumable (the model itself offered "tell me which file to continue
   from"), so the loop should checkpoint and allow continuation instead of
   crashing.

## Consequences

Positive:

- Auto-research and deep agent loops become possible without removing the cost
  circuit breaker — the breaker just moves to the axis (resources) that actually
  measures risk.
- Runaway loops are caught by progress detection, which does not misfire on
  legitimate long work.
- A run that hits its ceiling returns usable output plus a resume point instead
  of throwing away all completed work.
- Sub-agents keep their tight bounds; only the binding axis and the
  on-exhaustion behavior change.

Negative:

- Progress/loop detection is heuristic; a poorly tuned detector can either kill
  legitimate retries or let a slow loop run longer than a step cap would have.
  It needs its own tests and trace signals.
- "Graceful wrap-up" adds a final forced turn (one extra model call) on
  exhaustion, and a `complete: false` / `truncated: true` signal that downstream
  consumers (and the 37c5dc2a sub-agent caveat path) must learn to read.
- Resource budgets are less intuitive than "8 steps" for newcomers; defaults and
  docs must make the new bound legible.

## Alternatives considered

- **Just raise the `maxSteps` default.** Rejected: it trades one wrong number
  for another. A higher cap still cannot tell long work from a loop, and still
  hard-fails with total work loss when hit.
- **Remove the cap for the main agent entirely.** Rejected: even with a human
  present, a stuck loop burns tokens/cost before anyone reacts. A backstop must
  remain — it just should be resource-based, not step-based.
- **Keep step cap, only make the failure graceful.** A real improvement (and
  worth doing on its own), but insufficient: it stops the crash without enabling
  long-horizon work, which still needs the step ceiling to not bind.
- **Per-task model-chosen budgets.** Interesting but premature; depends on the
  resource-budget and progress-detection primitives landing first.

## Follow-Up

No code change is locked in by this ADR; it records the direction. The
incremental, already-landed step is surfacing `Step: N / M` to the model
(`runtime_progress` in `packages/core/src/context.ts`) so budget is at least
visible — necessary but, as run 3 showed, not sufficient on its own. Remaining
work, roughly in dependency order:

1. Harden the repeated-call / no-progress guard to key on the semantic target
   rather than exact arguments.
2. Convert `max_steps_exceeded` (and resource-budget exhaustion) from
   `this.fail()` into a forced graceful wrap-up that emits a partial result and
   a resume checkpoint.
3. Route the interactive/main agent through `RunBudget` as its binding limit and
   decouple or raise `maxSteps` so it is a backstop, not the task budget.

Related: `docs/AUTOMATION_AND_BACKGROUND_TASKS.md` (long-running and background
work), and the sub-agent completeness marker from the
`feat(runtime): flag final answers produced under an exhausted step budget`
change, whose `stepLimitReached` signal should extend to the
graceful-wrap-up/partial case.
