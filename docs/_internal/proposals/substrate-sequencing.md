# Substrate Sequencing (Cross-Proposal Consolidation Map)

> Status: working agreement, drafted 2026-07-04 out of the fourth review
> pass of `workflow-runtime-v1.md`. This page is deliberately thin: it
> assigns each shared substrate exactly one owner, fixes the build order,
> and states the project-wide deletion bar. It does not re-design anything —
> designs live in the owner proposals; this page exists so the four active
> proposals stop re-stating (and re-inventing) the same substrates.
>
> Active proposals covered: `workflow-runtime-v1.md`,
> `background-task-lifecycle.md`, `skill-runtime-v1-redesign.md`,
> `session-agent-host-coordinator.md`, and `qa-convergence-plan.md` (stub home
> created 2026-07-06 from C12). Evidence lines below were verified against the
> `feat/background-agent-jobs` working tree on 2026-07-04 unless a later line
> states otherwise.

## The problem this page solves

The project's maintenance complexity is not driven by code volume; it is
driven by **N parallel half-implementations of the same mechanism**, each
owned by a different feature, plus proposals that each declare their own
version of the shared substrate they need. Verified dispersion as of
2026-07-04:

- **4 "did the command pass" extractors** (verification event scan,
  `commandOutcomeSnapshot`, trace-diagnostics recompute, run-health).
- **≥5 continuation/budget knobs across 3 owners** (`maxSteps`,
  `runBudget`, `MAIN_TODO_MAX_CONTINUATIONS` +
  `resolveTodoContinuationMaxSteps` in `host/runtime.ts`;
  `maxRevivalTurns` and the doom-loop limit in core) — with three
  proposals separately claiming to unify them.
- **≥3 hand-rolled atomic-write implementations**
  (`agent-runtime/src/tasks/file-store.ts:263`,
  `core/src/session.ts:523`, `cron/src/store.ts:296`) under **8 file-backed
  store classes** — and Windows rename EPERM is a recurring CI failure
  class, so every copy is an independent Windows bug surface.
- **≥4 markdown/frontmatter asset parsers** (skills
  preprocess/manifest, retired skill bundle parser,
  `host/agent-profiles.ts`,
  `project-commands`, frontmatter handling in `host/tools.ts`) — the
  workflow asset folder would be the fifth.
- **3+ workflow-hook producers** assembled with no ordering contract
  (configured rules, verification profile, documented-command stop hook);
  workflow P1.5/D25 retires the two old live gate producers by compiling
  verification and documented-command through host-owned invariant projections.
- **3 would-be run-chain drivers** (core continuation,
  `startSupervisedRunChain`, future workflow episodes).

## Rule zero — the deletion bar (project-wide)

Promoted from `workflow-runtime-v1.md`'s acceptance bar to a project rule:

> **Every phase of every proposal must retire at least one parallel
> mechanism.** A phase that only adds is sent back by default. Creating a
> shared primitive counts only if the same PR migrates at least one
> existing copy onto it.

**Exception (inspection/reservation phases):** a phase whose entire
surface is read-only inspection, schema/protocol vocabulary reservation,
or capability snapshot exposure may be purely additive — the
hooks-control-plane "inspection first" precedent stays legal. The
exception is bounded: the proposal's **next behavioral phase** must carry
the deletion the inspection phase deferred, named in advance. An
inspection phase followed by another add-only behavioral phase is two
violations, not one exception.

**Acceptance wording:** a phase's deletion claim is verified by naming the
retired mechanism (file/function) in the PR description and deleting or
migrating it in the same PR — "will be deleted later" does not count.

**Teeth:** `docs/_internal/` is not version-controlled, so this page
enforces nothing by itself — it is rationale, not mechanism. Enforcement
lives in tracked artifacts, to land at P0/P1-prereq time:

1. the hook assembly-order regression test (workflow P0);
2. compile-time guards rejecting configured `advance` / `PreToolUse
   rewrite` while a workflow is active (workflow decisions 19–20);
3. decision 23's two fail-closed projection tests;
4. the P1.5 deletion/release check: the experimental workflow runtime flag
   can be removed only after verification and documented-command live gates
   are migrated onto projection.

Corollary for proposals: a proposal may *reference* a Tier 1 substrate; it
may not re-specify it. Substrate design changes go through the owner
listed below.

## Tier 1 — shared substrates (one owner each; everyone else references)

### S1. Session-root document store primitive

- **Owner:** `agent-runtime` — deliverable is a shared document-store
  module (working name `agent-runtime/src/doc-store/`), built as a
  standalone lateral refactor; no feature proposal owns its design, this
  page tracks its status. First implementation PR defines the module API;
  the tasks/ file-store is the reference implementation to generalize
  from (it already has the atomic-replace + append patterns).
