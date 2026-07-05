# Background Task Lifecycle Redesign Proposal

Status: Draft — revised after review round 2
Date: 2026-07-01
Branch context: `feat/background-agent-jobs`

> Internal planning document. It does not change runtime behavior by itself.
> It defines one lifecycle primitive for long-running tool calls (shell / task /
> sub-agent) and the foreground↔background↔promotion model, plus the
> notification-driven revival loop that lets a completed background task wake the
> main agent.

## Purpose

Today three long-running surfaces each implement a *different subset* of the
same lifecycle:

- **shell** has all three states: foreground (blocking), promote-on-timeout
  (detach + ticket), and detached background.
- **task** has only background: `task_create` spawns and returns `{ taskId }`
  immediately; there is no foreground/join and no promotion.
- **sub-agent** has foreground (inline `spawn_agent`, runs to completion inside
  the parent turn) plus a separate `kind:"agent"` background entrypoint, but no
  in-flight promotion.

And the revival half is unbuilt: `TaskManager` can emit notifications and a
`TaskNotificationSink` interface exists, but the host constructs `TaskManager`
with only a `FileTaskStore` — no sink — so a completed background task cannot
wake the main agent. There is no consumer in the run loop.

The target is **one lifecycle primitive** applied uniformly:

```
                 (auto: foreground budget overrun)
                 (manual: user out-of-band signal)
  ┌───────────┐         promote          ┌────────────┐
  │ FOREGROUND│ ───────────────────────► │ BACKGROUND │
  │  (block/  │                          │ (detached, │
  │   join)   │                          │  notify on │
  └─────┬─────┘                          │   finish)  │
        │ completes within budget        └─────┬──────┘
        │                                       │ terminal
        ▼                                       ▼
   result inline                    notification → revive main agent
                                    (waiting_tasks → resume turn)
```

## Current Facts

Read before reviewing:

- [`packages/agent-runtime/src/tasks/manager.ts`](../../../packages/agent-runtime/src/tasks/manager.ts)
  — `spawn()` fires `execute()` un-awaited (L185);
  `transitionTerminal()` calls `notify()` after the terminal store update
  (L352); `notify()` returns early when no sink is provided (L356-L360).
- [`packages/agent-runtime/src/tasks/tools.ts`](../../../packages/agent-runtime/src/tasks/tools.ts)
  — `task_create.execute` returns `{ taskId }` right after `spawn` (L116).
- [`packages/agent-runtime/src/tasks/types.ts`](../../../packages/agent-runtime/src/tasks/types.ts)
  — `TaskHandle.wait()/cancel()/output()` (L124): the join primitive already exists.
- [`packages/agent-runtime/src/tasks/notifications.ts`](../../../packages/agent-runtime/src/tasks/notifications.ts)
  — `TaskNotificationSink`; current
  `InMemoryTaskNotificationQueue.waitForNext(): Promise<TaskNotification[]>`
  (L136) **consumes** notifications via `drainAll()` (L138; also delivery to a
  waiter at L118-L119) and has no `AbortSignal`. P0 must not use this consuming
  method as the revival wait primitive; it needs a non-consuming, abortable
  "ready" wait and a single later `drain()` consumer.
- [`packages/agent-runtime/src/tasks/file-notifications.ts`](../../../packages/agent-runtime/src/tasks/file-notifications.ts)
  — `FileTaskNotificationOutbox` (durable sink, L48), also un-wired.
- [`packages/shell-tool/src/tool.ts`](../../../packages/shell-tool/src/tool.ts)
  — timeout → `onPromote` → detach → returns `{ exitCode: null, promoted }` (L687). The reference promotion path.
- [`packages/host/src/runtime.ts`](../../../packages/host/src/runtime.ts)
  — `new TaskManager({ store: FileTaskStore })` with no sink (L779);
  `runHostAgentTask` drives a read-only child, `controller.signal` → child (L701/L731).
- [`packages/host/src/tool-catalog.ts`](../../../packages/host/src/tool-catalog.ts)
  — dynamic child toolset `allowedTools` enum hard-limited to
  `read/glob/grep/list_dir` (L73): sub-agents cannot create tasks.
