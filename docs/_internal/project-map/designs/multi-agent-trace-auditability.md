# Design: Multi-Agent Trace Auditability

## Status

Historical design/audit record. Foundation is implemented for sequencing steps
1-6. The TUI now consumes structured sub-agent facts for depth-aware lifecycle
rows, and `trace report` now scores the structured auditability facts added in
steps 1-5. The historical root-cause analysis below came from a multi-agent QA round
(`openai/gpt-5.4-mini`, fixture
`/tmp/sparkwright-agent-qa.beb1e4`). The verdict from QA: multi-agent traces are
_traceable_ but not yet _auditable_ — parent/child runs link up, but metadata,
completion semantics, write attribution, and views diverge by delegate kind and
entrypoint, so the trace cannot be the single source of truth.
Use the related module and map pages for current routing contracts; this page
preserves the design rationale and original problem analysis.

Current implementation status:

- Steps 1-3 landed: additive `subagent.*` lifecycle facts, terminal projections
  derived from child `run.*`, conditional delegate approval facts, effective
  profile tool-set alignment, and `maxDepth` parity for `delegates run`.
- Steps 4-5 landed: same-batch duplicate diagnostics split
  `in_flight_duplicate` from completed repeats, and read/write external command
  delegates emit an untracked write-capable boundary marker that is summarized
  separately from managed workspace writes.
- Step 4 has the bounded semantics from the follow-up regression fix: an
  in-flight skip does not pretend a result already returned and does not poison
  next-turn failure/no-op target memory, but same-turn duplicate fan-out still
  contributes to repeated-call / doom-loop counting.
- Step 6 landed for the scoped consumers: TUI sub-agent lifecycle rows read
  `subagentDepth`, ids, entrypoint/delegate metadata, and terminal facts; trace
  report scorers flag incomplete child runs, in-flight duplicate storms,
  repeated approval denials, and untracked write-capable external commands.

## Root Cause: One Missing Invariant + Two Boundary Problems

Most of the nine findings are not separate bugs. They are **one missing
architectural invariant**, plus **two genuine boundary problems** that the
invariant alone does not resolve.

### The missing invariant

> **Every effective fact about a multi-agent run must be derived once, from one
> source, and projected onto every event, view, and entrypoint — never
> independently recomputed or dual-encoded.**

Today the same logical fact has multiple independent sources that are allowed to
disagree:

| Fact                 | Source A                                      | Source B                                         | Diverge at                                                                                  |
| -------------------- | --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| sub-agent depth      | child run `metadata.subagentDepth` (computed) | `subagent.*` event meta (not copied)             | [agent-runtime/src/index.ts:731](../../../../packages/agent-runtime/src/index.ts)           |
| approval required    | descriptor `requiresApproval` (config)        | tool `risk: "risky"` (constant) → runtime gate   | [host/src/delegate-capability.ts:142](../../../../packages/host/src/delegate-capability.ts) |
| depth ceiling        | `capabilities.agents.maxDepth` (run path)     | not loaded (CLI `delegates run` path)            | [host/src/delegate-runner.ts:179](../../../../packages/host/src/delegate-runner.ts)         |
| child terminal state | child `run.completed` payload (rich)          | `subagent.completed` payload (only `stopReason`) | [agent-runtime/src/index.ts:753](../../../../packages/agent-runtime/src/index.ts)           |
| usable child tools   | effective policy (`read` only)                | prompt descriptors (`glob/list_dir/tool_search`) | [host/src/tool-selectors.ts](../../../../packages/host/src/tool-selectors.ts)               |
| duplicate tool call  | sequential `previousToolCall` (completed)     | no in-flight signal consulted                    | [core/src/run.ts:2346](../../../../packages/core/src/run.ts)                                |