- **Scope:** atomic write (tmp+rename with the Windows EPERM retry
  pattern), corrupt-entry-skip diagnostics, single-writer lease,
  append-log + snapshot record shapes.
- **Status:** implemented 2026-07-04 on `feat/doc-store`:
  `packages/agent-runtime/src/doc-store/` exports shared atomic text/JSON
  document writers with Windows retry cleanup, corrupt-entry-tolerant JSON
  directory/log scans with diagnostics, JSONL append-log helpers, and a
  token-entry file-backed single-writer lease whose refresh/release paths do
  not delete successor owners.
  First migration: `FileTaskStore` record writes now use the shared
  primitive, retiring its private
  `packages/agent-runtime/src/tasks/file-store.ts` `atomicWriteTextSync()`
  copy. Second migration (2026-07-06, C9-①):
  `FileTaskNotificationOutbox` entry writes now use the shared primitive,
  retiring `packages/agent-runtime/src/tasks/file-notifications.ts`'s private
  `atomicWriteTextSync()` copy. Third migration (2026-07-06, C9-②):
  `CronStore` saves now use the shared primitive, retiring
  `packages/cron/src/store.ts`'s private tmp+fsync+rename+directory-fsync
  write flow. Fourth migration (2026-07-06, C9-③): `FileSessionStore`
  `session.json` saves now share the same atomic writer by lowering the
  implementation to `packages/core/src/file-atomic.ts` and keeping
  `agent-runtime/src/doc-store` as the public wrapper, retiring
  `packages/core/src/session.ts`'s private tmp+retry+rename copy. No known C9
  atomic-write copies remain.
- **Customers:** FileTaskStore + FileTaskNotificationOutbox
  (background-task), FileWorkflowStore (workflow P2), CronStore,
  FileMemoryStore, FileSessionStore/FileRunStore (opportunistic),
  GatewayStore.
- **Deletion payoff:** the ≥3 atomic-write copies; per rule zero, the PR
  that creates the primitive must migrate at least one store in the same
  change.
- **Note:** `workflow-runtime-v1.md` P2 lists this as its prerequisite;
  that stays true, but the primitive is justified independently of
  workflow and should not wait for it.

### S2. FactLedger (core fact-classification substrate)

- **Owner:** `workflow-runtime-v1.md` decision 13 (+ decision 22 for the
  initiator tag and expectation polarity). Home: core, extracted beside
  run-outcome's classification primitives.
- **Status:** implemented 2026-07-04 on `feat/fact-ledger`: shared
  `fact-classifier.ts`, live core `FactLedger`, terminal
  `run.completed.factLedger`, verification Stop gate ledger reads, and trace
  diagnostics per-run ledger preference. Global write epoch invalidates on
  managed write completions and untracked-write-capable boundaries. Retired
  mechanisms: verification Stop payload event scan helpers (`stopPayloadEvents`,
  `latestWorkspaceWrite`, `hasSuccessfulVerificationAfter`) and private
  command-classifier copies in `run-outcome.ts` / `trace-diagnostics.ts` /
  `run-health.ts`.
- **Customers:** verification Stop gate (first customer, switches off the
  event-log scan), run-outcome terminal snapshot, run-health, workflow
  verdicts (P1), QA convergence "fact-preserving finality";
  trace-diagnostics keeps its offline recompute over the same shared
  classifiers.
- **Deletion payoff:** online command-fact extractors 3 → 1.
- **Sequencing:** independent PR with its own probe ladder (extract
  classifiers → in-run ledger → switch verification gate → switch
  run-outcome snapshot). The initiator tag (verifier-launched vs
  model-initiated) is day-one schema even while unused.

### S3. Per-source forced-continuation budget

- **Owner:** core (mechanism) + this page (end-state definition, drafted
  and ratified in the S3 annex below).
- **Status:** implemented 2026-07-04 on `feat/forced-turn-budget`: core
  now owns one per-source forced-continuation budget mechanism,
  `revival` is migrated as the first consumer while preserving
  `maxRevivalTurns` / `revivalTurnsUsed` compatibility, and forced-turn
  exhaustion emits `run.budget.exceeded` / FactLedger `budgetExceeded`
  facts without failing the run directly. Workflow P1 now consumes the
  pre-registered `workflow` source for projection advance / verifier block /
  projection-error forced turns; on workflow-source exhaustion core only sends
  an awaited `RuntimeSignal(budget.exceeded)` customer notification, and the
  host projection owns any workflow terminal failure.
- **Hard constraint:** ratification is complete; later proposal work must
  consume this source-budget mechanism rather than adding bespoke forced-turn
  axes. Workflow P1's entry condition includes the S3 implementation.
- **Deletion payoff:** in-run forced-continuation mechanisms 3 → 1
  (knobs remain as per-source policy values, not mechanisms).
