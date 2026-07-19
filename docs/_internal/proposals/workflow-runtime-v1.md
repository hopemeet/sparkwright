# Workflow Runtime v1 Proposal (Brainstorm Draft)

> Status: **accepted slice P0 / P1 / P1.5 / P2 / P3 / P4 / P5 / P6a / P6b / P7a / P8a / P9a / P10a** — the Accepted Slice table
> below is the only execution contract. Everything else is rationale,
> constraints, P4+/destination design drafts, or parking lot; where a body
> section could be misread as P1 work it carries an explicit phase label.
> Current Facts are source-verified; substrate ownership and build order
> defer to `substrate-sequencing.md`.
> Storage convergence (2026-07-16): the accepted runtime now persists workflow
> record/event truth only in `<workflowRunId>.journal/`. P2/P9a wording about
> record JSON, event JSONL, or legacy-store compatibility is implementation
> history, not a current compatibility requirement.
> Package-identity convergence (2026-07-17): durable runs now require source
> layer, generation/revision, v2 `packageHash`/policy, executable snapshot ref,
> and a matching snapshot-backed definition. Earlier `{assetName, version,
contentHash}` pin wording is implementation history; Markdown `contentHash`
> remains only a live-parser fingerprint and is not durable execution identity.
>
> Review history: six source-verified passes (2026-07-03 ×2,
> 2026-07-04 ×3) plus a consolidation sweep; provenance is tagged inline —
> decisions 1–10 (first pass), 11–18 (second), 19–20 (third), 21–24
> (fourth), 25 (sixth), 26 (2026-07-05 mid-P3 discussion pass,
> user-ratified via the P3 execution plan v2.1). The fifth pass (2026-07-04, pre-implementation,
> user-confirmed) traced the command-fact extraction channels in
> run-outcome and hardened 22/23 plus the P1.5 deletion bound. P1 and P1.5
> implementation passes on 2026-07-04 updated the Current Facts for the
> live projection branch: S2 and S3 are landed, P1 projection is
> implemented, P1.5 deletes the old live gate producers, S1 document-store
> is landed, and P2 durable workflow records / cross-run resume are now
> implemented locally. The sixth pass identifies the P1.5 semantic regression
> caused by treating run-level invariants as one-shot workflow nodes and
> accepts D25 as the release-gate closure contract. Source facts are stated
> once, in Current Facts; decisions cite them and do not restate them. The
> seventh pass, after P2 merged to main, admits P3 to the Accepted Slice while
> keeping D18 as the gate before actor episode spawning rather than a circular
> P3 entry condition.
>
> Companion designs this must stay consistent with:
> `docs/_internal/project-map/designs/internal-actor-inbox.md` (workflow is
> already an `InternalActorKind` there),
> `docs/_internal/project-map/designs/hooks-control-plane-refactor.md`,
> `docs/_internal/proposals/background-task-lifecycle.md`,
> `docs/_internal/proposals/session-agent-host-coordinator.md` (sequencing
> constraint, 2026-07-05: its host-side `SessionTurnFactory` chain
> semantics must wrap the post-D18 unified run-chain driver, so that half
> starts only after P3 Step 4a retires `startSupervisedRunChain`; the
> transport-neutral port half is unblocked. That doc owes a v4 note
> recording this, workflow-`waiting` parking the session turn via the
> lock park/wake path, and host-minted `system` sources for
> episode/cron/continuation automation).
> Substrate ownership and build order are governed by
> `docs/_internal/proposals/substrate-sequencing.md`: FactLedger
> (decision 13) and the asset-parser primitive (decision 1) are owned
> here; the document store (S1) is a standalone refactor this proposal
> only consumes; the continuation budget (decision 14) implements only
> after the S3 end-state is ratified cross-proposal.

## Accepted Slice (P0/P1/P1.5/P2/P3/P4/P5/P6a/P6b/P7a/P8a/P9a/P10a) — the minimal closed loop

This table is the executable contract; the body below is rationale and
constraints. Substrate references (S1–S4) resolve to
`substrate-sequencing.md`. Rule-zero accounting is per that page
(inspection exception + named-deletion acceptance).