- [`packages/core/src/run.ts`](../../../packages/core/src/run.ts)
  — `while (state.step <= this.maxSteps)` loop; `waiting_credentials` is the
  existing **non-terminal suspend/resume precedent** (L323) to mirror for
  `waiting_tasks`.
- [`packages/core/src/run.ts`](../../../packages/core/src/run.ts)
  — `enqueueCommand()` only queues user/cancel commands (L2198) and
  emits `run.command.enqueued` (L2200); `consumePendingCommands()` applies them
  at a loop boundary (L2227). There is no current promise/waiter over
  `commandQueue.length`. A `waiting_tasks` block must therefore derive
  `commandReady` from the `run.command.enqueued` event and reuse the existing
  run `abortSignal`; do not busy-poll the queue.
- TUI already surfaces tasks:
  [`packages/tui/src/lib/task-activity.ts`](../../../packages/tui/src/lib/task-activity.ts),
  [`packages/tui/src/components/activity-panel.tsx`](../../../packages/tui/src/components/activity-panel.tsx).
- **An out-of-band notification contract already exists — but in the wrong package.**
  [`packages/streaming-runtime/src/index.ts`](../../../packages/streaming-runtime/src/index.ts)
  defines `NotificationSource.drain()` + `PendingNotification` (L86/L64),
  drains them at every step start (L443), and emits `run.notification.injected`
  (L1194). Its own doc comment names the intended implementation: *"a
  TaskManager's `InMemoryTaskNotificationQueue.drain()` mapped to
  PendingNotification."* Do **not** reinvent a "synthetic turn."
- **Two loops, and the notification contract is on the one the host does not
  use.** The host drives runs via **`core.createRun()`**
  ([runtime.ts:1888/2085](../../../packages/host/src/runtime.ts)), *not*
  `streaming-runtime`'s `createStreamingRun`. So `NotificationSource` is
  unreachable from the host's run today. This is the single most consequential
  fact for P0 (see Consolidation §A).
- `RunResult.state` is `Extract<RunState, "completed"|"failed"|"cancelled">`
  ([types.ts:85](../../../packages/core/src/types.ts)) — strictly terminal — and
  `start()` unconditionally `safeStoreFinish`es after `runLoop()` returns
  ([run.ts:911](../../../packages/core/src/run.ts)). A suspend state cannot be a
  `RunResult` signal; it must be an **internal block inside `runLoop()`**.
- The host has a supervisor layer, `startSupervisedRunChain`
  ([runtime.ts:1611](../../../packages/host/src/runtime.ts)), managing todo
  continuation, active run, and terminal events — revival must **not** be
  mistaken for a new supervisor continuation run (see §4).
- `maxToolConcurrency` governs only the **same-turn tool batch**
  ([streaming-runtime L115](../../../packages/streaming-runtime/src/index.ts)),
  not detached tasks — a separate cap is required (see §7).

## Design

### 1. The three states, precisely

Every long-running tool call (shell, `task_create`, `spawn_agent`) is one of:

- **Foreground** — the tool call *blocks the run loop* (`await handle.wait()`).
  Equivalent to a join. This is **not new machinery**: the agent loop already
  blocks on tool execution. A foreground task just awaits the terminal record
  before returning the result inline.
- **Promoted** — the foreground call exceeded its budget (or was kicked
  out-of-band). The runtime **detaches** the live work into the `TaskManager`,
  stops blocking, and returns a **ticket** `{ promoted: true, taskId }` instead
  of the result. Mirrors shell exactly.