- **Scope guard:** S3 covers **in-run forced turns only**. Run-chain caps
  (the supervisor's `MAIN_TODO_MAX_CONTINUATIONS`) live at a different
  altitude and converge under workflow decision 18 (one run-chain driver,
  before actor episode spawning in P3) — see the annex.

### S4. Markdown-folder-asset parser primitive

- **Owner:** `workflow-runtime-v1.md` decision 1 named it; home per the
  edge-packages rule (extract only after repeated work — five copies is
  past the bar). Likely home: `skills` package or a small shared module;
  decided at extraction time.
- **Scope — plumbing only, not schemas:** folder discovery, frontmatter
  split, contentHash, version-pinning fields. Business schemas (skill
  manifest fields, agent-profile fields, project-command fields, workflow
  node schema) **stay with their owners** — the primitive returns parsed
  frontmatter + body + identity; each owner validates its own shape on
  top. One universal parser that knows every schema would be a new
  coupling point, not a consolidation.
- **Customers:** skills, agent-profiles, project-commands, `host/tools.ts`
  frontmatter handling, workflow assets (P0).
- **Deletion payoff:** 5 copies of discovery/frontmatter/hash plumbing →
  1 (not "5 parsers → 1"). Per rule zero, workflow P0 may create the
  primitive only if the same PR migrates at least one existing copy
  (agent-profiles is the smallest).

### S5. Run-boundary read-confidentiality defaults

- **Owner:** core for the path-default primitive, host/CLI/protocol for run
  boundary plumbing.
- **Status:** implemented 2026-07-06 from C13-②. `packages/core/src/policy.ts`
  now exposes `resolveRunConfidentialPaths()` as the one helper that combines
  the built-in conservative deny set (`.env`, secret/token/credential patterns,
  `.ssh`, `.aws`, `.gcp`, `.azure`) with caller-supplied
  `confidentialPaths`. Host start/resume/workflow resume and CLI direct-core
  runs use it; protocol 1.4 carries optional `confidentialDefaults:false` so
  embedders can intentionally own the full list. Post-acceptance fix
  2026-07-06: host-loaded workspace config is merged into the prepared run
  policy before start/resume/workflow-resume episodes are built, so protocol
  clients that omit those fields still honor project config. Denials keep the
  existing `workspace.read.denied` trace event and `READ_SCOPE_DENIED` tool
  failure.
- **Customers:** host runs, CLI direct-core diagnostics, host protocol clients,
  TUI config compatibility.
- **Retired mechanism:** the prior "config absent means workspace reads are
  fully open unless a caller manually prepended defaults" boundary is retired
  in favor of one configurable run-boundary resolver.
- **Scope guard:** this is a read-confidentiality gate only. `--target` remains
  write-scoped and must not become an implicit read sandbox.

## S3 annex — budget end-state one-pager (drafted 2026-07-04, ratified 2026-07-04)

The merge is tractable only with a three-way altitude split; every prior
"unify the budgets" claim blurred at least one of these lines:

1. **Work budget — not S3, unchanged.** `maxSteps` + `runBudget`
   (tokens / cost / model calls) bound how much *primary* work a run may
   do. Owner: core, as today. Ratification checked the QA convergence
   phrase "single foreground budget": it refers to shell/task
   `foregroundTimeoutMs`, not to this family or any S3 family, so it is
   orthogonal and non-conflicting.
2. **In-run forced-turn budget — the S3 mechanism.** One core mechanism
   with per-source accounting, generalizing `maxRevivalTurns` /
   `revivalTurnsUsed` (the shipped seed: revival turns already ride it).
   Sources v1: `revival` (waiting_tasks wake), `workflow` (advance /
   verifier-retry turns). Candidate second wave: `validation`
   (stop-block / validation-continuation turns, which today consume
   `maxSteps`) — migrating them is optional and separately decidable;
   v1 does not require it. **Semantics: a forced turn consumes its
   source's budget, not `maxSteps`** — this removes the parasitism
   workflow projection-mechanics §4 documents, without adding an axis.
   Exhaustion emits per-source `budget.exceeded` facts; consumers (e.g.
   workflow decision 24) turn them into interruption facts. Exhaustion
   refuses the forced continuation; it does not fail the run by itself.
   Used counts per source are recorded on the run snapshot (保事实、调信号). The
   doom-loop detector stays orthogonal: it detects repetition, not spend.
3. **Run-chain caps — not S3, converge at decision 18.** The supervisor's
   todo-continuation cap (`MAIN_TODO_MAX_CONTINUATIONS`,
   `resolveTodoContinuationMaxSteps` in `host/runtime.ts`) bounds **new
   runs in a chain**, not turns in a run. Forcing it into the in-run
   mechanism would conflate two altitudes; it converges when run-chain
   ownership converges (workflow decision 18's gate before actor episode
   spawning: one run-chain driver).

Config surface: core owns the one mechanism; host supplies per-source
policy values (profile/config), same split as access-mode.

Ratification checklist — all boxes ticked before any budget code.
The "claimants" are one maintainer's concerns, not separate parties, so
this is deliberately lightweight: one read-through of this annex,
checkboxes, a recorded date/commit. No process theater.

- [x] QA convergence: "single foreground budget" is shell/task
      `foregroundTimeoutMs`, outside all three S3 families; orthogonal,
      non-conflicting.
- [x] background-task: confirm revival semantics survive unchanged as the
      first source of family 2.
- [x] workflow: decision 14 becomes a customer of family 2; no separate
      implementation.
- [x] workflow projection hardening: projection-error forced continuations
      at `ModelOutput` / `Stop` consume the `workflow` source budget, like
      healthy advances and verifier blocks. S3 owns only cause-agnostic
      source accounting and exhaustion facts; P1 owns projection error
      thresholds and interruption policy.

## Tier 2 — convergences owned by their proposals (reference-only here)

| Convergence | Owner | End state |
| --- | --- | --- |
| Hook producers 3+ → 2 → 1 | workflow P1.5 (+ decision 19 ordering, P0 assembly-order test) | P1.5/D25 local state: user-configured rules + host-owned projection family; verification/documented-command are built-in invariant projections, selected workflow assets are linear workflow projections, the old live gate producers are deleted, the dead `verification.stopGate` config surface is removed, and P1.5 release gate passed. Future 2 → 1 convergence folds todo doctrine and plan mode in as workflow collections (decision 18, self-hosting pilots). |
| Run-chain drivers 3 → 1 | workflow decision 18 (gate before actor episode spawning) | one run-chain driver; supervisor todo chain expressible as degenerate workflow before episodes ship |
| Session turn ownership / "next execution" boundary | session-agent-host-coordinator.md C3 P0 matrix | core owns in-run command consumption, workflow owns workflow episode advancement, `TaskManager` owns task terminal/revival facts, and future `SessionTurnScheduler` owns only session queueing plus active-turn selection; per-connection `HostRuntime` remains a compatibility adapter, not the target coordination owner |
| Skill/MCP/Agent/Delegate → one substrate | skill-runtime-v1-redesign convergence addendum | C1 accepted A-Phase 1-3 on 2026-07-06: Agent indexed exposure is the baseline, Agent index structuring follows, and MCP alignment (`mcp_call`, name-level deferral, `pinnedTools`) is opt-in first; A-Phase 4 shared routing is deferred to the capability-upgrade Phase 3b rank-before-hide review |
| Shell/task/sub-agent lifecycle | background-task-lifecycle (in flight on `feat/background-agent-jobs`) | one fg→promote→bg + revival spine; one background-execution semantics |

## Tier 3 — pure deletions / fork-closing (small PRs, no design needed)

- ACP entrypoint lacks `--session-root` and writes into the workspace —
  closed in the current baseline: ACP parses `--session-root` and passes it to
  `HostRuntime`.
- `capabilities inspect` under-reports inline-config agents — closed
  2026-07-06 by reporting all resolved profiles in host runtime snapshots,
  including inline-config profiles that are not delegate-derived.
- Sweep for neutralized-but-not-deleted code — closed 2026-07-06 for the
  `detectSkillLearnTarget` detector: the TUI no longer guesses target Skill
  names from prompts before calling `createSkillLearnDraftProposal`.
- **Explicit non-goal:** the two run loops (`core.createRun` vs the
  streaming-runtime loop) stay separate. No equivalence work until a real
  convergence customer exists — declared non-convergence is also
  complexity control.

## Build order

```text
S2 FactLedger ──────────────┐
S3 ratified + generalized ──┼─→ workflow P1 (needs S2 + S3)
S1 document store ──────────────→ workflow P2 / background-task durability
S4 asset parser ────────────────→ workflow P0 (created there, migrates ≥1 copy)
Tier 3 deletions: anytime, independently.
```

S2 and S1 are parallel and independent. S3's ratification one-pager is
complete; later workflow work consumes the generalized mechanism. S4 rides
workflow P0. Nothing in Tier 2 starts its deletion phase before its Tier 1
dependencies exist.

## Maintenance

- When a proposal phase lands, update the relevant substrate entry here
  (owner, status, retired-mechanism list) in the same PR.
- A new proposal that needs a substrate adds itself as a customer here;
  it does not restate the substrate's design.
- Re-verify the evidence lines (extractor/knob/parser/store counts) at
  each substrate's first implementation PR — they are 2026-07-04 facts,
  not invariants.