| Phase | Entry condition                                                                                                                                                                                               | In slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Explicitly out                                                                                                                                                                                                                                                                                                                                                                                    | Deletion bound                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | **[branch-local]** substrate facts (advance, actor-inbox unions, core NotificationSource — `feat/background-agent-jobs` @ `eaf17742`) merged to main or commit-pinned; rule-zero inspection exception applies | S4 asset-parser primitive + workflow folder parser on top; `workflow list` / `inspect` + capability snapshot; schema reservations (`workflow.*` trace vocabulary, version-pinning fields, reliable `waiting` notification member); hook assembly-order regression test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | any runtime behavior change                                                                                                                                                                                                                                                                                                                                                                       | S4 PR migrates the agent-profiles parser copy in the same PR                                                                                                                                                                                                                      |
| P1    | **S2 FactLedger landed** and **S3 ratified + generalized** — P1 does not start before both                                                                                                                    | linear model nodes; `command` verifier with expectation polarity (D22) + Stop gate reading the ledger; `retry`/`goto`/`fail` transitions via `advance`; PreToolUse clamp; TurnStart injection; in-memory state + `workflow.*` events; D19/D20 compile-time enforcement; D23 fail-closed constructor + its two required tests; D24 interruption facts incl. the cancel-kicks-RunEnd core prereq                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `diff_scope` (needs the node-entry epoch marker; P3 Step 2), `ask_user`/`human`, model-facing instantiation tool, any durability claim                                                                                                                                                                                                                                                            | P1 adds a hook producer; the deletion is bound to P1.5, which is therefore **not optional**                                                                                                                                                                                       |
| P1.5  | P1 landed                                                                                                                                                                                                     | verification profile → host-owned run-level invariant projection (D25); documented-command Stop hook → built-in invariant verifier (D25); `verification:` hookName-protocol consumers (`analyzeVerificationProfileResults` + CLI exit path) migrate to ledger/verification-result snapshot reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | implicit verification/documented-command installation on delegate child runs unless a future opt-in feature adds it; treating run-level invariants as user-authored workflow nodes                                                                                                                                                                                                                | release gate pending until both old live gate implementations are deleted **and** D25 restores latest-write invariant semantics without the experimental flag                                                                                                                     |
| P2    | P1.5 + S1 landed                                                                                                                                                                                              | `WorkflowRunRecord` writes real durable state in the session root; `FileWorkflowStore` on S1 doc-store; pinned definition snapshots; attempts, evidence refs, verdict/transition logs; single-writer lease with refresh/release; cross-run `workflow resume`; resume re-verification; workflow list/resume protocol + CLI/SDK surfaces; terminal workflow actor notifications through the shipped actor-inbox union                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | P3 node kinds, first `waiting` emitter, workflow actor episode driver, node-boundary compaction implementation                                                                                                                                                                                                                                                                                    | consumes S1 instead of adding a new file-store copy; retires the P0 reserved-only workflow-run-record contract                                                                                                                                                                    |
| P3    | P2 merged to main (PR #46, merge commit `44f80db3`). D18 is **not** an entry condition; it is the Step 1 exit gate and Step 4a entry gate before actor episode spawning.                                      | D18 degenerate workflow expression for the host supervisor todo-continuation chain; non-model node runner semantics decision; `command` / `task` / `delegate` / `human` nodes; `waiting` durability contract + first D21 reliable emitter; actor-owned episode driver inversion; per-episode catalog narrowing; escalation ladder / cruise mode budget rules (D6); `workflow_start` decision (D11); `diff_scope` verifier + node-entry epoch marker; `task_terminal` ordering decision at Step 2 entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `script` nodes and stdio JSON-RPC node API (P4); `parallel` / `join` (P5); node-boundary compaction implementation/wiring (deferred until a later phase explicitly accepts it); workspace-root state promotion (D5); two-phase PreToolUse (D20); `workflow distill` and parking-lot ideas.                                                                                                        | Step 4a retires `startSupervisedRunChain` and converges the three run-chain owners (core continuation / `startSupervisedRunChain` / workflow episodes) onto one driver.                                                                                                           |
| P4    | P3 merged to main (PR #47, merge commit `8593b4a8`). P4 must preserve the P3/D11 outcome: no model-facing `workflow_start` tool, and any future spawn-shaped reopening must satisfy D26.                      | `script` workflow nodes; stdio JSON-RPC node API over child stdin/stdout with telemetry kept on stderr as a `TracedProcessRunner` / `stdio-v1` family member; script asset declarations mapped through shell-sandbox/access clamps with D16 all-or-nothing authorization; host-owned node API methods for progress, completion/failure, `getEvidence(nodeId)`, and governed primitive calls; two or three real internal dogfood workflow assets for release/runtime probe ladders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | node-boundary compaction wiring (D10 remains expressible but not connected in P4); retry-time model escalation / model-node boundary split and cruise-mode policy beyond deterministic script execution; actor-bound deterministic executor migration for all non-model nodes; `parallel` / `join` (P5); `workflow_start` / spawn mode (D26 future slice only); expression language for dataflow. | P4 retires `external-command-agent`'s private progress head/tail sampler by moving stdio progress sampling into the `TracedProcessRunner` family; scripts reuse that traced-process/sandbox family instead of adding another process protocol.                                    |
| P5    | P4 committed on this branch (`a83104fb`) and full `npm run release:check` passed. P5 continues to preserve P3/D11/D26: no `workflow_start`, no spawn-shaped workflow instantiation.                           | Bounded `parallel` and `join` node declarations; durable `parallelBranches` state on `WorkflowRunRecord` / runtime state; host projection execution for non-model branch nodes only (`command`, `delegate`, `task`, `script`) with explicit `maxConcurrency`; `parallel` nodes must declare explicit `onPass` and may not route `onPass` into one of their branch nodes, preventing implicit fall-through into branch execution; branch-local `verify` declarations are rejected because P5 does not execute branch Stop verifiers; all-delegate fan-out uses the existing `delegate_parallel` tool when available and remains bounded by `maxConcurrency`; task branches use existing `task_create` / task state rather than a workflow task scheduler; `join.waitFor` reads persisted branch verdicts from an unambiguous producer and emits a normal node verdict for ordinary pass/fail while branch runtime errors and delegate_parallel infrastructure crashes remain fail-closed; P5 D21/D23/D24 composition keeps workflow instance ids on notifications, fail-closed projection hooks, and interruption/cancellation as workflow interruption facts with no separate branch bus. | model-node branch fan-out / multiple concurrent model episodes; nested `parallel`; `human` branches; implicit join discovery; branch-local `onPass`/`onFail` transition execution; branch-local verifier execution; expression language or dataflow predicates; new scheduler, queue, cancellation bus, or workflow-specific background task owner; `workflow_start` / spawn mode.                | P5 retires the reserved-only `parallel`/`join` parking-lot contract by replacing it with the single projection/store implementation; all-delegate fan-out must call `delegate_parallel`, so workflow runtime does not grow a second configured-delegate fan-out mechanism.        |
| P6a   | P5 hardening commit (`80c991ae`) and full `npm run release:check` passed. This is the first pool-selected self-hosting slice: plan/todo doctrine before new workflow distill or spawn-shaped surfaces.        | Make the tool-gated `todo_planning` prompt section the single authority for todo cadence ("when to open, update, skip, or avoid rewriting the ledger"); keep `todo_write` schema text limited to structural/status/evidence rules; add regression coverage proving cadence appears only when `todo_write` is in the live inventory and is not restated in the tool schema.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Replacing permission `plan` mode; deleting core `Plan` protocol helpers; `todo_clear` verifier; workflow distill; shadow mode; workspace-root promotion (D5); two-stage PreToolUse (D20); any `workflow_start` / spawn reopening.                                                                                                                                                                 | Retires the duplicate prompt-level todo cadence copy in the `todo_write` tool description, leaving supervisor continuation prompts as recovery-only directives and `todo_planning` as the durable tool-gated doctrine source.                                                     |
| P6b   | P6a committed (`996be54e`) and focused todo/project-context gates passed. Continue the self-hosting todo slice without reopening D18/D11/D26.                                                                 | `todo_clear` workflow verifier type/parser/projection support; host projection reads the session todo ledger through an explicit provider supplied by runtime, passes when no unfinished items remain, emits summary/evidence metadata, and fail-closes when the provider is missing or unreadable; parser and projection tests cover pass/fail/runtime-error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Replacing the todo supervisor continuation audit; moving todo state into FactLedger; `todo_clear` as a global invariant verifier; workflow distill; shadow mode; permission `plan` changes; workspace-root promotion (D5); two-stage PreToolUse (D20); any `workflow_start` / spawn reopening.                                                                                                    | Named deletion acceptance: no old execution owner exists for this verifier; P6b retires the proposal's reserved-only `todo_clear` vocabulary by making it a real workflow verifier. Acceptance owner: workflow-runtime maintainer for this branch.                                |
| P7a   | P6b committed (`64e466eb`) and focused verifier gates passed. First `workflow distill` slice stays read-only/deterministic so it can feed internal asset supply without adding a model loop.                  | `sparkwright workflow distill <session-id>` reads the session trace, derives a review-first draft `workflow.md` plus JSON/text summary, and emits it to stdout; deterministic host helper extracts goal, observed tools, touched paths, writes, and post-write verification commands into a small linear workflow draft.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Writing `.sparkwright/workflows`; skill-evolution proposal creation/apply; model-backed distillation; trace mutation; protocol/TUI surface; shadow mode telemetry; workflow_start/spawn; expression/dataflow language; automatic authorization beyond observed static command drafts.                                                                                                             | Named deletion acceptance: no old distiller exists; P7a retires the parking-lot-only `workflow distill` idea by shipping a read-only CLI draft generator. Acceptance owner: workflow-runtime maintainer for this branch.                                                          |
| P8a   | P7a committed (`da882db6`) and focused distill gates passed. The first shadow slice must stay offline/read-only so it does not reopen supervised/live hook ownership or D11/D26.                              | `sparkwright workflow shadow <workflow-name> <session-id>` reads an existing workflow asset and an existing session trace, reuses the deterministic trace observation path, and emits JSON/text coverage for observed tools, write paths, `diff_scope`, `todo_clear`, and command-verifier-like gates that the workflow would or would not cover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Live run subscription, protocol/TUI shadow telemetry, workflow record writes, run verdict changes, model judgment, asset/proposal writes, replay execution, expression/dataflow language, workflow_start/spawn, or any second scheduler/hook producer.                                                                                                                                            | Named deletion acceptance: no old shadow runner exists; P8a retires the parking-lot-only `shadow workflow` idea's first reviewable surface by making it an offline coverage report rather than a parallel runtime. Acceptance owner: workflow-runtime maintainer for this branch. |
| P9a   | P8a committed (`53d658de`) and focused shadow gates passed. This is the first D5 workspace-root lift slice and must not open unattended/spawn execution.                                                      | Fresh workflow runs persist in a workspace-level `workflow-runs` store under the workspace state root while retaining `sessionId` on each record; `workflow list` and `workflow resume` read the workspace-level store plus legacy session-root stores; resume passes the located store through the actor episode path so legacy records keep writing to their original store; tests prove fresh writes no longer create session-local workflow state and legacy records remain resumable/listable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Migrating/copying old records; deleting legacy session-root compatibility; unattended daemon/adopter process; workflow_start/spawn; protocol/TUI payload changes; cross-workspace registry; changing session trace/todo locations; changing workflow notification outbox semantics.                                                                                                               | P9a retires the session-directory scan as the only authoritative workflow-run lookup mechanism: workspace-root store becomes the fresh-run authority, with session-root stores demoted to legacy compatibility until a later signed deletion removes them.                        |
| P10a  | P9a committed (`0bac1708`) and full `npm run release:check` passed. This is the D20 compatibility slice and must not reopen workflow_start/spawn or hook lifecycle vocabulary.                                | Core `PreToolUse` execution becomes two-stage for tool calls: run rewrite-capable hooks first, apply argument rewrites, then run governance/block hooks such as workflow node clamps over the rewritten arguments; host marks configured result-producing `PreToolUse` hooks as rewrite-stage and workflow projection clamps as governance-stage; configured `PreToolUse` rewrites are again allowed while a workflow is active, with tests proving the workflow clamp observes rewritten arguments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | New hook names or config schema fields; expression/dataflow language; rewriting tool names; changing policy/approval/tool validation order after the two-stage PreToolUse boundary; protocol/TUI payload changes; workflow_start/spawn; a second hook runner or scheduler.                                                                                                                        | P10a retires the P1 hard prohibition that rejected configured `PreToolUse` `rewrite` while a workflow was active, replacing it with staged core execution so rewrites cannot bypass workflow clamps.                                                                              |

### Phase Status

- 2026-07-04 — S2 FactLedger implemented on `feat/fact-ledger`: core shared
  fact classifiers, live run FactLedger, raw command facts with initiator tags,
  verifier result `expect`/`satisfied`, global write epoch stale markers
  (including untracked-write-capable boundaries), terminal
  `run.completed.factLedger`, verification Stop gate ledger reads, and trace
  diagnostics per-run ledger preference. At that checkpoint, P1 still awaited
  S3 ratification and generalization.
- 2026-07-04 — S3 per-source forced-continuation budget implemented on
  `feat/forced-turn-budget`: corrected S3 ratification recorded in
  `substrate-sequencing.md`; core now has one `revival` / `workflow` source
  budget mechanism, `revival` preserves `revivalTurnsUsed` terminal metadata,
  `workflow` is registered with no P1
  consumers yet, and source exhaustion emits `run.budget.exceeded` plus
  FactLedger `budgetExceeded` facts without directly failing the run.
- 2026-07-04 — P1 projection implemented locally on `feat/workflow-p1`:
  agent-runtime owns the portable linear workflow state machine, host
  compiles workflow assets into one stateful `workflow:<runId>` projection
  family, `sparkwright run --workflow <name>` / `run.start.workflow`
  instantiate P1 model-node workflows only behind the former experimental
  runtime gate, Stop gates read the FactLedger verifier-result snapshot,
  workflow-forced continuations consume the S3 `workflow` source budget,
  workflow source exhaustion also kicks a `RuntimeSignal(budget.exceeded)`
  customer notification so the P1 projection can record interruption /
  `workflow.failed(runtime)` before `run.completed`, `workflow.*` lifecycle
  events are emitted for projection runs, configured `advance` / initial
  single-pass `rewrite` effects are rejected while a workflow is active
  (rewrite half superseded by P10a staged PreToolUse), command verifiers
  require static argv plus explicit asset authorization, governing projection
  hooks fail closed, and `cancel()` now kicks
  `RunEnd(state: "cancelled", reason: "manual_cancelled")`. P1.5's
  verification/documented-command deletion remains outstanding.
- 2026-07-04 — P1.5 deletion payoff landed locally on `feat/workflow-p15`, but
  post-review found a semantic regression: verification/documented-command were
  deleted as old live gate producers, then mechanically reintroduced as
  one-shot single-node workflow projections. That shape weakens the run-level
  invariant "latest write must be clean": first Stop can terminally complete,
  read-only runs can pay verification cost and fail, and failures become
  fail-fast instead of bounded fix loops. D25 is the accepted closure contract:
  keep the deletion, but replace the one-shot implicit workflow shape with
  host-owned run-level invariant projections before claiming the release gate
  satisfied. The previous "release gate satisfied" status and `release:check`
  closure claim are therefore withdrawn for this branch checkpoint.
- 2026-07-04 — D25 repair implemented locally on `feat/workflow-p15`:
  verification require mode and documented-command now use host-owned invariant
  projections instead of implicit workflow definitions; suggest mode is
  guidance-only; no-write runs skip verifier execution; current clean epochs do
  not re-run commands; failed/missing/stale evidence advances with bounded
  retry feedback; terminal outcome classifies profile and documented-command
  failures without generic workflow double-counting; delegate child runs no
  longer inherit global verification/doc-command hooks; `workflowActive` is
  limited to selected user workflow projections; and `afterWrites.frequency` is
  removed as an intentional strict-schema break. Full `npm run release:check`
  passed at this checkpoint, including `npm run check`, deterministic CLI smoke,
  regression matrix, source install smoke, and release install smoke. P1.5's
  release gate is therefore satisfied for this branch checkpoint.
- 2026-07-04 — S1 document store prerequisite implemented locally on
  `feat/doc-store`: `agent-runtime/src/doc-store/` now owns shared atomic
  text/JSON document writes, corrupt-entry-tolerant JSON directory/log scans,
  JSONL append-log helpers, and token-entry file-backed single-writer leases
  for future session-root stores such as P2 `FileWorkflowStore`. Rule-zero
  payoff in this phase: `FileTaskStore` record writes migrated to the shared
  primitive and its private `atomicWriteTextSync()` copy was retired; workflow
  runtime code remains untouched.
- 2026-07-05 — P2 durable state + cross-run resume implemented locally on
  `feat/workflow-p2`: `WorkflowRunRecord` now writes real five-status durable
  state under session-root `workflow-runs/`, `FileWorkflowStore` composes the
  S1 doc-store primitive for atomic records / JSONL events / single-writer
  leases, projection snapshots persist current node, attempts, verdict and
  transition logs, run/fact evidence references, and pinned compiled
  definitions. Post-review fixes tightened fresh `run --workflow` to acquire the
  same lease before record creation, moved runtime fallback finalization after
  the todo-supervised chain decision, fail workflow records on supervisor
  rejects before releasing the lease, exposed completed/failed workflow actor
  notifications through the actor inbox, and limited resume re-verification to
  verifier nodes whose latest stored verdict passed. `workflow.list` /
  `workflow.resume` exist in host protocol, CLI, and SDK surfaces. The `waiting`
  - `wait.kind` vocabulary remains reserved with no P2 emitter; P3 `human`
    nodes are still the first planned emitter.
- 2026-07-05 — P3 contract admitted after P2 merged to main as PR #46
  (`44f80db3`). Seventh-pass scope correction: P3 entry is only "P2 merged";
  D18 is the gate before actor episode spawning, mapped to P3 Step 1's exit
  gate and Step 4a's entry gate. P2's three accepted residuals are explicitly
  routed instead of hidden behind the release claim: the purely in-memory
  workflow notification surface feeds the P3 Step 3 waiting/outbox durability
  contract; the bounded prepare-tail lease TTL leak remains a named robustness
  backlog item; and the `resolveRunAccessFields` double-cast cleanup is a
  core/API typing debt outside the workflow proposal.
- 2026-07-05 — P3 Step 1 minimal D18 landing: agent-runtime workflows now own a
  portable `runWorkflowRunChain()` driver for the "run one episode, inspect
  terminal evidence, maybe continue" loop shape, and `runTodoSupervised()`
  expresses the host todo-continuation chain through that driver as a
  degenerate workflow controller. `startSupervisedRunChain()` still exists only
  as host active-run/session/lease/event glue; Step 4a's deletion path is to
  replace that wrapper with the actor-owned episode driver while keeping the
  workflow-owned run-chain driver as the shared mechanism.
- 2026-07-05 — P3 Step 2 supervised projection entry landed: non-model nodes
  execute through host-owned governed primitives at node boundaries, not as
  model hints. In the supervised projection slice, `command` nodes run trusted
  static argv through the existing command hook action path; `delegate` nodes
  invoke the configured `delegate_agent` primitive; and `task` nodes launch the
  explicit `task_create` primitive. The projection drains non-model nodes until
  the next model boundary inside existing hook gates; full actor-owned terminal
  handling remains Step 4. `diff_scope` verifier evaluation now uses a
  projection-owned node-entry write epoch marker over the core FactLedger write
  facts. `task_terminal` ordering is accepted as Stop-before-await, paying the
  extra forced turn after a `waiting_tasks` wake rather than moving the await
  gate ahead of Stop.
- 2026-07-05 — P3 Step 3 supervised waiting entry landed: `human` is now a
  P3 node kind and the first `workflow.waiting` producer. Waiting durability is
  host/store-first: `WorkflowRunRecord.status:"waiting"` carries `wait.kind`,
  workflow store events include `waiting` and `input`, and
  `FileWorkflowNotificationOutbox` durably replays reliable workflow actor
  notifications without changing the legacy task notification format. In the
  supervised projection shape, a human node parks the workflow, releases the
  workflow lease after the ordinary host run finishes, and `workflow.resume`
  consumes `input` waits by recording an actor input event, clearing `wait`,
  advancing the human node with a passed verdict, and starting the next run.
  Step 4a moves that consumer to the actor-owned episode boundary.
- 2026-07-05 — P3 Step 4a deletion landing: host runtime retired
  `startSupervisedRunChain()` and routes fresh run, run resume, and workflow
  resume through `startWorkflowActorEpisodeChain()`. The resident workflow/todo
  actor owns the chain shape through agent-runtime's
  `runTodoSupervised()` -> `runWorkflowRunChain()` driver and persists node
  position, attempts, evidence, transitions, waiting input consumption, and
  resume state in `WorkflowRunRecord`; host `createRun()` episodes are
  transient workers that provide model/config/tool/session glue. This step does
  not include Step 4b catalog narrowing, D6 budgets, or `workflow_start`.
- 2026-07-05 — P3 Step 4b.1 per-episode catalog entry landed: when the actor
  starts a worker episode positioned on a model node with `tools`, host passes a
  physically narrowed `ToolDefinition[]` to `createRun()` and records
  `episodeAllowedTools` on the workflow run. The existing PreToolUse clamp
  remains as a fallback for mid-run transitions until each model node is split
  into its own worker episode; catalog absence now wins over the clamp so
  unavailable tools surface as `TOOL_NOT_FOUND`. Follow-up fix from P3 review:
  when the narrowed catalog contains deferred tools, host appends a scoped
  `tool_search` whose search source is only the narrowed catalog, and the
  PreToolUse clamp treats that available infrastructure tool as allowed. This
  preserves deferred schema loading without reopening the full parent catalog.
  Workflow declarations and the clamp now compare the same exact callable
  names; `tools: [read]` allows `read` without a normalization layer.
  Treat "landed" here as implementation status, not a PR-ready correctness
  claim; this follow-up belongs to P3 acceptance hardening before merge.
- 2026-07-05 — P3 Step 4b.2 D6 worker-entry budget/model facts landed:
  workflow model nodes parse `model` and `runBudget`; host resolves node model
  refs through the same configured model-tier surface used elsewhere, selects
  the current node's model adapter and per-attempt run budget at worker
  `createRun()` entry, and records `workflowEpisode`, per-episode usage
  snapshots, and aggregate `workflowUsage` on `WorkflowRunRecord.metadata`.
  This is the minimum verifiable D6 substrate after Step 4a. Retry-time strong
  model escalation inside a single core run is still deferred until model-node
  boundaries are split into separate worker episodes; this landing does not
  implement cruise-mode policy or node-boundary compaction.
- 2026-07-05 — P3 Step 4b.3 `workflow_start` decision recorded as **not
  implemented in P3**. The accepted P3 item was the D11 decision point, not a
  mandatory model-facing tool. Source reality after Step 4a/4b.1/4b.2 is that
  `HostRuntime.startRun()` is single-active-run connection glue and a tool-call
  reentry path would cross active-run ownership, authorization clamp, task
  lifecycle, and spawned-workflow trace/record routing. Therefore P3 keeps
  workflow instantiation on CLI/config/protocol request surfaces only; model
  worker episode catalogs continue to contain no `workflow_start` by default.
  A future slice may implement D26's spawn-shaped destination only when it is
  born into the unified task lifecycle with explicit recursion/depth and access
  constraints.
- 2026-07-05 — P3 Step 5/6 boundary check: no further P3 implementation is
  accepted. The Accepted Slice keeps `script` nodes and stdio JSON-RPC node API
  in P4, `parallel`/`join` in P5, and node-boundary compaction
  implementation/wiring deferred until a later phase explicitly accepts it.
  P3 therefore stops after the Step 4b decision records instead of quietly
  expanding the acceptance criteria.
- 2026-07-05 — P4 contract admitted after P3 merged to main as PR #47
  (`8593b4a8`). P4 keeps the phase discipline narrow: scripts and the stdio
  JSON-RPC node API land together with a stdio progress-sampling deletion in
  the traced-process family. Node-boundary compaction is explicitly not wired
  in P4 even though D10 says the existing substrate can express it; retry-time
  model escalation stays deferred until a model-node boundary split turns each
  attempt into its own worker episode; the larger actor-bound deterministic
  executor migration is not folded into the script slice; `workflow_start`
  remains absent per the P3 D11 outcome and D26 envelope. Asset-supply-first is
  accepted here as project-local dogfood assets, not as runtime semantics.
- 2026-07-05 — P4 implementation landed locally on `feat/workflow-p4`:
  workflow assets parse `execute: script` nodes with asset-local paths,
  capability declarations, env/stdin/timeout/output limits, and pinned
  `sourceDir`/`sourcePath` for resume; `TracedProcessRunner` now owns a
  newline-delimited JSON-RPC stdio child mode with stdout reserved for RPC and
  stderr retaining `SPARKWRIGHT_EVENT` telemetry; script nodes execute through
  the host node API (`initialize`, `progress`, `getEvidence`, `invoke`,
  `complete`, `fail`) and D16 rejects declared write capability in read-only
  runs. The deletion payoff is the shared progress sampler in
  `traced-process-runner.ts`, consumed by external command delegates and the
  script path instead of an `external-command-agent` private copy. Two dogfood
  fixture assets (`release-check-focused`, `workflow-runtime-p4-smoke`) now
  provide real internal focused-gate pipelines without entering the default
  builtin runtime catalog.

## Purpose

Real tasks are not one model reply; they are a controlled, verifiable,
resumable execution process. The ReAct loop alone degrades on long-horizon
work: the model skips steps, forgets prior failure causes, claims completion
without evidence, cannot re-enter a stable fix loop after test failures,
cannot resume after interruption, and successful task shapes never become
reusable assets.

Workflow adds the external control layer:

```text
Plan -> Execute -> Verify -> Transition
```

The thesis of this proposal: SparkWright does not need a new workflow engine.
The three pillars already exist — an awaited in-run control plane (workflow
hooks), a suspension/revival spine (waiting_tasks + NotificationSource), and a
durable store pattern (FileTaskStore). What is missing is a **durable workflow
state document plus a thin per-node projection layer** that compiles the
current node into constraints on an otherwise normal run.

Second thesis (the economics): **workflow moves intelligence from run time to
design time.** Expensive models spend once on authoring/distilling/iterating
the process; cheap models execute inside the fixed rails; fact-based
verifiers are the equalizer that makes the trade safe — correctness is judged
by exit codes and artifacts, not by the executing model's self-report. This
yields three product properties:

- **model-swap resilience**: process and verification live outside the model,
  so changing models loses nothing; a workflow + fixtures becomes the
  regression suite for admitting a new model;
- **cost curve on demand**: cheap model first, escalate to a strong model only
  when verifiers keep failing (see escalation ladder below);
- **online-service engineering**: because workflows are external versioned
  assets with durable state, standard practice applies — versioning, canary,
  rollback, node-level pass-rate telemetry, unattended operation.

## Current Facts

This section is the **single source for source-code facts** in this
document; decisions cite these bullets and do not restate them.
Verification provenance: `feat/background-agent-jobs` @ `eaf17742`
(2026-07-04). Facts marked **[branch-local]** exist only on that branch —
they are not on `main`, and P0's entry condition requires them merged or
commit-pinned before implementation starts.

- `packages/core/src/workflow-hooks.ts` + `packages/core/src/run.ts` provide
  awaited lifecycle gates (`RunStart`, `TurnStart`, `ModelOutput`,
  `PreToolUse`, `PostToolUse`, `Stop`, `RunEnd`, `RuntimeSignal`) with
  `block` / `rewrite` / `continue`-context semantics. A `Stop` block injects
  continuation context and forces another model turn — this is the existing
  "prevent self-claimed completion" primitive.
- **[branch-local]** The core hook substrate now also has `advance`: a
  successful continuation
  result for `ModelOutput` and `Stop`. It forces another model turn while
  recording a completed hook result, so healthy node advancement is no longer
  trace-equivalent to a gate violation.
- `packages/host/src/verification.ts` `createVerificationWorkflowHooks()`
  now compiles declarative verification profiles into host-owned invariant
  projections via `createInvariantProjectionHooks()`, not implicit workflow
  nodes. Require mode maps profile commands to invariant verifiers over the
  FactLedger; suggest mode remains TurnStart guidance only. Evidence-gated
  completion is proven product behavior, the old independent verification
  Stop-gate producer is gone, and D25's latest-write invariant semantics are the
  current release-gate contract.
- `packages/host/src/workflow-hooks.ts` `createConfiguredWorkflowHooks()`
  compiles configured rules into core hooks with `command`, `http`, and
  `agent` actions; `bindConfiguredEventHooks()` is the non-blocking lane.
- The run loop drains `NotificationSource` at step start and injects content
  via `run.notification.injected`; awaited background work suspends in the
  internal `waiting_tasks` state, which is **explicitly not durable** —
  checkpoints do not pretend to resume it
  (`docs/_internal/project-map/maps/runtime/run-loop.md`).
- `packages/agent-runtime/src/tasks/` provides `TaskRecord`, `FileTaskStore`,
  and the durable `FileTaskNotificationOutbox` — the persistence and
  notification pattern a workflow store should copy.
- **[branch-local]** The actor inbox is **in-tree code**, no longer only a
  design doc
  (`packages/agent-runtime/src/tasks/notifications.ts`, commit
  `7656fb17`): `InternalActorKind` includes `"workflow"`,
  and typed `Workflow{Completed,Failed,Progress}` notification unions exist
  with qos `reliable`/`reliable`/`lossy`. Two contract facts bind this
  proposal: `WorkflowNotificationPayloadBase` reserves `workflowId`
  (decision 21 rules it the **instance** id), and
  `WorkflowFailedNotificationPayload.error` reuses `TaskError`
  (`{code, message, metadata?}`), so the error taxonomy's `failure.kind`
  must map into it (decision 21). The union now includes the reliable
  `waiting` member with `wait.kind`; P2 still has no emitter, and P3 `human`
  nodes remain the first planned waiting producer.
- Access-mode clamp (`packages/core/src/access-mode.ts`) and tool exposure
  tiers prove per-run capability narrowing is an established governance
  pattern; what is missing is per-node re-narrowing.
- Run-outcome doctrine: verdicts come from persisted command/tool facts, never
  from model prose (保事实、调信号).
- Agent profiles and skills are markdown-authored assets; skill-evolution
  provides proposal/history/restore machinery for asset iteration.
- A `Stop` block increments `state.step` and `turnCount` before the loop
  continues (`packages/core/src/run.ts`, Stop-block continuation). P1
  projection continuations from `workflow:` hooks now consume the S3
  `workflow` forced-continuation source instead of `maxSteps`; non-workflow
  validation continuations still consume normal step budget. Revival turns
  ride the same core per-source budget under the `revival` source, with
  `forcedContinuationBudgets.revival` as the sole configuration input.
- Command facts still arrive through **two evidence channels**:
  model-initiated shell `tool.*` events and hook-launched
  `workflow_hook.completed` `result.metadata.exitCode` events. S2 moved
  both into the live FactLedger with initiator tags and verifier-result
  `expect` / `satisfied` fields plus optional `verificationSource`. Live/new
  verification profile verdicts are read from the terminal
  `run.completed.factLedger.verificationResults` snapshot; the legacy
  `verification:<profile>:<id>` hookName protocol is retained only as an
  offline old-trace fallback.
- Workflow hooks are supplied at run creation; core has no API to replace a
  run's hook list mid-flight.
- `runWorkflowHooks` (`packages/core/src/workflow-hooks.ts`) executes hooks
  in **array order and returns on the first `block` or `advance`** — later
  hooks at the same gate are not evaluated that firing. `rewrite` patches
  are collected across hooks and applied only after the gate returns
  (`packages/core/src/run.ts`, post-`blocked`-check loop), and every hook
  sees the same pre-rewrite `payload`. Merge semantics are therefore an
  assembly-order contract, not a priority system — the host assembles the
  array at `runtime.ts` in guarded order: configured hooks first, then current
  built-in verification invariant projections, built-in documented-command
  invariant projections, and selected workflow asset projections. P1.5 removes
  the separate verification/documented-command gate producers; D25 narrows the
  replacement shape to host-owned invariant projections plus selected user
  workflow projection, not generic user-authored workflow nodes.
- The `RuntimeSignal` emission surface is narrower than the
  `WorkflowRuntimeSignal` vocabulary (fourth pass, re-verified after S3/P1 in
  `run.ts`): live emitters are the repeated-tool-call site
  (`repeated_tool_call` / `doom_loop`) plus workflow-source forced-turn
  exhaustion (`budget.exceeded`, family `forced_continuation`, source
  `workflow`). `budget.checked` and the `run.*` signals remain vocabulary-only
  in the RuntimeSignal hook lane. S3 adds the separate `run.budget.exceeded`
  event / FactLedger `budgetExceeded` fact for forced-continuation source
  exhaustion; P1 projection consumes the workflow-source signal/fact to record
  `workflow.interrupted(kind:"budget")` and `workflow.failed(runtime)`.
  Work-budget exhaustion still goes
  `checkRunBudget` → `fail()` → `RunEnd(state: "failed")`. `cancel()` is
  **synchronous**: it emits the `run.cancelled` trace event, returns, and
  now also kicks `RunEnd(state: "cancelled", reason: "manual_cancelled")`.
  `RunEnd` fires from `complete()` / `fail()` / `cancel()` and via
  `kickWorkflowHookPhase` —
  **fire-and-forget, never awaited** — so terminal-path hook writes have no
  completion-ordering guarantee.
- Hook fault isolation defaults open: `onError` defaults to `"continue"`,
  and an illegal `advance` (wrong lifecycle) throws **inside** the hook's
  try block in `runWorkflowHooks`, becoming `workflow_hook.failed` and then
  following `onError` — under the default, an illegal advance is silently
  absorbed and the run continues. Host-side `enforceWorkflowHookEffect`
  rejects configured `advance` while an active workflow projection is present;
  P10a replaced the older active-workflow `PreToolUse` rewrite rejection with
  staged rewrite -> governance execution. Raw embedder hooks remain governed
  by their own `onError`; the P1 projection constructor forces
  `onError: "block"` for governing hooks and bounds persistent Stop runtime
  errors before they can loop to `maxSteps`.
- `NotificationSource` is core-owned (`drainNotificationSources` in
  `run.ts`), and the generalized forced-continuation budget accounting lives
  in the core loop. `revival` is the first migrated source; P1 projection is
  the first `workflow` source consumer. Exhaustion emits
  `run.budget.exceeded` / FactLedger `budgetExceeded` and refuses that forced
  continuation without directly failing the run; for `workflow` source
  exhaustion core also kicks an awaited `RuntimeSignal(budget.exceeded)` so the
  host projection can own the workflow terminal failure before `run.completed`.
  D25 uses that awaited signal narrowly for invariant retry-budget refusal: only
  the invariant projection that just requested a retry may convert the refused
  continuation into a verification/invariant failure before `run.completed`.

## Design

### Shape decision: guardrails inside a run, durable shell across runs

Two rejected extremes:

- **Shape A — orchestrator above runs** (each node = one run, engine drives a
  DAG): recreates the run loop's budget/approval/trace/terminal semantics —
  the "second runtime" the actor-inbox design explicitly warns against — and
  fractures model context across nodes, making "forgets prior failures" worse.
- **Shape B — pure in-run constraint**: matches the existing DNA but a single
  live run cannot host multi-day tasks, long approval waits, or process
  restarts.

Chosen hybrid (Shape C): **the workflow is a durable state document; a thin
host-owned workflow actor projects the current node into a normal run; node
transitions are evidence-driven; cross-run resume reads the document, not the
chat context.**

```text
workflow definition (markdown + frontmatter asset, like agent profiles)
        | instantiate
workflow run state (durable: workflowRunId / nodeId / attempts /
                    evidenceRefs / verdicts / transition log)
        | project (recompiled per node)
  1. context injection   TurnStart context: current node goal, prior
                          failure cause, next expected action
  2. capability clamp    node-scoped tool/skill/delegate allowlist +
                          access-mode narrowing (never widening)
  3. verifier gates      compiled into Stop/PostToolUse workflow hooks
                          via the createVerificationWorkflowHooks pattern
  4. transition policy   verdict -> retry(<=N) / goto node / ask user /
                          fail workflow
        | notify (completed/failed/progress)
internal actor inbox (workflow is already in the enum)
```

### Workflow asset format (sketch)

A **folder asset**, like a skill, not a single file — this is a P0 decision
so script nodes (see the code-first addendum) never force a format
migration:

```text
workflows/bugfix/
  workflow.md        # frontmatter: nodes/transitions; body: per-node prompts
  config.yaml        # optional: model tiers, budgets, guardrail intensity
  scripts/           # optional: deterministic node implementations
```

Asset vs instance separation is strict: the folder is versioned, diffable,
shareable; run state (status, attempts, verdicts, logs) belongs to a
`FileWorkflowStore` keyed by workflowRunId, never inside the asset folder —
mixing them would break versioning/canary/rollback. Instantiation additionally
pins asset identity into the run record (see State and persistence): resume
resolves the pinned `{assetName, version, contentHash}` snapshot, never the
live folder.

Node bodies are per-node prompts, loaded only when the node is active (token
economy). Sketch, not final schema — and **destination vocabulary, not the
P1 slice**: `diff_scope` is P3 Step 2 work because it needs the node-entry
epoch marker, and `ask_user` is represented by P3 `human` nodes — in P1 a
definition that references `ask_user` or a `human` node is rejected at
instantiation as a definition error. A P1-legal definition uses
`execute: model`, `command` verifiers, and `retry` / `goto` / `fail`
transitions only:

```markdown
---
name: bugfix
version: 1
nodes:
  - id: reproduce
    execute: model # model | task | delegate | command | human
    tools: [read, grep, bash]
    verify:
      - kind: command
        run: "npm test -- {{failing_test}}"
        expect: nonzero # reproduction means the test fails
    onPass: diagnose
    onFail: { retry: 2, then: ask_user }
  - id: patch
    execute: model
    tools: [read, edit, bash]
    verify:
      - kind: command
        run: "npm test -- {{failing_test}}"
        expect: zero
      - kind: diff_scope
        paths: ["src/**"]
    onPass: summarize
    onFail: { retry: 3, then: fail }
---

## reproduce

Reproduce the reported failure. Do not modify source files yet.

## patch

Fix only the diagnosed cause. Stay inside src/.
```

### Verifier vocabulary (v1, all fact-based)

P1-slice note: the P1 implementation is **`command` only** (per the
Accepted Slice table). `artifact_exists` and `todo_clear` remain cheap future
candidates; `diff_scope` is P3 Step 2 work because it waits for the
node-entry epoch marker; `task_terminal` also belongs to P3 Step 2 because it
needs `task` nodes and an explicit await-vs-Stop ordering decision. The
vocabulary below is the v1 schema, not the P1 build list.

- `command`: exit code of a command run through `TracedProcessRunner`.
  Template bindings substitute **whole argv tokens only** — never string
  interpolation into a shell line; a model-supplied binding must not be able
  to smuggle shell syntax into a fact verifier (decision 16). Expectation
  polarity (`expect: zero | nonzero`) belongs to the **verifier layer**,
  never the fact layer: the ledger records the raw exit fact, the verifier
  result records `expect` + `satisfied`, and run-outcome interprets
  verifier-launched commands by satisfaction — otherwise a reproduce node
  that intentionally runs a failing test would flip the run's `failing`
  flag (decision 22).
- `diff_scope`: changed paths within declared globs. Fact source: `git
status --porcelain` when the workspace is a git repo; otherwise degrade to
  write-tool events with the limitation recorded in verdict metadata —
  event-based diffing cannot see `bash`-side edits, so the degradation is
  declared, not silently equivalent. Baseline: the event-derived path uses
  the FactLedger node-entry epoch marker (writes since node entry, see
  projection mechanics §3); the git path must snapshot the pre-existing
  dirty set at node entry so a dirty workspace does not false-positive.
- `artifact_exists`: declared output file/artifact present.
- `todo_clear`: todo ledger has no open items (cheapest first signal).
- `task_terminal`: awaited background task reached completed.

A model node with no verifiers is legal but auto-passes as **unverified**:
its verdict log entry records `verified: false`, so the workflow never
implies evidence it does not have.

Explicitly excluded from v1: model-judge verifiers. Verdicts must come from
persisted facts per run-outcome doctrine. A model-judge kind can be added
later as an `agent` action once the fact-based core is stable.

### P1 projection mechanics: the contract with the run loop

Four constraints from reading the run loop, each binding for P1:

1. **One stateful projection hook family, no mid-run hook swap.** Hooks are
   fixed at run creation and core has no replacement API — do not add one.
   The projection is a single hook family that closes over the portable
   state machine and dispatches on the current `nodeId`; "recompiled per
   node" happens inside that closure, never on the run's hook list.
   Invariant: **hooks contain no transition logic** — they collect facts,
   feed the machine, and apply its decision. This makes P1→P3 a re-homing of
   the machine (hook closure → workflow actor), not a rewrite.
2. **Node advancement has first-class continuation semantics in core.**
   The required narrow core change has landed as
   `WorkflowHookResult.status: "advance"` for `ModelOutput` and `Stop`.
   A healthy node transition now emits `workflow_hook.completed` with an
   advance result and forces another model turn; a gate violation still emits
   `workflow_hook.blocked`. This preserves 保事实、调信号 and gives the
   todo-continuation doctrine the same future escape hatch.
3. **Verdict evidence lives in a core FactLedger, not the event log and
   not workflow-private state.** The retired verification Stop gate scanned
   `payload.events` — a pattern that dies on cross-run resume (fresh event
   log). But writing a workflow-private evidence copy at `PostToolUse`
   would just trade the event-scan problem for a stale-state problem and
   add another "did the command pass" extractor beside verification.ts,
   the former compact terminal snapshot, trace-diagnostics recompute, and
   run-health. Instead: extract the fact-classification primitives
   into core (the `run-health.ts` shared-threshold precedent), run a live
   in-run `FactLedger` over them (command/verifier facts, write set,
   global write epoch), and expose it to hooks. Workflow verdicts
   _reference_ ledger facts; the `Stop` gate reads the ledger; run-outcome's
   terminal snapshot becomes a ledger snapshot; trace-diagnostics keeps its
   offline recompute path over the same shared classifiers (it reads
   persisted JSONL from other processes and cannot use a live ledger).
   Staleness rule v1 is deliberately coarse: any workspace write bumps the
   global epoch; a command fact recorded under an older epoch is stale and
   the verifier re-runs. False-stale costs one re-run; false-fresh cannot
   happen. Free corollary: node entry records an epoch marker, so
   event-derived `diff_scope` gets its baseline (writes since node entry)
   without a separate mechanism.
4. **Workflow continuation turns ride a generalized per-source budget, and
   P1 does not pretend the position is durable.** A Stop-forced turn
   increments `step`, so nodes × retries would parasitize `maxSteps`, and
   repeatedly failing verify commands can trip the doom-loop detector.
   The budget mechanism itself is **owned by S3**
   (`substrate-sequencing.md`, S3 annex), not re-specified here. This
   proposal states only its constraint and consumes the mechanism:
   workflow-forced turns are S3 family-2 forced
   turns that consume the `workflow` source budget, never `maxSteps`; the
   run-chain cap is outside S3 too and converges at decision 18.
   Interruption facts
   (`interrupted at node X, attempt N`) are recorded in live workflow state
   and as a `workflow.interrupted` trace event (audit only — resume must
   never read position back from trace; trace is a projection, not a bus).
   Capture surfaces (which signal carries which interruption, the two
   budget families, the cancellation core prereq, best-effort terminal
   writes) are decision 24's business and are not restated here.
   Honest P1 guarantee: the position survives budget/doom-loop interruption
   within a living process; a process crash loses it, leaving only the
   audit trace. Crash-resume is a P2 property of `FileWorkflowStore`,
   deliberately not front-loaded into P1 (see decision 14).

P1 targets the `core.createRun` loop only. The streaming-runtime loop is a
known latent convergence target (background-task proposal §A precedent); the
projection makes no equivalence promise there.

### Per-node model routing and the escalation ladder

Nodes may declare a model tier. This is the first concrete customer for the
logical-alias / model-allowlist work the multi-model design deferred
(`docs/_internal/project-map/designs/multi-model.md`); until aliases exist,
raw refs with parent-model inheritance (the shipped `spawnModel` /
`delegateModel` mechanics) are enough for a v1.

Escalation is a transition policy, not static configuration:

```yaml
- id: patch
  model: cheap
  onFail: { retry: 2, escalate: { model: strong, retry: 1 }, then: ask_user }
```

The cheap model gets two verified attempts; persistent verifier failure
escalates the same node to the strong model; only then does the workflow ask
a human. Most executions stop at the cheap tier, so cost scales with
difficulty rather than with task count.

Phase honesty: the ladder only exists once nodes run as separate episodes
(P3+). P1 is single-run, single-model — it delivers the three guardrail wins,
not the cost curve. The economics thesis is the destination narrative, not a
P1 deliverable.

Honest ceiling: **verifier strength bounds how far cheap models can go.**
Fact-based verifiers cover engineering nodes (tests, builds, artifacts,
diff scope); they do not cover semantic quality ("is this research summary
correct"). Nodes whose success cannot be fact-verified must be explicitly
marked and routed to strong models or humans — the workflow makes that
boundary visible instead of pretending it away. Conversely, over-rigid rails
suppress strong models; guardrail intensity stays a host policy over the same
asset (strong model: Stop gate only; weak model: full allowlists plus
explicit next-action injection).

### Telemetry and the iteration loop

Every workflow run leaves a canonical trace, so iteration can be
data-driven rather than anecdotal: per-node first-pass rate, retry counts,
escalation triggers, verdict distributions. High retry rate on `diagnose`
means fix that node's prompt or narrow its tools, then version the asset.
Workflow versions ride the skill-evolution proposal/history/restore
machinery rather than a new mechanism. The same fixtures double as the
model-swap regression suite. (Telemetry aggregation itself is post-P2 work;
P1/P2 only need to ensure `workflow.*` trace events carry enough facts to
aggregate later — consistent with the skill-telemetry "durable vs cache"
rule.)

### Node execute kinds reuse existing governed primitives only

`model` (default: normal model turns under the projection), `task`
(background task, awaited semantics via the existing revival spine),
`delegate` (configured delegate agent), `command` (TracedProcessRunner),
`human` (approval primitive). The workflow engine itself never causes side
effects — only governed primitives do (actor-inbox red line).

### State and persistence (phase-scoped: this section is mostly P2)

Phase scoping first, because this section otherwise reads like P1 work:

- **P0 — schema reservation only.** The record fields below (identity,
  version pinning, the `wait.kind` discriminator) are reserved at schema
  level; nothing writes them.
- **P1 — live in-memory state only.** The projection closure holds
  position / attempts / verdict refs in memory; **no record store
  exists** — decision 14 explicitly forbids front-loading one. Version
  pinning applies at P1 only as "instantiation compiles a snapshot and
  never re-reads the folder mid-run".
- **P2 — implemented locally.** `WorkflowRunRecord`, `FileWorkflowStore`
  (on the S1 doc-store primitive), cross-run resume, and resume
  re-verification now write/read durable workflow state under
  `workflow-runs/`. Fresh runs and resume adoption both hold the same
  single-writer lease; terminal fallback writes run after the host supervisor
  has decided the chain is finished, and supervisor rejects terminalize the
  workflow record before lease release.

`WorkflowRunRecord` mirrors `TaskRecord` conventions: branded id, status
(`running | waiting | completed | failed | cancelled` — the five-value
enum is final; states like needs-input are expressed as `waiting` plus a
`wait.kind: "input" | "task" | "approval"` discriminator, never new
top-level statuses), current `nodeId`,
`attempts` per node, `evidenceRefs` (trace span ids, artifact paths, task
outputRefs — references only; trace stays an audit projection, never a bus),
verdict log, transition log. P2 additionally records run refs for adopted
episodes and fact refs for verifier results; no trace payloads are copied into
workflow state. Stored by a `FileWorkflowStore` beside `FileTaskStore`. This
is the durable layer above the deliberately non-durable
`waiting_tasks` live state: if the process dies, the workflow document knows
it was at `patch`, attempt 2, waiting on task_xyz; resume = new run + fresh
node projection.

Three rules the record must carry from day one:

- **Identity contract (decision 21).** The shipped notification payload
  base reserves `workflowId`; it is the **instance** id:
  `payload.workflowId === WorkflowRunRecord.id`. Asset identity never
  travels on the wire as an id — it lives only in the pinned
  `{assetName, version, contentHash}` snapshot. The internal branded type
  may stay `WorkflowRunId`; the protocol field name follows the shipped
  code.
- **Version pinning.** Instantiation snapshots `{assetName, version,
contentHash}` (ideally the compiled definition too) into the record. A
  multi-day workflow must not change semantics because someone edited the
  asset folder mid-flight; resume resolves the pinned snapshot, never the
  live folder. The whole versioning/canary/rollback story depends on this.
- **Resume re-verification (trust but re-verify).** A node's verifiers are
  its postconditions, and postconditions can be re-run. On resume, re-run
  completed nodes' command verifiers whose latest stored verdict passed
  (`verifyOnResume: true` default): all pass → the recorded position is
  trustworthy; a regression → the drift is a fact and transition policy decides.
  Free corollary: entry verification
  lets a node be skipped when its postcondition already holds — workflows
  become re-entrant and idempotent by construction, with zero new mechanism
  beyond the existing verifier vocabulary. P2 persists the policy as
  `resume.verifyOnResume` and defaults it to true.

### Relationship to skills

Skill = soft guidance (what the model should know). Workflow = external
execution control (how the task must advance and verify). A skill may
recommend a workflow; a node may load skills. Because workflows are markdown
assets, skill-evolution's proposal/history/restore machinery can later manage
workflow iteration — versioning/evaluation/replay ride existing rails.

## Addendum: Code-First Evolution (2026-07-03 brainstorm)

A second brainstorm wave sharpened the end state. None of it changes the
P0–P2 entry path, but it changes the destination narrative and forces the
folder-asset decision above.

### The inversion: model as exception handler, two execution planes

End state: the **workflow actor is the only resident; model runs are
transient episodes it spawns on demand.** Two node planes:

- **deterministic plane** — `script` / `command` / `task` nodes advance the
  workflow with zero model cost ("cruise mode");
- **model plane** — `model` nodes are episodes created when a verifier fails
  or an exception fires, carrying the full per-node projection (context
  injection, capability clamp, verifier gates).

Cruise mode is effectively level 0 of the escalation ladder: no model →
cheap model → strong model → human. Shape C's "projection inside a run"
remains the P1 entry (cheapest to build, reuses verification.ts); the
inversion is the P3+ destination once the workflow actor and durable store
exist. Human intervention (interrupt, re-scope, skip node) is an event
submitted to the actor and consumed at the next node boundary — nothing
blocks, nothing suspends.

### Script nodes and the node API boundary

Scripts (python/shell/rust/...) are first-class node implementations and the
workhorses of the deterministic plane, but two red lines hold:

- **Scripts never write trace.** Trace stays an audit projection
  (actor-inbox red line; traced-process-runner already restricts external
  processes to constrained stderr progress tokens for exactly this reason).
- **Scripts never hold capabilities directly.** They talk to the host over a
  bounded **node API** (stdio JSON-RPC, shaped like reverse MCP): report
  progress/results, request primitive invocations (agent, MCP, ACP, command).
  The host executes requests through governed primitives — policy, approval,
  and access mode gate script-initiated actions the same as model-initiated
  ones — and projects node activity to trace itself.

### Shadow mode (陪跑) and teacher-forced replay

- **Shadow mode**: a draft workflow attaches to a normal session as a
  non-blocking event subscriber (the existing `capabilities.hooks.events` /
  `bindConfiguredEventHooks()` lane), matching observed trace events against
  its node structure and recording divergences. Pure event matching — zero
  token. Only the offline "turn observations into a revision proposal" step
  needs a (cheap) model; that is the online form of `workflow distill`.
- **Teacher-forced replay**: generalize the deterministic model stubs already
  used in examples/QA to tool-result fixtures. In replay mode a node's tool
  calls are answered from recorded fixtures, skipping live services and
  expensive operations. Record real trajectory → replay → edit nodes →
  replay and diff verdicts: a zero-cost, side-effect-free self-evolution
  loop for workflow debugging.

### Workflow-directed context governance

Node boundaries are natural compaction points: on transition, the previous
node's working context degrades to an evidence summary (verdict +
evidenceRefs); only the summary enters the next node. This rides the
existing compaction substrate and upgrades pruning from generic heuristics
to process-informed policy — the "kill useless turn context on demand" idea
with a deterministic trigger.

### Vendor-independence exports

- **Private eval**: workflow + fixtures = model admission regression (already
  in Design); fixtures distilled from the org's own trajectories make the
  eval measure business contribution, not leaderboard rank.
- **RL-environment export**: fact-based verifiers are reward functions;
  teacher-forced replay is an offline gym. SparkWright does not train models
  (out of scope), but exporting `(trajectory, node-verdict sequence)` pairs
  from canonical traces is nearly free — reserve an export interface, no
  more.
- **Not this feature**: a queryable organizational knowledge base is an
  adjacent memory/RAG capability. Workflow state and distilled assets are a
  form of org memory, but KB querying stays out of scope (see Non-Goals).

## Planning Addendum: Relationship, Failures, and Deterministic Graphs

This planning slice captures the follow-up questions from the integration
review. It does not expand P1/P2 scope. It names the boundaries that must stay
true once workflow grows from single-run projection into an actor-owned graph.

### Relationship modes

Workflow and the main agent should be modeled as explicit modes, not an
ambiguous shared control loop:

- **normal run** — no workflow. The main agent owns execution under the normal
  run loop.
- **shadow workflow (陪跑)** — a draft workflow subscribes to run events through
  the non-blocking event lane, matches observed behavior against nodes, records
  divergences, and never injects context, changes tools, blocks Stop, or writes
  workflow state that claims control.
- **supervised workflow** — the workflow projection controls the active node
  inside a normal run: TurnStart guidance, PreToolUse clamps, PostToolUse
  evidence capture, Stop verifier gate, and `advance` for healthy node
  transitions.
- **actor-owned episodes** — P3+ destination. The workflow actor is resident;
  model/delegate/task/command episodes are transient workers started only when
  the current node needs them. The actor owns node position, attempts,
  evidence, transitions, and resume.

This keeps the product semantics crisp: the agent executes; the workflow
controls process state and evidence. P1 starts with supervised projection
because it reuses the existing run loop. P3+ moves ownership to the workflow
actor only after durable state exists.

### Runtime error taxonomy

Workflow failures must be typed before implementation so control-plane errors
cannot be mistaken for ordinary verifier failure or model prose:

| Class                     | Examples                                                                           | Handling                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Definition error          | invalid schema, duplicate node id, transition target missing, unsupported verifier | Reject at parse/instantiate time; do not start a workflow run.                                   |
| Binding error             | missing instantiation variable, unsafe command binding, unbound artifact path      | Fail instantiation or current node before model/tool execution; record a workflow error fact.    |
| Verifier failure          | command non-zero, diff out of scope, missing artifact, task failed                 | Normal node verdict; transition policy decides retry/escalate/ask/fail.                          |
| Node runtime failure      | script process crash, command timeout, delegate error, task cancellation           | Record node failure with evidence refs; transition policy decides recovery.                      |
| Projection failure        | workflow hook throws, illegal lifecycle effect, node clamp cannot compile          | Fail closed for governing hooks; record `workflow.runtime_error` and stop or ask human.          |
| State persistence failure | `FileWorkflowStore` write/read/lock failure                                        | Interrupt or fail closed; never continue while pretending durable state was saved.               |
| Resume drift              | completed node verifier no longer passes, pinned asset snapshot unavailable        | Treat as a fact; re-run postconditions when possible, then transition by policy.                 |
| Host/process crash        | process exits while workflow is running/waiting                                    | P2+ resumes from `WorkflowRunRecord`; live `waiting_tasks` is re-derived or orphaned explicitly. |

Terminal workflow status should distinguish user/business failure from runtime
failure, e.g. `failed` with `failure.kind: "verdict" | "runtime" |
"cancelled" | "definition"`. The run outcome should still follow the existing
doctrine: facts first, no model-prose completion detection.

### Deterministic graph execution

The code-first destination is not "the main agent reads a flowchart and spends
tokens following it." It is a workflow actor driving a mostly deterministic
graph, with models invoked only for exceptions, semantic decisions, or nodes
that explicitly require model work.

Supported node families should evolve in this direction:

- `command` — host-run command through `TracedProcessRunner`; verifier facts
  come from exit code/output artifacts.
- `script` — workflow asset script over the bounded node API; scripts report
  progress/results and request governed host primitives, but never write trace
  or hold raw capabilities.
- `task` — background/awaited work using the existing task store and revival
  spine.
- `delegate` — configured delegate or agent episode, with child capabilities
  narrowed from the workflow node.
- `model` — transient model episode with the full node projection.
- `human` — explicit approval/input/override boundary.
- `parallel` / `join` — bounded fan-out and barrier semantics, built only
  after durable branch state exists.

The graph contract must include replay/idempotency metadata before parallel
execution ships:

- whether a node is safe to re-run;
- where outputs/evidence are stored;
- which verifiers are postconditions;
- which side effects are governed by approval/access mode;
- how cancellation propagates to active branches;
- how a partial branch set resumes after crash.

Minimal graph example:

```yaml
nodes:
  - id: scan
    execute: script
    script: scripts/scan-repo.mjs
    verify:
      - kind: artifact_exists
        path: .sparkwright/workflows/reports/scan.json
    onPass: checks
    onFail: diagnose

  - id: checks
    execute: parallel
    branches: [lint, typecheck, unit]

  - id: lint
    execute: command
    command: npm
    args: ["run", "lint"]
    onPass: join_checks
    onFail: diagnose

  - id: typecheck
    execute: command
    command: npm
    args: ["run", "typecheck"]
    onPass: join_checks
    onFail: diagnose

  - id: unit
    execute: command
    command: npm
    args: ["test"]
    onPass: join_checks
    onFail: diagnose

  - id: join_checks
    execute: join
    waitFor: [lint, typecheck, unit]
    onPass: summarize
    onFail: diagnose

  - id: diagnose
    execute: model
    tools: [read, grep, edit, bash]
    onPass: checks
```

Phase discipline:

- P3 can add `command` / `task` / `delegate` / `human` nodes without general
  graph parallelism.
- P4 can add `script` nodes and the bounded node API.
- P5 can add bounded `parallel` / `join` over durable branch state, reusing
  background tasks or delegate fan-out instead of introducing a second
  scheduler.

### Self-update contract

Workflow assets can evolve from shadow observations, telemetry, and replay,
but a running instance must never mutate its own effective definition.

Allowed path:

```text
trace/shadow/telemetry
  -> distill revision proposal
  -> replay/fixtures/eval
  -> human or policy review
  -> new asset version
  -> canary/new runs
```

Disallowed path:

```text
running workflow edits live asset folder
  -> current instance silently changes semantics
```

Every workflow run pins `{assetName, version, contentHash}` and ideally the
compiled definition snapshot. That pin is what makes resume, canary, rollback,
and model admission tests trustworthy.

## Phased Plan

Follow the hooks-control-plane precedent: inspection first, behavior later.

- **P0 — asset format + inspection.** Parser/validation for workflow
  markdown, `capabilities` snapshot exposure, `sparkwright workflow
list/inspect`. Zero runtime behavior change; pins the asset schema. Also
  reserves, at schema level, the `workflow.*` trace-event vocabulary, the
  run-record version-pinning fields, and — because the actor-inbox unions
  are already shipped code — a reliable `waiting`/`input_required` member
  in the workflow notification union (P3 human nodes need it;
  protocol-changelog discipline is cheapest before any emitter exists).
  P0 also adds the hook assembly-order regression test at the `runtime.ts`
  assembly point: decision 19's configured-before-projection order is de
  facto true today but guarded by nothing. Cheap stake for decisions
  19–20 in the same test file (fifth pass): pin today's
  `enforceWorkflowHookEffect` surface (advance only for ModelOutput/Stop,
  configured-action coverage) so the P1 workflow-active `advance`/temporary
  `rewrite` rejections extend a guarded surface instead of landing unguarded;
  P10a later replaced the rewrite rejection with staged PreToolUse.
- **P1 — single-run linear workflow, model nodes only.** Two entry
  conditions (Accepted Slice): the FactLedger prerequisite refactor
  (independently testable, no workflow dependency — extract from
  run-outcome's classification primitives, switch the verification Stop
  gate to read it, decision 13), and S3 ratified + generalized (the
  per-source forced-turn budget this projection consumes, decision 14). Entry surface is
  CLI/config only (`sparkwright run --workflow <name>`, decision 11); no
  model-facing instantiation tool yet. Instantiation compiles the active node
  into TurnStart injection + Stop verifier gate + PreToolUse clamp under the
  projection-mechanics contract (stateful hook closure, verdicts referencing
  FactLedger facts, the implemented `advance`/violation distinction,
  generalized continuation budget) and the hook assembly contract
  (decisions 19–20); in-memory state + `workflow.*` trace events. P1
  transition vocabulary is `retry` / `goto` / `fail` only: `ask_user` and
  `human` nodes are deferred to P3 — P1 has **no input/waiting
  behavior at all** — a definition that references `ask_user` or a `human`
  node is rejected at instantiation as a definition error (nothing
  half-waits; "waiting + user re-invokes" is resume semantics and belongs
  to P2/P3). The `waiting` + `wait.kind` vocabulary is only _reserved_ at
  P0 (decision 21); its first emitter is P3's `human` node.
  Delivers the three hottest wins (anti-self-completion, weak-model
  guardrails, structured failure feedback) by generalizing verification.ts's
  compilation pattern — while replacing its event-log evidence source
  (decision 13).
- **P1.5 — deletion payoff (release gate, not an optional follow-up).**
  P1 landed behind an experimental flag and knowingly added a hook producer;
  P1.5 satisfies rule zero by deleting the two old live gate producers before
  removing the flag. D25 corrects the sixth-pass finding that the first P1.5
  implementation shaped verification profiles and documented-command as
  one-shot single-node workflows, which is not equivalent to a run-level
  latest-write invariant. P1.5 therefore has two live producer families after
  deletion: user-configured rules and host-owned projections. Selected workflow
  assets use the linear workflow projection; built-in verification and
  documented-command use invariant projections that share verifier execution and
  FactLedger evidence, but not the linear state machine or asset syntax. This is
  how the hook-composition problem is resolved — by deletion plus a narrower
  built-in invariant projection, not by an arbitration rule set. Scope note
  correction (sixth pass): the earlier statement that `workflowHooksForProfile`
  already compiled verification hooks for delegate child runs was source-false;
  prior code compiled profile-authored hooks only. P1.5 does not install global
  verification/documented-command invariants into delegate child runs unless a
  future opt-in feature adds a separate cost model. Second scope note (fifth
  pass): live/new `verification:<profile>:<id>` hookName consumers migrate to
  the FactLedger / verification-result snapshot. `analyzeVerificationProfileResults`
  and the CLI exit path read the ledger first and retain hookName scanning only
  for old trace compatibility, so profile verdicts do not silently disappear
  when the old gates are gone. Third scope note (post-review P1.5 closure):
  documented-command live verdicts also must not retain a separate CLI post-run
  scanner; CLI status and exit code follow the same outcome snapshot as
  invariant verifier failures.
- **P2 — durable state + cross-run resume.** Prerequisite: extract a small
  shared session-root document store module in agent-runtime (atomic write,
  single-writer lease, corrupt-entry-skip diagnostics — the patterns
  `FileTaskNotificationOutbox` already had to invent locally) so
  `FileWorkflowStore` does not become the Nth file store with hand-rolled
  reliability. Then `FileWorkflowStore`; workflow
  actor notifications through the shipped actor-inbox unions (whose
  `workflowId`/`TaskError` contract decision 21 already pins). P2 also
  owes the resume **user surface**: `sparkwright workflow list` /
  `sparkwright workflow resume <workflowRunId>` — decision 14's "the CLI
  rerun is enough" holds for P1's in-memory state, but once a durable
  record exists the CLI must be able to find and adopt the interrupted
  instance in the session root (single-writer lease prevents double
  adoption).
- **P3 — node kinds beyond model + actor-owned episodes.** Entry condition:
  P2 merged to main. `command` / `task` / `delegate` / `human` nodes land only
  after their runner semantics are explicit: non-model nodes are executed by
  host-owned governed primitives at node boundaries, not degraded into "model
  node with hints." `diff_scope` also lands here with the node-entry epoch
  marker it requires. Step 2 must first decide the `task_terminal` ordering
  contract. Decision: keep the existing order where Stop hooks run **before**
  `waitForAwaitedTasksBeforeTerminal` in `run.ts`; a Stop-time
  `task_terminal` verifier reads pre-await state and pays one extra forced
  turn per wake. Do not move the await gate ahead of Stop in Step 2.
  Waiting semantics reuse `waiting_tasks` + an awaited predicate, but D21's
  `waiting` notification member is reliable, so P3 Step 3 must define a
  durable waiting/outbox contract before the `human` emitter ships. D18 is a
  gate before actor episode spawning, not a P3 entry condition: Step 1 proves
  the host supervisor todo-continuation chain can be expressed as a degenerate
  workflow, and Step 4a uses that proof before the actor-owned episode driver
  ships and retires `startSupervisedRunChain`. The result is one run-chain
  driver instead of three owners of "create the next run" (core continuation,
  `startSupervisedRunChain`, workflow episodes).

## Non-Goals

- No general DAG/BPMN engine; v1 transitions are a verdict -> target-node
  lookup table, no expression language.
- No node-level parallel scheduler in v1. Bounded `parallel` / `join` is a
  post-P3 graph-execution slice and should reuse `delegate_parallel` or
  background tasks for fan-out.
- No second matcher/action vocabulary — reuse the hooks control plane's.
- No workflow-to-workflow messaging; notifications are lifecycle/observation
  records per the actor-inbox contract.
- No capability widening: node clamps narrow the run's governed surface,
  never bypass access mode, policy, or approvals.
- No raw trace/tool access for node scripts: all script side effects route
  through the host node API and governed primitives.
- No queryable knowledge base / RAG surface inside workflow scope.
- No in-process model training; RL support ends at trajectory/verdict
  export.

## Wild Ideas (parking lot, not commitments)

- `sparkwright workflow distill <sessionId>`: mine a successful trace for its
  phase structure and emit a draft workflow through the skill-evolution
  proposal review flow — assets grown from winning traces instead of
  hand-written.
- Guardrail intensity as host policy: same workflow asset, strong models get
  only the Stop gate, weak models additionally get PreToolUse allowlists and
  explicit next-action injection.
- TUI: workflow node progress (`reproduce > diagnose > patch > verify`) as
  another row in the activity panel that just learned to show tasks.
- Todo ledger as a free first verifier signal (`todo_clear`).
- Unattended/service mode: `human` nodes degrade to timeout + default
  transition; any worker process can adopt an interrupted workflow from its
  durable document (this only works because state is a document, not live run
  memory — a retroactive argument for Shape C over pure in-run constraint).
- Workflow benchmark harness: run a workflow's fixtures against a candidate
  model and report node-level pass/retry/escalation stats as the model
  admission gate.
- Self-hosting pilots: rebuild plan mode and the todo doctrine as workflow
  collections (verification profiles are already a proto-workflow) —
  dogfooding that validates the substrate on non-general, fixable flows.
  (Upgraded by the second review pass and corrected by the seventh: the
  supervisor/todo case is now the D18 gate before actor episode spawning,
  not a parking-lot idea and not a circular P3 entry condition.)
- "Workflow intelligence" (which tool when, what order, which checks, how to
  deliver) is not a new component: it is the emergent output of shadow-mode
  observations + node-level telemetry + distill, sedimented as asset
  revisions.

## Recommended Decisions (2026-07-03, pending user confirmation)

Former open questions, each resolved to a recommendation with rationale.
None are implemented yet; contradicting source facts found during
implementation reopen them. Decisions 1–10 are the first pass; 11–18 came
out of the same-day second review pass (source-verified against `run.ts`
and `verification.ts`). The third pass (2026-07-04, map-driven) revised
13/14/16 and added 19–20 after verifying the hook merge semantics
(first-terminal-wins, post-gate rewrite application) in
`runWorkflowHooks` / `run.ts`. The fourth pass (2026-07-04,
user-confirmed, verified against the `feat/background-agent-jobs` working
tree) added 21–24: two are forced by facts that reached the protocol layer
(the shipped actor-inbox unions, the verified `RuntimeSignal`/`RunEnd`
emission surface), two close doctrine holes (verifier expectation
polarity, projection fail-closed). The sixth pass (2026-07-04, post-review)
adds 25 after verifying that P1.5's first implementation treated run-level
verification invariants as one-shot workflow nodes and weakened the latest-write
gate.

1. **Ownership split — follow the `tasks/` precedent exactly.**
   `agent-runtime/src/workflows/`: portable types (`WorkflowDefinition`,
   `WorkflowRunRecord`), the pure transition state machine
   (`(state, verdict) -> transition`), `WorkflowStore` +
   `FileWorkflowStore`, verdict types. Host: asset folder
   discovery/parsing (agent-profiles.ts precedent; parsing touches
   config-zod-schema and capability snapshots), node projection compilation
   (generalizing `createVerificationWorkflowHooks()`), node API server,
   CLI/snapshot exposure. No new `packages/workflows` package in v1
   (edge-packages rule: extract only after repeated work justifies it).
   Core: zero changes in P0. The core surface P1 depends on, accounted
   honestly (consolidation-sweep rewrite; supersedes the earlier "exactly
   three" claim): the advance/violation continuation distinction
   (decision 12) is **already in the feature-branch substrate**, not P1
   work; the FactLedger is the **S2 prerequisite** (decision 13); the
   per-source forced-turn budget is the **S3 prerequisite** — workflow is
   a customer, not the implementer (decision 14); and P1 owns exactly
   **one** narrow core prereq of its own, `cancel()` kicks
   `RunEnd(state: "cancelled")` (decision 24). P1 itself implements only
   the host projection and its use of the portable workflow state
   machine; core stays workflow-unaware. Asset folder parsing should extract and reuse a shared
   markdown-folder-asset primitive (skills package contentHash +
   agent-profiles frontmatter scanner are already the second and third
   copies) rather than adding a fourth parser. P2 awaited predicate reuses
   the `NotificationSource` / `TaskRevivalSource` shapes.
2. **Node tool clamping — PreToolUse enforcement in P1, no catalog
   change.** `PreToolUse` block already synthesizes a failed `ToolResult`
   (`TOOL_BLOCKED_BY_WORKFLOW_HOOK`) and the run continues — out-of-node
   calls become model-correctable structured feedback. TurnStart injection
   states the allowlist softly. True catalog narrowing waits for episode
   boundaries (P3+), where per-episode catalogs already have the delegate
   child-run precedent; mid-run dynamic tool lists would touch the run loop
   and are avoided.
3. **Verdict vs run-outcome — two axes, one crossing point.** Node verdict
   failures are workflow-internal signals (retry/escalate) and never taint
   the episode's run outcome. Only a workflow terminal `failed`, when the
   workflow is the run's goal (P1 in-run mode), maps to `failing` — via the
   existing verification-failure projection, fed by the `workflow.failed`
   fact event. No prose detection. Verifier-launched commands are
   interpreted by expectation satisfaction, not raw exit code — see
   decision 22 for the crossing-point rule this requires.
4. **Template variables — instantiation-time binding only.** Inter-node
   dataflow: model plane via context injection; script plane via node API
   `getEvidence(nodeId)`. No expression language (the first domino toward a
   DAG engine).
5. **State location — session root, sibling of the task store
   (`workflow-runs/`).** One storage universe, one `--session-root`
   plumbing story. Lifting to a workspace root is a P3+ cross-session
   concern, decided then. First real customer registered (2026-07-05):
   the detached/service adoption scenario — a spawned workflow instance
   outliving its firing session and adopted by another process via the
   store lease. Decide the lift together with the unattended slice, one
   payment; session-root remains sufficient for the whole P3 shape
   (in-session firing + handle await + background promotion).
6. **Escalation budget — fresh per-attempt budget, workflow-level total
   cap.** Inheriting leftovers starves the strong model after the cheap
   model burned the allowance. Usage attribution: record raw model ref +
   usage snapshot per attempt in `WorkflowRunRecord` (facts now, aggregate
   later); do not block on multi-model's deferred per-tier keying.
   P3 Step 4b.2 lands the worker-entry portion of this decision: model nodes
   may declare `model` and `runBudget`, host resolves the current node's model
   adapter before `createRun()`, applies the node budget to that worker, and
   records episode + usage facts. The retry/escalation policy itself requires
   a later model-node boundary split so a retry can start a fresh worker with a
   stronger model instead of continuing inside the same core run.
   **Reopen condition (C4, 2026-07-06):** retry-time model upgrade and cruise
   policy reopen only after internal dogfood workflow assets, especially the P4
   probe ladder family, produce retry-rate evidence. No schedule is accepted
   without that evidence.
7. **Probe ladder (one variable per step):** ① one node + one command
   verifier + nano/haiku via CLI QA harness → ② two-node linear transition
   → ③ onFail retry → ④ PreToolUse clamp compliance → ⑤ escalation ladder.
   Step ① failing halts the ladder.
8. **Node API transport — stdio JSON-RPC child protocol; no in-process
   sdk-node.** Scripts are language-arbitrary; in-process only serves JS.
   `TracedProcessRunner` already owns child processes and the `stdio-v1`
   stderr telemetry protocol — the node API is that family's next member
   (JSON-RPC on stdin/stdout, telemetry stays on stderr). Sandbox: reuse
   shell-sandbox tiers; the asset manifest declares needed capabilities,
   host maps them to the access clamp.
9. **Episode lifecycle — host runtime owns it, delegate child-run
   precedent.** The portable state machine decides _that_ an episode is
   needed and with what projection; host executes `createRun` and streams
   lifecycle back as notifications. agent-runtime keeps zero model/config
   dependencies (actor-inbox working assumption verbatim).
10. **Node-boundary compaction — caller of the existing compaction
    substrate, not a new stage.** Workflow contributes the trigger (node
    transition) and the selection policy (drop node working context, keep
    verdict + evidenceRefs summary). P2 verification result: the existing
    compaction substrate can express the needed span-to-summary shape through
    caller-selected source spans and an explicit summary artifact/context item;
    no new compaction stage is required in P2. Implementation remains deferred
    until a later phase decides when node-boundary compaction should run.
    **Reopen condition (C4, 2026-07-06):** wiring node-boundary compaction
    reopens only after the first real workflow failure whose cause is context
    growth across node boundaries. The trigger is evidence from a failing
    workflow, not a speculative cleanup pass.
11. **Instantiation surface — CLI/config only in P1.** `sparkwright run
--workflow <name>`: deterministic, directly testable by the CLI QA
    harness (probe ladder ①). A model-facing `workflow_start` tool is a new
    capability surface with its own governance questions; defer it to the
    P3 episode-boundary decision. Decision 26 pre-binds the constraint
    envelope that decision must satisfy. P3 Step 4b.3 resolves this deferment
    by **not** shipping the model-facing tool in P3: the current runtime keeps
    CLI/config/protocol request instantiation as the only live surface and
    leaves `workflow_start` for a future spawn-mode slice.
12. **Stop continuation semantics — advance vs violation, in core.**
    Implemented as the workflow-agnostic `advance` hook result for
    `ModelOutput` / `Stop`. P1 should build on this instead of reintroducing
    block-as-advance. Without it every healthy node transition would be
    recorded as a blocked hook — a trace fact that lies. The todo-continuation
    doctrine is the second customer.
13. **Verdict evidence — a core FactLedger is the single fact substrate;
    workflow verdicts reference it, never copy it.** (Revised by the third
    pass; supersedes "written to workflow state at PostToolUse".) See
    projection mechanics §3. The event-log scan is the one part of
    verification.ts that must not be generalized — but the replacement is a
    shared core ledger (fact-classification primitives extracted beside
    run-outcome, applied incrementally in-run), not a workflow-private
    evidence store that would become the fifth extractor and reintroduce
    staleness. v1 staleness: coarse global write epoch — any workspace
    write invalidates command facts; false-stale re-runs the verifier,
    false-fresh is impossible. Online extractors converge 3→1
    (verification scan, run-health, would-be workflow state); offline
    trace-diagnostics keeps its recompute path over the same shared
    classifiers and prefers the persisted ledger snapshot when present.
    The FactLedger lands as a P1-prerequisite refactor with the
    verification Stop gate as its first customer, independently testable
    before any workflow code exists.
14. **Budget — workflow is a customer of S3; P1 position durability is
    live-process-only.** (Revised by the third pass; mechanism ownership
    moved to `substrate-sequencing.md` S3 after the hardening pass.) The
    budget mechanism is **not specified here**: S3's annex owns the
    end-state (work budget vs in-run forced turns vs run-chain caps —
    three altitudes), and this decision retains only workflow's
    constraints: no new bespoke axis; workflow-forced turns consume the
    `workflow` source budget, never `maxSteps`; the run-chain cap stays
    out (decision 18); P1 does not start before S3 is ratified and
    generalized (Accepted Slice entry condition). Interruption facts go
    to live workflow state plus an audit-only `workflow.interrupted` trace
    event; capture surfaces per decision 24, split by family (work-budget
    exhaustion = `RunEnd(state: "failed")` today; forced-turn exhaustion =
    S3 per-source `budget.exceeded` facts; cancellation needs decision
    24's narrow core change). Honest P1
    contract: position survives interruption within a living process; a
    process crash loses it (CLI-only entry makes that a rerunnable
    command). Resume never reads position back from trace — trace is an
    audit projection, not a bus. Do **not** front-load a minimal
    `WorkflowRunRecord` store into P1: that would create a store dependency
    before the P2 shared document-store module exists and manufacture the
    exact debt P2 is sequenced to avoid.
15. **Version pinning — instantiation snapshots asset identity into the
    record.** `{assetName, version, contentHash}`; resume never re-reads
    the live folder. Prerequisite for every canary/rollback claim in the
    Purpose section.
16. **Verifier commands — whole-argv-token bindings plus instantiation-time
    authorization.** (Revised by the third pass to add the trust
    boundary.) Two layers, each covering what the other cannot:
    - _Binding injection_: whole-argv-token substitution only, no shell
      string interpolation; a model-supplied binding must not smuggle shell
      syntax into a fact verifier. The `run: "npm test -- {{failing_test}}"`
      sketch above is shorthand — the real schema is command + args array.
    - _Asset trust_: a workflow asset's `verify.command` is an
      asset-declared host command — a downloaded workflow must not be able
      to run arbitrary commands just because bindings are safe. Verifier
      commands execute under the same shell-sandbox / access-mode policy as
      model-initiated `bash`. And because they run inside a hook gate,
      which **cannot prompt for approval** (the established agent-hook-action
      constraint), authorization must be resolved at instantiation time:
      the asset manifest declares its commands/capabilities, and
      instantiation either authorizes them all under the current
      policy/trust level or refuses to start the workflow. There is no
      per-execution interactive fallback.
17. **Resume re-verification — `verifyOnResume: true` by default for
    command verifiers.** Completed nodes' postconditions are re-run on
    resume; drift is a fact for transition policy, and a satisfied entry
    condition allows node skipping. Workflows become re-entrant with zero
    new mechanism.
18. **Run-chain ownership gate before actor episode spawning.** P3 entry is
    P2 merged to main; this decision is not a circular entry condition. The
    supervisor todo-continuation chain must be expressible as a degenerate
    workflow before the workflow actor ships episode spawning. P3 maps that to
    Step 1's exit gate and Step 4a's entry gate so the codebase converges on
    one run-chain driver, not three (core continuation,
    `startSupervisedRunChain`, workflow episodes).
19. **Hook assembly — governance before projection; the projection is the
    sole `advance` owner.** (Third pass.) Because `runWorkflowHooks` is
    first-terminal-wins in array order (Current Facts), "user rules can
    stop the workflow"
    is only true if assembly order makes it true. Two host invariants at the
    `runtime.ts` hook-assembly point:
    - _Ordering_: user/safety configured rules always precede the workflow
      projection in the hooks array; the projection is last. A user `block`
      therefore short-circuits the projection's `advance` that firing —
      safe, because verdict evidence is captured at `PostToolUse`
      (decision 13), the Stop gate is a pure read, and the projection
      simply re-evaluates at the next Stop.
    - _Exclusivity_: while a workflow is active, `advance` belongs to the
      projection alone. Configured hook actions returning `advance` are
      rejected at compile time — extend `enforceWorkflowHookEffect` with a
      source × workflow-active dimension — not arbitrated at runtime.
      When no workflow is active, configured hooks keep their existing
      `advance` capability (the todo-continuation doctrine remains the
      second customer). Scope: per-run; P1 does not project into delegate
      children, so profile hooks are unaffected.
20. **PreToolUse compatibility — staged rewrites before workflow
    governance.** (Third pass; updated by P10a.) The original risk was that
    single-pass rewrites applied after a workflow clamp had approved
    pre-rewrite payloads, so a configured rewrite could move a path/argument
    outside the node scope with no re-check. P1 therefore shipped a temporary
    structural prohibition while a workflow was active. P10a retires that
    prohibition by making tool-call `PreToolUse` a staged core gate:
    normalize/rewrite first, apply argument rewrites, then run
    governance/clamp hooks over the rewritten args. Decision 19's `advance`
    exclusivity remains unchanged.
21. **Workflow instance identity and the shipped notification contract.**
    (Fourth pass.) The actor-inbox unions are live code with a reserved
    `payload.workflowId`; this proposal stops letting readers guess what it
    means. Ruling: `payload.workflowId === WorkflowRunRecord.id` — the
    **instance** id. Asset identity never rides the wire as an id; it lives
    only in the pinned `{assetName, version, contentHash}` snapshot. The
    internal branded type may stay `WorkflowRunId`; the protocol field name
    follows the shipped code. Second half of the contract: terminal
    `failure.kind` (`verdict | runtime | cancelled | definition`) maps into
    the shipped `TaskError` as a namespaced `code`
    (`workflow.verdict`, `workflow.runtime`, ...) — no type change, and the
    error taxonomy survives the wire losslessly. Third half: the missing
    waiting/input-required signal is a **new union member**
    (`type: "waiting"`, payload carries `wait.kind`), qos **reliable** —
    it must not be expressed as `progress` metadata, because progress is
    qos `lossy` and a dropped "waiting for input" notification is a
    silently hung workflow. P0 reserves the member; P3's `human` node is
    its first emitter.
22. **Verifier expectation polarity — facts are raw, expectations live in
    the verifier layer, run-outcome reads satisfaction.** (Fourth pass;
    channel corrected by the fifth.) An `expect: nonzero` verifier (the
    reproduce node) intentionally runs failing commands. Fifth-pass
    correction: the live taint channel is **not** the former compact command
    snapshot — it never sees hook-launched commands — but
    `analyzeVerificationProfileResults`' hookName-metadata channel and its
    CLI exit-path consumer (Current Facts, two-channel bullet). Either
    way, decision 3's "verdicts never taint run outcome" was silently
    false at the command-fact layer.
    Three-part rule: the FactLedger records the **raw** command fact
    (exit code, no interpretation); the verifier result records
    `expect` + `satisfied`; ledger entries carry an initiator tag
    (verifier-launched vs model-initiated), and run-outcome's failure
    projection interprets verifier-launched commands by `satisfied`, never
    by raw exit code. Model-initiated commands keep today's semantics
    unchanged. The rule binds **both extraction channels** (shell tool
    facts and hook-metadata facts). This lands with the FactLedger
    extraction (decision 13) — the initiator tag is part of the ledger
    schema from day one.
    Namespace corollary (fifth pass): projection verifier hooks must
    **never** emit under the `verification:` hookName prefix — that
    namespace is the legacy profile-result protocol with live parsers.
    The projection family uses a `workflow:`-prefixed hookName. hookName
    is static per hook object (`runWorkflowHooks` reads `hook.name`), and
    the projection is one closure family (projection mechanics §1):
    `workflowRunId` may be baked into the name at instantiation, but
    per-firing identity (`nodeId`, `verifierId`, `expect`, `satisfied`)
    rides structured result metadata / ledger facts, never the hookName.
23. **Projection hooks are fail-closed by construction, not by
    convention.** (Fourth pass.) Because hook fault isolation defaults
    open (Current Facts: `onError` defaults `"continue"`; an illegal
    `advance` is absorbed as `workflow_hook.failed`), the error taxonomy's
    "Projection failure: fail closed" turns into fail-open the moment
    someone forgets a field. Implementation
    constraint, not advice: the projection-hook constructor **forces**
    `onError: "block"` on every governing hook it emits (clamps, verifier
    gates, the Stop gate); hand-assembled projection hooks are rejected in
    review. Non-governing observers (pure context injection) may stay
    `"continue"`.
    Fifth-pass hardening — fail-closed is gate-differentiated, budgeted,
    and bounded, because "block" does not mean "stop" at every gate
    (verified in `run.ts`):
    - _Per-gate error semantics._ A blocked `RunStart`/`TurnStart` is
      **terminal** (`failWorkflowHookBlock` → `hook_stopped`); a blocked
      `PreToolUse` synthesizes a failed tool result and the run continues;
      a blocked `ModelOutput`/`Stop` **forces another turn** — fail-closed
      at Stop is a livelock, not a stop. Tests must assert per-gate
      expectations, not a generic "blocks the run".
    - _Budget accounting._ Projection-error forced turns at
      `ModelOutput`/`Stop` consume the `workflow` forced-turn source
      budget (S3) exactly like healthy advances — today `maxSteps` caps
      the livelock; once S3 moves workflow-forced turns off `maxSteps`,
      uncounted error turns would reopen an unbounded loop. This is an
      **S3 ratification-checklist item**.
    - _Bounded degradation._ The projection state machine counts
      consecutive projection runtime errors; at a threshold it stops
      gating, records a `workflow.failed` fact with
      `failure.kind: "runtime"` (→ `TaskError` code `workflow.runtime`,
      decision 21), and lets decision 3's outcome projection flip the
      run's `failing` flag. A Stop hook result cannot terminate a run
      (block = forced continuation; `failWorkflowHookBlock` is not wired
      to Stop), so terminal-failure-by-runtime-error is expressed as
      "stop blocking + fact + outcome projection", never as an infinite
      block.
      Required test coverage before P1 ships: (a) a throwing projection
      hook produces the per-gate outcome above at each gate it governs;
      (b) an illegal `advance` from a projection hook is not absorbed;
      (c) a persistently-throwing Stop projection hook exhausts the error
      threshold / forced-turn budget and ends in `workflow.failed(runtime)`
      instead of looping to `maxSteps`.
24. **Interruption capture follows the real emission surface; cancellation
    needs one narrow core change.** (Fourth pass; completes decision 14.)
    Because the `RuntimeSignal`/`RunEnd` emission surface is narrower than
    the vocabulary (Current Facts), interruption capture must follow what
    actually fires. Therefore: `doom_loop` interruption facts come from the existing
    `RuntimeSignal` hook; **work-budget** exhaustion (`maxSteps` /
    `runBudget`) comes from `RunEnd(state: "failed")` with a budget stop
    reason — while **forced-turn** budget exhaustion is S3 family 2 and
    emits per-source `budget.exceeded` facts the projection consumes
    directly (two families, two capture paths; S3 annex); and cancellation
    requires the narrow, workflow-agnostic core prerequisite that
    `cancel()` also kicks `RunEnd(state: "cancelled", reason:
"manual_cancelled")` — symmetric with the other two terminals, keeping
    RunEnd the single terminal hook (fallback, if that change is rejected:
    the projection closure subscribes to the `run.cancelled` event via its
    injected emitter — but that splits terminal handling across two lanes
    and is dispreferred). The projection records
    `workflow.interrupted(reason: "cancelled" | "budget" | "doom_loop")`.
    Because `RunEnd` is never awaited, terminal fact writes are best-effort
    live-state writes — acceptable under P1's live-process-only durability,
    and P2's store write happens on the actor side, not inside the hook.
25. **Built-in verification/documented-command are run-level invariant
    projections, not workflow nodes.** (Sixth pass.) Verification profiles and
    documented-command checks are host-owned product invariants: "if this run
    writes, the latest write epoch must have clean required evidence before a
    completed answer can ship." They share the verifier execution pipe and
    FactLedger facts with workflow projection, but they do **not** share the
    linear workflow state machine, transition table, node lifecycle, or asset
    syntax. P1.5's first implementation incorrectly forced them through an
    implicit single-node `WorkflowDefinition`; that made a run-level invariant
    one-shot, caused read-only runs to pay verification and fail, and turned
    verifier failure into fail-fast instead of bounded fix feedback. D25 is the
    release-gate closure contract:
    - _Projection kind._ Host emits built-in invariant hooks for verification
      require mode and documented-command. They may use `workflow.*` trace
      vocabulary with `projectionKind: "invariant"` / `verificationSource`
      metadata for unified diagnostics, but they do not emit node
      started/completed events and do not pass through `advanceWorkflowState`.
      `suggest` mode is only a guidance hook, not an invariant projection.
    - _Epoch contract._ `FactLedger.writeEpoch` is the freshness source of
      truth; `writes[]` is diagnostic only because untracked-write-capable
      boundaries can bump the epoch without a managed write event. If
      `writeEpoch === 0`, require-mode invariants skip command execution and
      cannot make a completed run fail. Within an epoch, if every required
      verifier has a latest `satisfied === true && stale === false` result,
      Stop does not re-run those commands. When the epoch advances, the
      invariant is dirty again and must re-check before a clean completion.
    - _Repair loop._ Missing, failed, timed-out, or stale verifier evidence at
      Stop runs the required verifier commands and, if the current epoch is
      still not clean, returns a bounded `advance` with model-visible failure
      evidence. `injectOutput` remains the configuration switch for failure
      evidence injection (`always` / `onFailure` / `never`); `frequency` belongs
      to the deleted PostToolUse shape and is removed as an intentional strict
      config-schema break.
    - _Budget interaction._ Invariant repair turns consume the shared S3
      `workflow` forced-continuation source, so selected workflow projections
      and require-mode invariants compete for the same source in a combined
      run. If core refuses the just-requested invariant retry because the source
      is exhausted, the awaited `RuntimeSignal(budget.exceeded)` is the last
      pre-`run.completed` point where the invariant can record failure. Only the
      invariant projection that has a pending refused retry may consume that
      broadcast; it records a verification/invariant failure, not
      `workflow.failed(runtime)`. Shared-budget competition between multiple
      explicit workflow projections remains a P1 known limitation.
    - _Terminal settlement._ `RunEnd(state: "completed")` can record a clean
      invariant completion or a dirty invariant failure for diagnostics, but
      live exit/outcome must not depend solely on fire-and-forget RunEnd
      ordering. `RunEnd(state: "failed" | "cancelled")` records interruption /
      cancellation only; it must not re-label an aborted run as verification
      failure.
    - _Scope control._ Built-in invariants do not make configured hooks
      `workflowActive`; only a selected user workflow projection does. They are
      not installed into in-process delegate child runs by default. Configured
      workflow hooks still assemble before built-in invariant hooks and may
      advance non-terminal turns; D25's guarantee is the completed-run
      latest-write invariant, not a new governing priority over user-configured
      hooks. The old `verification:` hookName protocol remains old-trace
      fallback only; live verdicts come from terminal FactLedger snapshots and
      invariant failure classification. Built-in invariant failures are
      classified under their verification/documented-command source, not
      double-counted as generic workflow failures.
26. **`workflow_start` constraint envelope and spawn-mode destination
    semantics.** (2026-07-05 mid-P3 discussion pass, user-ratified via the
    P3 execution plan v2.1.) Design decision 11 defers whether to ship a
    model-facing `workflow_start`; this decision pre-binds what any "yes"
    must satisfy, so the Step 4b decision is bounded before it is made:
    - _Recursion closed by default._ Episode catalogs do not contain
      `workflow_start`; recursive instantiation requires an explicit node
      manifest declaration plus a depth cap, reusing the delegate-depth /
      `DelegationLedgerKey` precedent. Narrow-by-default per the P1.5 #4
      delegate-gate ruling.
    - _Authorization clamp._ Model-triggered instantiation authorizes at
      most the triggering run's access mode; decision 16's all-or-nothing
      instantiation-time authorization applies with no interactive
      fallback.
    - _Two ownership modes, decided separately._ **Attach**: the workflow
      projects onto the firing run; terminal `failed` taints run outcome
      per decision 3. **Spawn**: an independent durable instance plus a
      task-shaped handle; the parent run's outcome is uncoupled by
      default. The relation of a spawned workflow to its caller is
      task-shaped, not sub-agent-shaped — the shipped actor-inbox unions
      already rule this (decision 21: Workflow{Completed,Failed} ride the
      task notification family).
    - _Spawned instances are born into the unified task lifecycle._ They
      join background-task-lifecycle's fg→promote→bg + revival from
      creation; a dedicated workflow background mechanism is forbidden
      (rule zero — it would be a fourth parallel background owner).
    - _Trace doctrine._ The firing run's trace records only the
      instantiation fact, `workflowId`, and received notifications;
      episodes own their own run traces; cross-run truth is the
      `WorkflowRunRecord` + store events. Never a merged trace — trace is
      not a bus (decision 14's principle).
    - _P3 Step 4b.3 outcome._ No `workflow_start` tool ships in P3. The
      current code keeps the main-host and workflow-episode catalogs free of
      that tool, because a partial attach/spawn wrapper would violate this
      envelope before the unified task-lifecycle birth, recursion-depth, and
      authorization clamp contracts exist as first-class workflow-start
      inputs.
    - _Reopen condition (C4, 2026-07-06)._ A model-facing `workflow_start`
      surface remains closed until the unified task-lifecycle birth contract,
      recursive depth control, and access-mode authorization clamp are all
      first-class inputs to the instantiation envelope.

27. **Instantiation inputs schema — decision 4's instantiation face,
    filled in.** (2026-07-07 job-session / runbook review round, pending
    user confirmation like the rest; first customer is the Runbook Mode
    entry described in workflow-job-session-review-context.md §3.6.)
    Workflow assets may declare typed scalar inputs — `string` / `enum` /
    `boolean` / `number`, with `required` / `default` — validated at
    instantiation; validation failure rejects the start before any run
    exists. Constraints:
    - _Data schema, never a language._ Follows decision 4 verbatim:
      instantiation-time binding only; no expressions, no conditionals,
      no derived/computed values — ever. An input is a value, not a
      program.
    - _Binding shape follows decision 16's precedent._ A bound input
      replaces a **whole argv token** (declared placeholder token), never
      substring interpolation inside a token. Destinations: verifier
      `command` argv (decision 16's original customer — the
      `{{failing_test}}` sketch), `command` / `script` node argv, and
      goal text. Nothing else.
    - _Inputs are job identity._ Bound values freeze into the
      instantiation-time snapshot on the `WorkflowRunRecord` — the same
      snapshot that carries the authorization prefill for resume. Resume
      never re-asks for inputs and never permits changing them; contrast
      authorization, which re-settles per resume under decision 16.
    - _One schema, three faces._ The same declaration drives CLI flag
      parsing, the TUI confirm form, and the future suggestion-chip
      envelope payload — no per-surface parameter vocabulary.
    - _Named deletion._ Retires "parameters stuffed into goal prose" as
      the untyped, unvalidated, gate-invisible parameter channel for
      templated workflows.

## Review Prompt

```text
Use the map-driven-dev skill. Review the brainstorm-stage proposal at
docs/_internal/proposals/workflow-runtime-v1.md against current source.

Focus: (1) is Shape C still the right call vs a pure orchestrator; (2) does
the P1 projection contract conflict with any run-loop or hooks contract in
the project map; (3) is the verifier vocabulary consistent with run-outcome
doctrine; (4) confirm the ownership split with the internal-actor-inbox
design before any code; (5) verify EVERY Current Facts bullet against
source before any code — they are dated facts (several tagged
[branch-local], feat/background-agent-jobs @ eaf17742), not invariants;
a stale fact reopens the decisions that cite it.

Do not implement anything from the Wild Ideas section.
```