- **Background** — created detached from the start (`background: true` or the
  model's explicit choice). Returns `{ taskId }` immediately; the loop continues.

Promoted and background converge onto the *same* detached lifecycle; the only
difference is whether a foreground attempt preceded it.

### 2. Promotion trigger matrix — who can promote, and when

A foreground call is a **frozen turn**: the model has no turn to act during a
blocking join. Therefore only two actors can promote it:

| Trigger | Actor | Mechanism |
|---|---|---|
| **Auto** | foreground budget timer | budget overrun fires `onPromote` (shell's pattern), detach + ticket |
| **Manual** | **user, out-of-band** (TUI keybind) | host `task.promote` control calls `TaskManager.requestPromotion()`, which interrupts the in-flight foreground wait and returns the same promoted ticket |

There is **no "model manually promotes a blocking task"** — it cannot; it is
frozen. If the model wants the option to change its mind, it must create the
task as **background** up front (then poll or get revived). This is a hard
constraint, not a nicety: foreground ⇒ only timeout/human can intervene.

### 3. Default foreground, auto-promote on overrun

Do **not** force the model to predict duration. The recommended default:

> **Start foreground. Auto-promote only on budget overrun.**

Consequences:
- Fast tasks never pay background overhead (no record churn, no full revival
  turn's tokens). They finish inline.
- Slow tasks never block forever — they auto-detach at the budget.
- The fg/bg decision is *partly deferred and automatic*, reducing the burden on
  the model.

The model should only explicitly choose **background at creation** when it knows
the work is long **and** it does not need the result to proceed on the next turn
(independent fan-out). The tool contract must state exactly this.

### 4. Notification-driven revival (the missing half) — two orthogonal mechanisms

Revival is **two separate problems**; the codebase already solves one.

**(a) How a completion enters model context — reuse `NotificationSource`, do
not reinvent.** The `NotificationSource.drain()` / `PendingNotification` /
`run.notification.injected` contract already exists. The bridge is a projection:

```
task terminal → TaskManager enqueues → TaskManager exposes a NotificationSource
  → runLoop drains it at step start → user-role "working" context item
  → run.notification.injected (one canonical trace event, auditable)
```

The notification carries `taskId + title + result/err summary` (§7 correlation)
so multiple completions are self-identifying. **Single-consumer rule:** the
step-start `NotificationSource.drain()` is the only place that consumes queued
notifications for model context. Idle waiting must only observe readiness.

**(b) When the loop suspends instead of terminating — genuinely new, and
orthogonal to (a).** `drainNotificationSources` only runs *at the start of a
step the loop was already going to take*. It cannot rescue an idle loop: if the
model emits no tool calls, `runLoop()` returns and `start()` finalizes the run —
drain never fires again. So a `waiting_tasks` suspend is still required:

- On model completion, **before terminating**, check "are there **awaited**
  non-terminal tasks?" (§5). If yes, **block *inside* `runLoop()`** on a
  non-consuming, abortable notification-ready primitive (for example
  `waitUntilAvailable({ signal })`, not today's consuming `waitForNext()`).
- That block must race **task-ready / command-ready / abort**. `taskReady` is
  the non-consuming task-notification readiness primitive; `commandReady` is
  derived from a one-shot subscription to `run.command.enqueued` (the current
  command queue only has push + event emission, no awaitable primitive); and
  `abort` reuses the run's existing `abortSignal`. If a user message or cancel
  arrives while the run is waiting on tasks, the loop wakes and lets the
  existing command phase apply it. If abort wins, no notification should have
  been consumed.
- After any wake, loop again; the next step-start uses (a) to drain all queued
  notifications into context. This preserves one canonical injection path and
  avoids "wait consumed it, drain saw empty" lost-revival bugs.
- This is an **internal block**, not a new `RunResult` signal — forced by
  `RunResult` being terminal-only and `start()` finalizing unconditionally
  (Current Facts). It touches only `runLoop()`, not protocol/store semantics.
- It wakes the **same core run's next turn**. It is explicitly **not** a new
  `startSupervisedRunChain` continuation run — the host supervisor stays out of
  the revival path.

Wake path (fully decoupled — the child never touches the parent loop):

```
child/task terminal → runner resolves → TaskManager.transitionTerminal
  → enqueue + (a) NotificationSource has it + (b) ready waiter resolves
  → runLoop unblocks → next step drains notification into context → model continues
```

Wiring gap to close: the host builds `TaskManager` with only a store, no sink
([runtime.ts:779](../../../packages/host/src/runtime.ts)); and the sink/source
contract must be reachable from `core.createRun` (Consolidation §A). The queue
API also needs the non-consuming ready wait described above.

### 5. Awaited vs detached background — the termination judge

Not every background task should keep the session alive. Distinguish:

- **Awaited background** — the model (or a promotion) wants the result. Keeps the
  loop alive; drives `waiting_tasks`.
- **Detached background** — fire-and-forget. Notify if a sink is present, but do
  **not** block session end.

Rule: **the loop suspends in `waiting_tasks` only while ≥1 *awaited* non-terminal
task exists.** A task carries first-class awaited intent on `TaskRecord` and the
protocol snapshot/schema (do **not** hide this in `metadata`):
- promotion sets `awaited = true` (the model was mid-join; it wants the answer);
- explicit background creation lets the model choose (`awaited` default `true`,
  opt out with `awaited = false` for true fire-and-forget).

This is what prevents both failure modes: fire-and-forget hanging the session,
and serial-dependency tasks never being revived.

### 6. The fg/bg switch, split into two things

"User might want to suspend the main agent" is really two separate controls —
do not build one fuzzy toggle:

1. **Session-level policy** — "this session: everything foreground / disable
   background." Belongs on the **access-mode governance clamp** (the existing
   project>user precedent), as a capability bit.
2. **On-demand join** — a background task is already running and the user wants
   to wait for it now → reverse-join a specific `taskId` (suspend main agent
   until that task completes). A TUI interaction, not a global switch. Host
   control uses `task.join` to set `awaited=true`; it is not model-facing
   `task(...)` JSON.

(Pausing the whole loop is a *third*, unrelated feature — out of scope here.)

### 7. Multiple background tasks — management

The in-memory notification queue shape already supports fan-out: it buffers
notifications and `drain()` can return several completions in one batch, so N
completions during one idle window arrive in **one** wake — the model is not
revived N times. Do not confuse this with `TaskManager.notificationOutbox`,
which is only the retry outbox for sink-delivery failures. What is still needed:

- **Concurrency cap / semaphore**. Especially `kind:"agent"` tasks: each spawns
  a child run = real model calls. Unbounded fan-out is already possible today;
  revival makes wake->spawn->wake recursion more useful, but it does not create
  the original fan-out surface. Put at least the cheap `agent = 1` hard guard in
  P0, then generalize global/per-kind caps as needed.
- **join-any vs join-all barrier**. If the model opened N tasks and needs *all*
  of them, let it declare a barrier ("wake me when `[ids]` are all terminal") so
  it gets **one** revival, not N. Without this each revival costs a full model
  turn.
- **Correlation metadata**. Every notification must carry `taskId + title +
  result/err summary` so the model can tell *which* of many finished (and which
  failed). Partial failures notify with the error; the model decides.
- **Retention / GC**. Completed records accumulate in `FileTaskStore`; define a
  retention window.
- **Orphan policy on session end** — see §8.

### 8. Sub-agents specifically

Three separable questions, distinct answers:

1. **Launch a sub-agent as a background task** — *already works*
   (`task_create(kind:"agent")`, `task_stop` cancels via `controller.signal`).
2. **Promote a running inline sub-agent to background** — *not wired; feasible
   but not as simple as "wrap the child promise as a task."* The child run is
   abortable with its own run store, but an inline sub-agent also carries a
   **parent-visible contract**: `subagent.*` events, usage rollup into the
   parent, runStore, finality/terminal projection, and the delegation ledger.
   Promotion must **preserve that projection** — the promoted child must keep
   attributing trace + usage back to the parent and still deliver a terminal
   projection on completion. A naive handoff drops half the child out of
   diagnostics and usage. So promotion is not `TaskManager.spawn(childPromise)`;
   it is *"detach execution, retain parent projection"* — which is exactly why
   promotion should be **one shared primitive** (Consolidation §B), not
   reimplemented per surface.
3. **Let a sub-agent itself create background tasks (nesting)** — *keep gated*.
   Currently denied (read-only child toolset). Nesting risks unbounded revival
   recursion. Make it opt-in and depth-bounded, decided separately from 1/2.

### 9. Entrypoint fork — CLI one-shot vs TUI long-lived

The core loop only exposes a **suspend point**; each entrypoint chooses policy:

- **TUI** (long-lived, user present): revival is natural. Notifications queue as
  turns; must not clobber in-progress user input.
- **`sparkwright run` (one-shot)**: the process expects to exit at run end. Two
  options exist in principle, but only one belongs in v1:
  - v1: block the process until awaited tasks drain;
  - deferred: exit and rely on durable `FileTaskStore` +
    `FileTaskNotificationOutbox`, so a later `resume` replays notifications and
    continues. This requires durable waiting-state / checkpoint reconstruction
    and is **not** part of v1.

Recommendation: core stays entrypoint-neutral (exposes the suspend point +
durable stores); CLI v1 blocks until awaited tasks drain; TUI uses live revival.
CLI `--detach` is deferred until the durable waiting-state design exists.

## Resolved Decisions (v1)

1. **Concurrency cap** — at minimum `agent = 1` lands in P0 as a cheap cost
   guard; broader default `global = 4` / per-kind caps may land with P1 if P0
   only scopes the agent guard. Over the cap, v1 **rejects with a recoverable
   tool error** (model can retry or wait) — no queue in v1. `agent = 1` because
   each agent task is real model spend.
2. **CLI orphan policy** — v1 default and only supported behavior is
   **block-until-awaited-drain**. `--detach` / exit + durable outbox + `resume`
   is deferred until durable waiting-state checkpoint semantics are designed.
3. **Nesting** — **forbidden in v1.** The read-only child catalog stays without
   `task_create`; lifecycle stays flat. Revisit post-v1 (depth-bounded, opt-in).
4. **Revival budget** — revival turns count against a **separate
   `maxRevivalTurns`** (default 5), **not** `maxSteps`. Prevents a
   long-running task's completion from being step-budget-killed, and bounds
   wake→spawn→wake recursion. The loop step still increments monotonically for
   checkpoint/event/doom-loop accounting, but a budgeted `waiting_tasks` revival
   turn is allowed to enter the loop even when `step > maxSteps`; total work is
   bounded by `maxSteps + maxRevivalTurns`.
5. **Barrier surface** — extend **`task(action:"wait", ids, mode:"any"|"all")`**;
   **no** new `task_join` tool. Reuses the existing host/protocol/TUI task
   inspection surface.

## Phased Plan (revised after review)

- **P0 — revival spine (five parts, all required).**
  1. **Contract home**: make `NotificationSource`/`PendingNotification`
     reachable from `core.createRun` — lift the contract into core/shared
     (Consolidation §A); expose the host `TaskManager` as a source (map
     `InMemoryTaskNotificationQueue.drain()` → `PendingNotification`) and wire it
     into `createRun`.
  2. **Injection**: completions project through the existing
     `run.notification.injected` path — no new "synthetic turn" event (§4a).
  3. **Ready wait primitive**: add/replace the queue wait with a
     non-consuming, abortable readiness primitive. The only consumer is
     step-start `NotificationSource.drain()`.
  4. **Suspend semantics**: `waiting_tasks` as an **internal block inside
     `runLoop()`** on `race(taskReady, commandReady, abort)`, gated on
     *awaited* non-terminal tasks (§4b, §5). `commandReady` comes from
     `run.command.enqueued`, not polling `commandQueue.length`; `abort` uses the
     existing run `abortSignal`. Define its checkpoint/resume rule for v1 as
     "not terminal and not detachable"; `start()` must not finalize while
     awaited tasks are pending. Wakes the same core run — not a supervisor
     continuation run (§3, §4b).
  5. **Awaited contract**: add first-class `TaskRecord.awaited` (plus store,
     protocol snapshot/schema, host/TUI projections). P0 needs this to judge
     `waiting_tasks` without metadata heuristics.
  *(Delivers: today's background tasks can correctly wake the agent — and be
  audited via one canonical event.)*
- **P1 — foreground task + promotion + general cap.** `task_create` gains
  foreground/`awaited` mode (`await handle.wait()`); foreground budget +
  `onPromote` returning a ticket ("default foreground, auto-promote"); complete
  the global/per-kind concurrency cap if P0 shipped only the `agent = 1` guard.
  `mode` is the preferred field; if an explicit `mode` and `awaited` flag
  conflict, reject with a recoverable argument error.
- **P2 — multi-task management.** `task(action:"wait", ids, mode)` barrier;
  correlation metadata in notifications; retention/GC; TUI activity-panel wiring
  for the new states + on-demand join / manual-promote keybind.
- **P3 — sub-agent promotion (projection-preserving).** Inline `spawn_agent`
  foreground budget + promotion through the **shared promotion primitive**
  (§8.2, Consolidation §B), retaining `subagent.*` / usage rollup / finality /
  ledger attribution.
- **P4 — governance.** Session-level fg/bg policy on the access-mode clamp
  (Consolidation §D).
- **P4+ — durable detach/resume.** CLI `--detach` and resume-driven awaited task
  revival require durable waiting-state / checkpoint reconstruction. The
  implemented foothold is narrower: terminal task notifications are durable and
  can be replayed on `resume`; pending/running in-process task records are
  treated as orphaned and failed explicitly.
- **P5 (deferred) — nesting.** Depth-bounded sub-agent→background, opt-in.

### P4+ Implementation TODO

Current implementation deliberately keeps `waiting_tasks` as a live in-process
run-loop state and marks checkpoints that stop there as not fully resumable.
Host task notifications now use a durable `FileTaskNotificationOutbox` as the
drain source, so terminal task notifications can be replayed into the same run
on `resume`. In-process tasks themselves do **not** survive host exit: when
`resume` sees this run's pending/running task records without a live runner in
the reopened host, it fails them with an explicit orphan error instead of
waiting forever.

CLI `--detach` remains deferred until there is a first-class suspended outcome
outside `RunResult` plus durable waiting-state/checkpoint reconstruction. A
valid detach may only exit after awaited in-process tasks are terminal, or hand
execution to an explicit external worker; cross-process task execution is a
non-goal for this proposal. Barrier recovery must persist the wait intent
(`ids + mode`) and notification injection must record injected ids/cursors in
the same durable step as context/checkpoint mutation to avoid duplicates after a
crash.

### Implementation Notes

The live revival spine now has an independent `maxRevivalTurns` budget (default
5), so awaited task completions can be injected after `maxSteps` is otherwise
spent without falling into step-budget wrap-up. The `waiting_tasks` race uses one
per-wait abort signal for task readiness, command readiness, and abort cleanup;
run aborts cascade into that signal. Host notification delivery drains all
terminal task notifications for the run, including detached tasks; only awaited
tasks participate in keep-alive/revival.

## Consolidation & Governance (reduce surface, not add it)

The point of this proposal is that these features are *one primitive seen from
three angles*. Concrete merges to enforce that, each cutting future maintenance:

- **§A — One notification contract, one home.** `NotificationSource` /
  `PendingNotification` / `run.notification.injected` must not stay
  streaming-runtime-only while the host runs on `core.createRun`. Lift the
  contract to core (or a shared package) so **both** loops consume the *same*
  injection path. This is what prevents the next feature from reinventing
  "synthetic turns." (Open question, flagged not solved: the two run loops
  themselves are a latent convergence target — the notification contract should
  not wait on that larger merge.)
- **§B — One promotion primitive.** shell, task, and sub-agent promotion are the
  same operation: *detach live execution, hand lifecycle to `TaskManager`,
  return a ticket, preserve the parent-visible projection (trace/usage/terminal)*.
  Factor a single `promoteToTask(handle, projection)` helper; shell migrates onto
  it, task and sub-agent adopt it. Three call sites, one contract — avoids the
  "promoted sub-agent drops out of diagnostics" failure (§8.2).
- **§C — One task tool surface.** No `task_join`; barrier rides `task(action:
  "wait")`. New capabilities extend the existing verb set rather than adding
  sibling tools (keeps host/protocol/TUI inspection unified).
- **§D — One `awaited` flag, three consumers.** The record's awaited/detached
  intent drives *loop-suspend* (§4b), *CLI orphan policy* (§9), and
  *barrier/revival accounting* from a single field — not three ad-hoc
  predicates. Promotion sets it `true`; explicit background lets the model opt
  out. Terminal notifications may still be emitted for detached tasks; `awaited`
  decides whether they keep the run alive.
- **§E — One notification event.** Task completion is audited through the
  existing `run.notification.injected` event, not a parallel "task revival"
  event — so trace/diagnostics have a single lens on "why did the loop take
  another turn." Directly answers the review's "notify-but-can't-audit" risk.

## Non-goals

- Pausing the whole run loop (separate feature).
- Distributed/cross-process task execution — all in-process under one host.
- Changing the shell promotion contract; this proposal *generalizes* it.