This invariant covers findings #1, #2, #3, #4, #6, #7. The invariant is _self-
referential_: the fix must not, while collapsing one dual-encoding, create a new
one (see `terminalState` note in #1+#2 below).

### The two boundary problems

These are not "missing single source" — they are real edges the system cannot
fully observe, and must be designed for honestly rather than patched:

- **#5 — external-command direct writes.** An external process writes to the
  workspace cwd outside any managed write API. No fact projection makes those
  writes appear; the only honest options are pre/post snapshot (O(tree)) or an
  explicit _access-granted_ marker. We design the marker — it records that the
  process was granted unaudited direct write, not what it wrote.
- **#8 — TUI parent/child rendering.** Even with perfect structured facts, the
  TUI still has to _render_ a tree and lay out an approval overlay on a narrow
  screen. That is presentation work downstream of the facts, not a fact bug.

(#9 `trace report` is downstream diagnosis: it becomes _diagnosable_ once the
facts above are structured — that does not improve the report by itself; scorers
still have to be added to act on those facts.)

### Do not build a god object

The invariant is satisfied by **three distinct snapshots with different owners
and lifecycles**, not one `MultiAgentFacts` object that absorbs everything:

- `MultiAgentFacts` (agent-runtime, per spawn): parent/child run relationship
  and lifecycle — `parentRunId`, `childRunId`, `agentId`, `delegateTool`,
  `subagentDepth`, `entrypoint`, and, for real SparkWright child runs,
  derived `terminalState`.
- `EffectiveCapabilitySnapshot` (host, per run/inspect): approval requirement
  and effective tool set, shared by inspect / prompt descriptors / runtime
  policy.
- `ToolExecutionDiagnostics` (core, per batch): duplicate-call kind
  (`in_flight_duplicate` vs `completed_duplicate`) and doom-loop accounting.

## Per-Finding Root Cause

### 1 + 2 — `subagentDepth` missing; `subagent.completed` too coarse

Same function, [`spawnSubAgent`](../../../../packages/agent-runtime/src/index.ts).
Depth is computed at index.ts:652 and written into the child run's `metadata`,
but `subagentMeta` (index.ts:731) only carries `agentProfileId` + `agentName`.
The external-command path emits its own meta with `subagentDepth` inline
([external-command-agent.ts:216](../../../../packages/host/src/external-command-agent.ts)),
which is why external `subagent.*` has depth and the in-process /
`spawn_agent` path does not. Both configured delegates and dynamic
`spawn_agent` route through `spawnSubAgent`, so both lose it.

The same emit site drops terminal richness: `subagent.completed` projects only
`stopReason` (+ `workspaceWrites`) from the child `run.completed`
(index.ts:753). The child's `stepLimitReached` / `truncated` are present in the
child payload but never projected, so a truncated child reads as a clean
success.

Root cause: the parent-facing event meta is a hand-curated subset of the child
fact model rather than a projection of it.

Direction (user-chosen shape: add fields to existing events): build the
`MultiAgentFacts` snapshot once in `spawnSubAgent`
(`parentRunId`, `childRunId`, `agentId`, `delegateTool`, `subagentDepth`,
`entrypoint`) and have all three lifecycle paths (`spawnSubAgent`,
`external-command-agent`, `acp-child-agent`) project those lifecycle facts. On
terminal events from real SparkWright child runs add `subagentDepth` plus
structured terminal fields:
`stepLimitReached`, `truncated`, and a `terminalState`
(`completed | failed | cancelled | blocked | step_limit | truncated`),
alongside the existing `stopReason` for back-compat. The protocol event schema
gains optional fields only — no envelope change.

**Self-referential constraint (do not re-create a dual-encoding):**
`terminalState` must be **derived** from the child's actual `run.*` outcome plus
its `stepLimitReached` / `truncated` flags — never set independently by the
parent emit site. The child run is the single source; `subagent.*` is a
projection of it. Setting `terminalState` by hand on the parent side would, while
fixing #2, manufacture a fresh copy that can disagree with the child — exactly
the defect this design exists to remove.

Resolved map debt: [maps/capabilities/agents.md](../maps/capabilities/agents.md)
now carries the current `subagentDepth` lifecycle contract after the
implementation landed.

### 3 — in-flight duplicate mislabeled as a completed-cached duplicate

The repeat guard in [core/src/run.ts](../../../../packages/core/src/run.ts) keys
off `state.previousToolCall` (run.ts:2346) — a _sequential_ notion of "the last
call I processed". Within one concurrent batch, two identical delegate calls are
processed back-to-back before the first resolves, so the second is skipped with
the message "already called with identical arguments and returned the same
result" (run.ts:2545) even though the first is still in flight and has returned
nothing. The duplicate can then count toward `TOOL_DOOM_LOOP` (run.ts:2412).

Root cause: the duplicate detector has no concept of _outstanding_ calls; it
conflates "I already finished this" with "one identical to this is running".
Note the concurrency layer already tracks in-flight work
([core/src/tool-orchestration.ts:112](../../../../packages/core/src/tool-orchestration.ts))
and writes-claims ([agent-runtime concurrency coordinator](../../../../packages/agent-runtime/src/concurrency/coordinator.ts)),
so the in-flight signal exists — it just isn't consulted by the repeat guard.

Direction: distinguish `in_flight_duplicate` from `completed_duplicate`. An
in-flight duplicate should get an accurate message ("an identical call is still
running; wait for its result") and should not be remembered as a failed/no-op
target for the next turn, since the first result is still pending. However,
same-turn duplicate fan-out is still a real repeated-call signal: a model that
emits many identical calls in one batch should still trip the repeated-call /
doom-loop guard. The bounded rule is "fix the diagnostic and next-turn
bookkeeping, do not zero out same-batch multiplicity."

### 4 — `inspect` approval ≠ runtime approval

Resolved: delegate capability descriptors no longer echo configured
`requiresApproval`. Host derives required `approvalRequiredUnderCurrentRun`
plus `approvalReasons` and `approvalRunOptions` from the same policy profile
used for execution, while `gatedByRunWrite` remains a separate authority fact.
CLI and TUI render that scoped snapshot directly.

### 5 — external-command direct writes invisible to `workspace.write.*`

With `workspaceAccess: read_write` + `--write`, an external command writes
straight to the workspace cwd. In-process delegate writes are rolled up from the
child's own `workspace.write.completed` events
([agent-runtime/src/index.ts:744](../../../../packages/agent-runtime/src/index.ts)),
but an external process has no managed write API to emit those events, so the
summary shows `workspace writes = 0` while files changed on disk. The
[workspace-writes.md](../maps/safety/workspace-writes.md) Known Debt already
flags this gap.

Root cause: managed write events are the only audit signal, and an external
process is structurally outside the managed write path.

Direction (user-chosen: trace marker for untracked access): when an external
command runs with `read_write`, emit an explicit marker recording that the
process was **granted direct, per-file-unauditable write access** to the
workspace cwd. The marker asserts _access granted / untracked-write-capable_ —
it does **not** claim a write happened or name any file, because without a
pre/post snapshot or process instrumentation the trace genuinely cannot know
that. This keeps the trace honest about the boundary at O(1) cost, rather than
reconstructing writes with an O(tree) snapshot diff. The summary then reports
"managed writes" separately from "untracked write-capable external process",
and never folds the latter into a write count it cannot substantiate.

### 6 — `delegates run` bypasses `maxDepth`

[delegate-runner.ts](../../../../packages/host/src/delegate-runner.ts) loads the
config (line 87) but never reads `capabilities.agents.maxDepth`. It constructs
the delegate tool factories (delegate-runner.ts:179-207) without `maxDepth`, so
`input.maxDepth` is `undefined`, and the ceiling check is gated
`if (input.maxDepth !== undefined)`
([delegate-capability.ts:105](../../../../packages/host/src/delegate-capability.ts)).
Result: `maxDepth=0` blocks configured delegates and `spawn_agent` in the run
loop (runtime.ts threads `agentConfig?.maxDepth`), but the CLI `delegates run`
entrypoint runs the same delegate at depth 1 unchecked.

Root cause: policy is loaded per-entrypoint, and one entrypoint forgot to thread
a field. This is the entrypoint-consistency hazard already noted in memory
([[project_entrypoint_consistency]]).

Direction: `delegates run` must build its delegate tools from the same effective
agent policy snapshot the runtime uses, including `maxDepth`. The fix is
**entrypoint parity, not new semantics** — every entrypoint loads the one
effective policy and reads `maxDepth` from it.

Explicitly **keep** the existing meaning of `undefined`: "no ceiling configured",
not an implicit "deny beyond depth 0". Changing the default-deny semantics would
regress every user who runs without a configured `maxDepth` today. The bug is a
missing load in one entrypoint, so the fix lives at the load site, not in the
ceiling check.

### 7 — prompt descriptors expose policy-denied tools

The child's effective policy allows `read` only, but the prompt descriptors
still advertise `glob/list_dir/tool_search`; the model calls `tool_search` and
the runtime rejects it with `TOOL_DENIED`. Descriptors and effective policy are
computed on separate paths in
[tool-selectors.ts](../../../../packages/host/src/tool-selectors.ts).

Root cause: the prompt's tool list and the runtime's allow-list are not the same
projection of one effective capability snapshot — the same class of bug as #4
and #6, on the tool axis.

Direction: derive prompt descriptors from the post-intersection effective tool
set, so the model never sees a tool it cannot call.

### 8 — TUI parent/child layering

[event-stream.tsx](../../../../packages/tui/src/components/event-stream.tsx)
renders by concatenating event rows; it has no structured parent/child tree, so
subagent rows overlap the approval panel and a cancel/deny shows "delegate
failed" and "subagent completed" together with no hierarchy.

Root cause: the TUI is an event-row stream, not a renderer of a structured
multi-agent state. This is _downstream_ of the trace fix — once `subagent.*`
carries `subagentDepth` + `terminalState` (#1/#2), the TUI can render a real
tree keyed on depth and child id.

Direction: render from a derived parent/child state model keyed on
`parentRunId`/`childRunId`/`subagentDepth`, not from row concatenation. Sequence
after #1/#2.

### 9 — `trace report` under-flags

Repeated delegates, repeated denied approvals, and step-limit partial results
all leave evidence in the trace, but
[run-outcome.ts](../../../../packages/cli/src/run-outcome.ts) surfaces
lower-priority items (e.g. cost unavailable) rather than these anomalies.

Root cause: collection outruns diagnosis — the anomalies aren't first-class
because the facts they depend on (terminal state, duplicate kind, untracked
writes) aren't in the trace yet. Also _downstream_ of steps 1-5.

Direction: `trace report` becomes _diagnosable_ once structured facts exist —
but it does not improve on its own, so scorers still have to be added. After
#2/#3/#5 land the structured terminal state, duplicate kind, and untracked-write
markers, add scorers that flag `step_limit`/`truncated` children,
`in_flight_duplicate` storms, repeated denied approvals, and untracked external
writes as high-value findings.

## Three Snapshots (design target)

Not one god object — three snapshots, each derived once at its own boundary and
projected onto every consumer that needs it.

### `MultiAgentFacts` — agent-runtime, per child spawn

- `parentRunId`, `childRunId`, `agentId`, `delegateTool`, `subagentDepth`,
  `entrypoint` (`run` | `spawn_agent` | `delegate` | `delegates_run` | `acp` |
  `external_command`).
- Terminal fields on real SparkWright child-run `subagent.*`:
  `stepLimitReached`, `truncated`, and a `terminalState` (`completed | failed |
cancelled | blocked | step_limit | truncated`) — **derived from the child
  `run.*` outcome**, additive, `stopReason` kept for back-compat.

### `EffectiveCapabilitySnapshot` — host, per run / inspect

- conditional approval facts derived once from the runtime gate
  (`approvalRequiredUnderCurrentRun`, `approvalReasons`, `gatedByRunWrite`),
  shared by descriptor / inspect / prompt / runtime. Inspect shows which run
  options the result was computed under rather than promising an unconditional
  boolean it cannot fully know.
- effective tool set computed once (post-intersection); prompt descriptors and
  runtime allow-list read the same set.

### `ToolExecutionDiagnostics` — core, per batch

- duplicate-call kind: `in_flight_duplicate` (an identical call is still running
  — accurate message, not a completed-result repeat) vs `completed_duplicate`
  (already returned — current behavior).
- doom-loop accounting still sees same-batch multiplicity; in-flight skips only
  avoid completed-result wording and next-turn failure/no-op target pollution.

### Boundary markers (not a snapshot)

- external-process write access: an explicit _access-granted /
  untracked-write-capable_ marker emitted when managed write events cannot exist
  (#5). Records the boundary, not the writes.

## Sequencing

Ordered so the fact producers land before the views that consume them. Steps 1-3
fix the missing invariant; 4-5 add the diagnostics and boundary marker; 6 is
views, which only consume.

1. **Sub-agent lifecycle schema** (#1, #2): additive `subagent.*` fields —
   `subagentDepth`, `agentId`, `entrypoint`, `terminalState`, `stepLimitReached`,
   `truncated`, consistent `childRunId`. `terminalState` derived from the child,
   not set independently.
2. **Effective capability snapshot** (#4, #7): one source for approval + tools
   across inspect / prompt descriptors / runtime policy.
3. **Entrypoint parity** (#6): `run`, `spawn_agent`, configured delegate,
   external/acp, and `delegates run` all read `maxDepth` from the same loaded
   policy. `undefined` keeps its current "no ceiling configured" meaning.
4. **Execution diagnostics** (#3): split duplicate into
   `in_flight_duplicate` / `completed_duplicate`; in-flight skips keep accurate
   wording and avoid next-turn failed/no-op target memory while same-batch
   multiplicity still feeds the repeated-call / doom-loop guard.
5. **External command audit boundary** (#5): untracked write-access marker;
   summary separates managed writes from untracked write-capable processes.
6. **Views** (#8 TUI tree, #9 `trace report` scorers): consume the structured
   facts from steps 1-5; render and flag, never re-derive.

## Owners

- agent-runtime: subagent lifecycle facts, terminal-state projection (#1, #2).
- core/protocol: event schema additive fields, duplicate-kind handling (#2, #3).
- host: capability snapshot unification, external-command write marker,
  delegate-runner policy loading (#4, #5, #6, #7).
- CLI: `delegates run` policy, `trace report` scorers (#6, #9).
- TUI: structured multi-agent render, approval overlay (#8).

## Related Map Pages

- [maps/capabilities/agents.md](../maps/capabilities/agents.md) —
  sub-agent lifecycle and depth-budget contracts.
- [maps/trace/raw-trace.md](../maps/trace/raw-trace.md) — event additive fields.
- [maps/safety/workspace-writes.md](../maps/safety/workspace-writes.md) — Known
  Debt resolved by #5 marker.
- [maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md) —
  duplicate handling (#3), effective tool set (#7).

## Last Verified

- Status: Read-only
- Date: 2026-06-20
- Read: `packages/agent-runtime/src/index.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/host/src/external-command-agent.ts`, `packages/core/src/run.ts`,
  `packages/core/src/trace.ts`, `packages/core/src/events.ts`,
  `packages/protocol/src/index.ts`, `packages/cli/src/cli.ts`,
  `packages/host/src/tool-selectors.ts` (header),
  `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/test/event-stream-render.test.ts`,
  `packages/core/test/trace.test.ts`, `schemas/event.schema.json`.
- Tests: not run; cleanup-only map audit.
