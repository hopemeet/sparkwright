# Skill Self-Evolution Design Notes

> Borrowing study of NousResearch/hermes-agent's skill self-improvement, retargeted
> for a **composable agent kernel** (not a monolithic agent product).
> Source-grounded against `/Applications/xgw/projects/github/hermes-agent` at commit `cb3e41e2f`.
> Where this doc and the upstream source disagree with prior hand-notes, **source wins** and the
> delta is flagged inline as `[Δ vs notes]`.

---

## 0. Source map (what actually exists in hermes-agent)

| Concern | File(s) | Nature |
|---|---|---|
| Background review fork (the "level-1" loop) | `agent/background_review.py` (597 lines) | LLM, daemon thread |
| Review prompts (memory / skill / combined) | `agent/background_review.py` constants | static text |
| Curator orchestrator (the "level-2" loop) | `agent/curator.py` (1843 lines) | mixed |
| Phase-1 deterministic transitions | `curator.apply_automatic_transitions()` | **pure function, no LLM** |
| Phase-2 consolidation | curator review fork + `_CURATOR_PROMPT` | LLM |
| Snapshot + rollback | `agent/curator_backup.py` (695 lines) | deterministic, tar.gz |
| Usage telemetry + lifecycle states | `tools/skill_usage.py` (852 lines) | deterministic sidecar |
| Write-origin provenance | `tools/skill_provenance.py` (78 lines) | ContextVar |
| Bundled sync (manifest, 3-hash merge) | `tools/skills_sync.py` (897 lines) | deterministic |
| Skill load/select/inject | `agent/skill_preprocessing.py`, `agent/skill_utils.py`, `agent/skill_commands.py` | mostly deterministic |
| Skill CRUD tool surface | `tools/skill_manager_tool.py`, `tools/skills_tool.py` | tool dispatch |
| Hub (install readonly skills) | `tools/skills_hub.py` (3748 lines) | deterministic |
| Cadence config | `agent/agent_init.py` (`_skill_nudge_interval`, `_memory_nudge_interval`) | config |

### Confirmed constants `[Δ vs notes]`

The hand-notes said "every N turns / N iterations". Concrete defaults in source:

- **Memory review** fires every **10 user turns** (`agent._memory_nudge_interval = 10`, configurable via `memory.nudge_interval`).
- **Skill review** fires every **10 tool-call iterations** (`agent._skill_nudge_interval = 10`, configurable via `skills.creation_nudge_interval`). Trigger check: `_iters_since_skill >= _skill_nudge_interval`.
- **Curator**: `interval_hours = 24*7` (7 days), `min_idle_hours = 2`, `stale_after_days = 30`, `archive_after_days = 90`. All overridable in `~/.hermes/config.yaml` under `curator.*`.

### Two findings the notes under-weighted

1. **Usage telemetry is a sidecar, not frontmatter.** `~/.hermes/skills/.usage.json` keyed by skill name. The docstring is explicit about *why*: keep operational counters out of user-authored `SKILL.md`, and avoid creating merge/conflict pressure on bundled/hub skills. Counters: `use_count`, `view_count`, `patch_count` + matching `last_*_at` timestamps + `state` + `pinned`. `latest_activity_at()` and `activity_count()` are **derived**, not stored.

2. **Provenance is a single ContextVar, not a rich author field.** `tools/skill_provenance.py` holds one `ContextVar` defaulting to `"foreground"`. The background-review fork sets it to `"background_review"`; only skills created under that origin get `mark_agent_created()` and become curator-eligible. Everything else (user-directed foreground writes, bundled, hub) is **off-limits to the curator forever.** This is the load-bearing safety property: *the curator can only touch what the agent autonomously wrote.*

---

## 1. Hermes Mechanism Summary

Hermes runs **two independent self-improvement loops** plus a **non-evolutionary sync layer**. They are easy to conflate; keep them separate.

**Sync layer (not evolution).** Bundled skills ship in-repo; a copy lives in `~/.hermes/skills/`. A manifest (`.bundled_manifest`, `name:origin_hash` per line) drives a 3-way hash merge on every sync: compare `bundled_hash` (repo now), `user_hash` (user copy now), `origin_hash` (last synced). Upstream-changed-and-user-untouched → silent update; user-touched → user wins, never overwritten. This is conffile/`git merge` semantics: *shipped content is a suggestion, user edits are sovereign.* No learning here.

**Level 1 — Background review (don't lose the lesson).** After a turn, the main agent forks a **daemon thread** running a second `AIAgent`. The fork: inherits the parent's live runtime + **cached system prompt verbatim** (so it hits the same prefix cache — measured ~26% cost cut), runs with a **tool whitelist of memory/skill tools only** (everything else denied at dispatch), is fed a conversation snapshot + a review prompt, and writes new skills / patches existing ones straight to the store. It runs on cadence (10 turns / 10 iterations) plus flush on exit/reset. The prompt pushes it to be **active** ("most sessions produce at least one update") but carries a hard **do-not-capture list**: no environment failures, no "tool X is broken" negative claims, no transient resolved errors, no one-off task narratives. Writes are **optimistic, unvalidated, straight to active.**

**Level 2 — Curator (don't let the library rot).** Runs inactivity-triggered (no daemon): on CLI start / gateway tick, if `>7d` since last run and user idle `>2h`. Two phases:
- *Phase 1, pure function:* walk every agent-created skill, derive last activity, move `active→stale` at 30d, `→archived` at 90d, `stale→active` on reuse. Pinned skills skipped. No LLM.
- *Phase 2, LLM fork:* hand the model a snapshot of all agent-created skills (state, pinned, counts) and run an **umbrella-building consolidation** — cluster by prefix, merge siblings into class-level umbrellas, demote detail into `references/`/`templates/`/`scripts/`, archive (never delete) the absorbed originals. A tar.gz of the whole `skills/` tree is taken first; rollback restores the tree wholesale.

**The boundary it draws in-prompt:** *memory* = "who the user is and the current state of operations"; *skill* = "how to do this class of task for this user."

---

## 2. What Is Worth Borrowing

1. **Two-tier separation of concerns.** Capture (fast, per-session, optimistic) and curation (slow, periodic, structural) are genuinely different jobs with different failure modes. Keep them as two components, not one.
2. **Provenance as a hard gate, not a label.** The "curator only touches what the agent autonomously wrote" invariant is the single most important safety property. Anything user-authored, bundled, or hub-installed is immutable to automation. Steal this verbatim.
3. **Sidecar telemetry.** Operational counters do not belong in the artifact. Keeping `.usage.json` separate from `SKILL.md` means content diffs stay clean and bundled/hub skills never get dirtied by counters. Adopt for every skill store.
4. **Prefix-cache-preserving fork.** Inheriting the parent's cached system prompt byte-for-byte so the review request hits the warm cache is the difference between "background review is free-ish" and "background review doubles cost." Any background-agent component in our kernel must expose "fork with cached prompt" as a first-class capability.
5. **Tool whitelist at dispatch for sub-loops.** The review fork can *only* call memory/skill tools; everything else is denied at runtime regardless of what the model emits. This is the right pattern for any constrained subagent.
6. **Archive-not-delete + tar.gz snapshot + rollback.** Cheap, total, recoverable. Good default safety net even after we add finer-grained controls.
7. **The do-not-capture list as doctrine.** Encoding "don't harden environment failures into permanent negative beliefs" directly into the writer prompt is a real, hard-won insight. Carry it forward (and we'll back it with structure, not just prose — see §3).
8. **Bundled 3-hash sync.** Correct, well-understood semantics for shipping upgradeable defaults without clobbering users. Reuse for our bundled component packs.

---

## 3. What Should Not Be Copied Directly

1. **Straight-to-active writes with no validation.** Hermes has **zero eval gate** — the only safety net is archive/pin/rollback *after the fact*. For a framework others build on, this is the #1 thing to change. We insert a `candidate → validated → active` path.
2. **Telemetry-only quality signal.** Curator decisions rest on counts + LLM judgment of a *current snapshot*. It cannot see whether a skill is getting better or worse across patches (no diff history in the decision input). Add evolution history to the curator's input.
3. **"Be active — most sessions produce an update" pressure.** Optimizing for write-rate manufactures low-value, narrow skills; the curator then exists largely to clean up the writer's over-eagerness. Invert the default: **silence is fine; write only with evidence.**
4. **Global, scope-free skills.** Hermes skills are effectively one global namespace. A repo-specific debugging trick should not silently govern an unrelated project. Make **scope mandatory** and default to the narrowest plausible (repo/project).
5. **Whole-tree rollback as the only granularity.** tar.gz of everything is a good floor but can't undo *one bad patch to one skill*. Add per-skill versioned history.
6. **Background token burn on by default.** Two forked agents per session (memory + skill) plus a periodic curator fork. For light users the ROI is negative and the cost is invisible. Default the background loops **off**; make capture **explicit/opt-in** (a command or a mode) per the user's own instinct.
7. **No conflict detection.** Two skills can give opposite advice for the same task class; nothing flags it. Add conflict detection in the curator.
8. **Idle-triggered curator starves busy users.** "Idle >2h" means a continuously-busy power user — exactly who generates the most candidates — may never curate. Decouple curation trigger from idleness (queue-pressure or explicit command).
9. **Prompt-injection surface.** An auto-writer fed conversation snapshots that include malicious repo/web/log content can be steered into persisting bad long-term skills. Untrusted content must be quarantined from the writer, or writes from injection-exposed sessions must require confirmation.

---

## 4. Proposed Architecture for Our Agent Components

Design rule: **the kernel does not know what a skill is.** Skills, memory, curation are *components* that plug into kernel extension points (events, context providers, tool providers, approval policy). Someone can ship an agent on our kernel with no skill system at all.

```
                         ┌────────────────────────────────────────────┐
                         │                Agent Kernel                 │
                         │  Run → Step → ToolCall → Observation → Event │
                         │  Context | Artifact | Approval | Policy | SM │
                         └───────┬───────────────┬───────────────┬─────┘
            emits Event stream   │   pulls Context│   gates via   │ Approval
                                 ▼               ▼               ▼
              ┌───────────────────────┐  ┌───────────────┐  ┌─────────────┐
              │     Skill System      │  │ Memory System │  │ Tool System │
              │  Registry/Store       │  │ User/Project  │  │ Registry    │
              │  Selector/Loader      │  │ Episodic/Sem. │  │ Executor    │
              │  Writer/Reviewer      │  │ SkillMemory   │  │ Sandbox     │
              │  Evaluator            │  │ MemoryNudge   │  │ Normalizer  │
              │  Curator              │  └───────────────┘  └─────────────┘
              │  EventLog             │
              └───────────────────────┘
                         ▲
                         │ Governance cross-cuts all: Provenance · TrustLevel
                         │ · AuditLog · Rollback · Receipt
```

The Skill System is a **consumer of the kernel event stream** and a **provider of context**. It never reaches into kernel internals; it subscribes to events (`StepCompleted`, `RunCompleted`, `UserCorrection`) and contributes a context slice (selected skills) back on the next run.

### Component boundaries

- **SkillStore** — pure persistence. Files + sidecar metadata + version history. No LLM.
- **SkillRegistry** — lifecycle ops over the store: install/sync/pin/archive/restore/rollback/search. Deterministic.
- **SkillSelector** — given a task/context, return *which* skills to load. Cheap retrieval over descriptions, not bodies.
- **SkillLoader** — materialize selected skills into a context slice (lazy: SKILL.md head, references on demand).
- **SkillReviewer/Writer** — extract candidate skills from a Run's event trace; emit `SkillCandidate` (never a live skill).
- **SkillEvaluator** — run a candidate through a promotion gate; emit pass/fail + evidence.
- **SkillCurator** — periodic structural maintenance over agent-created skills only.
- **SkillEventLog** — append-only record of every skill-touching event.

---

## 5. Skill Lifecycle

`[Δ vs Hermes]` Hermes is `active → stale → archived` (+`pinned`), and the writer goes **straight to active.** We insert two pre-active states so nothing automated lands in the live context without evidence.

```
                 (writer/reviewer extracts from trace)
   trace ──────────────────────────► candidate
                                          │
            promotion gate (≥1 evidence)  │  reject → rejected (kept w/ reason, not deleted)
                                          ▼
                                      validated ──────────► active
                                                              │  ▲
                                30d no use → stale  ◄─────────┘  │ reuse / curator promote
                                          │                       │
                                90d no use │  archive ◄───────────┘
                                          ▼
                                       archived  ──(restore)──► active
```

| Transition | Trigger | Who | Deterministic? |
|---|---|---|---|
| `→ candidate` | writer extracts from a Run trace | Reviewer | LLM extract, deterministic envelope |
| `candidate → validated` | passes ≥1 promotion gate (see §8) | Evaluator | mixed |
| `candidate → rejected` | fails gate, or user declines, or anti-pattern detected | Evaluator/user | deterministic record |
| `validated → active` | write mode allows (auto) **or** user confirms (review) | Registry | deterministic |
| `active → stale` | `latest_activity_at` older than `stale_after_days` | Curator phase-1 | **pure function** |
| `stale → active` | skill selected/used again | Selector bump | **pure function** |
| `active/stale → archived` | older than `archive_after_days`, or curator consolidates | Curator | phase-1 pure / phase-2 LLM |
| `archived → active` | `restore` command, or reuse | Registry/user | deterministic |
| any → pinned-protected | user pins | Registry | deterministic |

Notes:
- `rejected` candidates are **retained with their reason** (this is the anti-pattern memory — see §3 of the brief: "失败签名"). They are not re-proposed if an identical signature recurs.
- `pinned` is an orthogonal flag (as in Hermes): blocks archive/consolidate, allows content patches.
- **Write mode** (`auto` / `review` / `manual`) decides whether `validated → active` is automatic, drafted-for-confirmation, or suggestion-only. This is the user's three-mode requirement, mapped onto one transition.

---

## 6. Data Model

```typescript
// ---- The artifact ----------------------------------------------------------
type SkillScope =
  | "global" | "user" | "workspace" | "repo" | "project" | "task" | "temporary";

type TrustLevel =
  | "bundled"       // shipped with the framework; immutable to automation, syncable
  | "hub-installed" // installed from a registry; read-only
  | "user-authored" // human wrote/edited it; sovereign, never auto-curated
  | "agent-created";// autonomously written; the ONLY automation-eligible class

type LifecycleState =
  | "candidate" | "validated" | "active" | "stale" | "archived" | "rejected";

interface SkillPackage {
  name: string;                 // class-level, kebab-case
  description: string;          // the ONLY thing the Selector sees by default
  scope: SkillScope;            // mandatory; defaults to narrowest plausible
  version: string;              // semver-ish; bumped on every patch
  provenance: Provenance;
  triggers: SkillTrigger[];     // when this skill is relevant
  instructions: string;         // SKILL.md body (lazy-loaded)
  examples?: string[];
  constraints?: string[];       // do / don't for this task class
  antiPatterns?: AntiPattern[]; // failure signatures NOT to repeat (bounded, see §3.7 brief)
  references?: FileRef[];       // references/<topic>.md  (lazy)
  templates?: FileRef[];        // templates/<name>.<ext>
  scripts?: FileRef[];          // scripts/<name>.<ext>  (statically re-runnable)
  tests?: SkillTest[];          // gate evidence (replay / script / assertion)
  audience?: AgentRole[];       // which agent roles may load it (see §6 brief Q)
  metadata: SkillMetadata;      // sidecar; never in SKILL.md
}

interface Provenance {
  trustLevel: TrustLevel;
  writeOrigin: "foreground" | "background_review" | "curator" | "import" | "manual";
  sourceRunId?: string;         // the Run this was extracted from
  authorSessionId?: string;
  createdAt: string;            // ISO, absolute
}

interface SkillTrigger {
  kind: "task-class" | "tool" | "error-signature" | "file-glob" | "keyword";
  value: string;
}

interface AntiPattern {
  signature: string;            // normalized failure fingerprint
  reason: string;
  // Guardrail: anti-patterns are SCOPED and EXPIRABLE so they never harden
  // into permanent "tool X is broken" beliefs (the Hermes failure mode).
  scope: SkillScope;
  expiresAt?: string;           // soft TTL; re-confirm before re-asserting
  retractedBy?: string;         // run/event that proved it wrong
}

// ---- Sidecar telemetry (separate file, NEVER in SKILL.md) -------------------
interface SkillMetadata {
  state: LifecycleState;
  pinned: boolean;
  useCount: number;
  viewCount: number;
  patchCount: number;
  ignoreCount: number;          // loaded-but-not-used (the user's "被agent忽略率")
  lastUsedAt?: string;
  lastViewedAt?: string;
  lastPatchedAt?: string;
  // derived, not stored: latestActivityAt(), activityCount()
  evidence: Evidence[];         // why it was promoted; required to reach `active`
  successCount: number;         // tasks where it was loaded AND task succeeded
  failureCount: number;         // loaded AND task failed (weak signal, contextual)
  estStepsSaved?: number;       // §1 brief: "节省步骤或成本"
  history: SkillVersionRef[];   // §3.4 brief: version/diff/changelog chain
}

interface SkillVersionRef {
  version: string;
  at: string;
  writeOrigin: Provenance["writeOrigin"];
  changelog: string;
  diffRef: string;              // pointer to stored diff
  pinnedMilestone?: boolean;    // user-hand-edit / major rev — kept forever (§ user brief)
}

interface Evidence {
  kind: "user-confirmed" | "replay" | "unit-test" | "ci-lint-typecheck"
      | "live-hit-positive" | "multi-judge";
  detail: string;
  passedAt: string;
  confidence: number;           // 0..1
}

// ---- The candidate (what the writer emits) ---------------------------------
interface SkillCandidate {
  proposed: Partial<SkillPackage>;
  action: "create" | "patch" | "merge" | "add-support-file" | "ignore";
  targetSkill?: string;         // for patch/merge/add-support-file
  // Mandatory evidence envelope (§3 brief) — no candidate without these:
  sourceTrace: { runId: string; stepRange: [number, number] };
  userCorrectionPoints: string[];
  taskClass: string;
  appliesTo: SkillScope;
  doesNotApplyTo?: string[];
  confidence: number;           // 0..1
  expectedBenefit: string;
  risk: string;
  injectionExposure: boolean;   // true if trace touched untrusted content (§3.9)
}
```

Python `@dataclass` equivalents are 1:1; omitted for brevity.

---

## 7. Event Model

The SkillEventLog is append-only and is *also* the curator's history input (closes the Hermes gap where the curator can't see evolution).

```typescript
type SkillEventType =
  | "candidate_extracted" | "candidate_rejected"
  | "evaluated" | "promoted"          // candidate→validated→active
  | "created" | "patched" | "merged" | "support_file_added"
  | "viewed" | "loaded" | "used" | "ignored"   // selection/usage telemetry
  | "conflict_detected"
  | "marked_stale" | "archived" | "restored" | "reactivated"
  | "pinned" | "unpinned"
  | "rolled_back" | "synced";

interface SkillEvent {
  id: string;
  type: SkillEventType;
  skillName: string;
  at: string;                    // ISO absolute
  writeOrigin: Provenance["writeOrigin"];
  runId?: string;                // correlate to kernel Run
  sessionId?: string;
  fromVersion?: string;
  toVersion?: string;
  payload: Record<string, unknown>;  // diffRef, evidence, conflictWith, reason…
}
```

This stream feeds three consumers: (a) the Selector (usage-aware ranking), (b) the Curator (history-aware decisions), (c) the user-facing **capability statistics** the user asked for — per-skill/tool/agent call counts and failure counts roll up directly from this log (§ "体外话" in brief). Same log, three readers.

---

## 8. Evaluation and Promotion Gate

`[Δ vs Hermes]` Hermes has no gate. This is our central addition. A candidate reaches `active` only after **≥1 evidence** of the kinds below; the **write mode** sets the *minimum bar*.

| Evidence kind | What it does | Cost | Best for |
|---|---|---|---|
| `user-confirmed` | user accepts the drafted skill | 1 click | review mode default |
| `replay` | re-run the original failing/corrected task with the skill loaded; compare outcome | medium | corrections, debugging paths |
| `unit-test` / `script` | run the skill's own `scripts/`+`tests/` assertions | low | deterministic skills |
| `ci-lint-typecheck` | the skill's claimed fix passes lint/typecheck/pytest (ties into the LSP/lint/pytest tool capability you already care about) | medium | code skills |
| `live-hit-positive` | shadow-load the candidate; promote only after it's selected in a *future* task and that task succeeds | deferred | low-confidence candidates |
| `multi-judge` | N models independently judge value/safety | medium | style/workflow skills with no testable oracle |

**Write modes → gate:**
- `auto` (hacker mode): any single evidence kind, including `multi-judge`. Fast, still never unvalidated.
- `review` (default): requires `user-confirmed` **or** (`replay`/`test` pass **and** user gets a one-line receipt).
- `manual` (enterprise/compliance): gate never auto-promotes; candidates accumulate as suggestions only.

**Two slash-command entry points** (mapping the user's "两个斜杠命令"):
- `/skill learn` — manual trigger: review the current/last Run, extract candidates, run the gate, show drafts. One-shot.
- `/skill evolve` — switch the agent into **imitation-learning / recording mode**: a role-system swap where the agent records its execution process and distills skills as it goes, *without* brute-force trial-and-error mutation. Optionally opens a **validation loop**: for each candidate, run its gate, and if it fails, attempt one bounded repair, re-gate, else reject. The loop is explicit and bounded — never an open-ended self-mutation daemon.

**Anti-overfitting rule:** a candidate whose `sourceTrace` is a single Run and whose `taskClass` is a one-off narrative is auto-`rejected` (encodes the Hermes do-not-capture list as a *gate check*, not just prose). `injectionExposure = true` forces `manual` handling regardless of mode.

---

## 9. Scope and Trust Model

Two orthogonal axes. **TrustLevel** answers "who may modify this and how"; **Scope** answers "where does this apply".

```
TrustLevel        Automation may…           Sync?    Curator-eligible?
─────────────────────────────────────────────────────────────────────
bundled           read only                 yes(3-hash) no
hub-installed      read only                 on update   no
user-authored      read only*                no          no   (*sovereign — never auto-edited)
agent-created      read + patch + curate     no          YES  (the only writable class)
```

This is Hermes' provenance gate, made explicit and richer. The load-bearing invariant survives verbatim: **only `agent-created` skills are touchable by Writer/Curator.** A user edit to an agent-created skill *promotes its TrustLevel to user-authored* (mirrors Hermes bundled-sync "user edit wins"), which freezes it against future automation and marks the version a `pinnedMilestone` in history.

**Scope resolution at selection time:** a `repo`-scoped skill only enters context when the Run's workspace matches that repo. Default for new candidates is the **narrowest scope the evidence supports** (task < repo < project < workspace < user < global). Promotion to a broader scope is its own gated transition (e.g., "this fired correctly in 3 distinct repos → propose `global`").

**Audience tags** (`audience?: AgentRole[]`) gate which subagent roles may load a skill (§ multi-agent below).

---

## 10. Curator Design

Keep Hermes' two-phase shape; fix its four blind spots (no history, no conflict detection, no scope, idle-starvation).

**Phase 1 — deterministic (pure function, no LLM), borrowed as-is:**
- Walk `agent-created` skills; derive `latestActivityAt`. `active→stale` at 30d, `→archived` at 90d, reactivate on reuse. Skip pinned. This is `curator.apply_automatic_transitions()` — copy its shape.

**Phase 2 — structural (LLM fork), extended:**
- *Input upgrade:* feed the model not just the current snapshot but the **EventLog-derived evolution history** (`history[]`, success/failure trend, ignoreCount). The model can now distinguish "this skill is converging" from "this skill is thrashing across contradictory patches" — the Hermes curator cannot.
- *Consolidation:* prefix-cluster → umbrella-build → demote detail to `references/templates/scripts` → archive (never delete) absorbed siblings. Keep Hermes' "merge / create-umbrella / demote" trichotomy and its "leave no dangling reference" rule.
- *Conflict detection (new):* before consolidating, scan for skill pairs whose `instructions`/`constraints` give opposing guidance for the same `taskClass`. Emit `conflict_detected`; require resolution (merge-with-precedence, scope-split, or escalate to user) before either is trusted.
- *Split (new):* an umbrella that has grown to cover divergent task classes gets split — the inverse of consolidation, triggered by low intra-skill selection coherence.
- *Token-budget pass:* rank by `useCount`/`successCount` per token; demote rarely-hit bulk into `references/` (lazy) so the always-injected `description` set stays cheap.

**Safety (borrow + sharpen):**
- Keep tar.gz whole-tree snapshot before any mutating pass (cheap floor).
- **Add per-skill version history + diff** so rollback granularity is one skill / one patch, not the whole tree (fixes Hermes blind spot #8 in the brief).
- `pinnedMilestone` versions (user hand-edits, major revs) are retained forever even when intermediate versions are GC'd (the user's archive requirement).

**Trigger (de-couple from idle):** run on `(time-since-last > interval) AND (candidate/active count over threshold OR explicit /curator run)`. A continuously-busy user still curates because pressure, not idleness, drives it. Default the *automatic* curator **off** for light users; `/curator run` always available.

---

## 11. Integration With Agent Kernel

The kernel exposes extension points; the skill system binds to them. No kernel code imports the skill system.

| Kernel concept | Skill-system binding |
|---|---|
| **Run** (a task execution) | `runId` stamped on every candidate + event; the unit of replay evidence |
| **Step / ToolCall / Observation** | the raw trace the Writer reads; `stepRange` cites exact steps |
| **Event** | kernel emits `StepCompleted`/`RunCompleted`/`UserCorrection`; Writer subscribes. Skill system emits `SkillEvent`s back onto the same bus |
| **Context** | SkillSelector is registered as a **context provider**: on Run start it contributes a skill slice (descriptions + lazily-loadable bodies). This is where token control lives (§ Q5) |
| **Approval** | `validated→active` in review/manual mode routes through the kernel's existing ApprovalPolicy — same gate as tool approval. Reuses your `0002`/`0004` approval ADRs |
| **Artifact** | drafted skills, diffs, candidate bundles, tar.gz snapshots are kernel Artifacts (inspectable, attachable to a Receipt) |
| **Policy / State Machine** | write-mode (auto/review/manual) and curator-enabled are Policy values; the lifecycle (§5) is a State Machine the kernel can host generically |
| **Receipt** | every promotion/patch/archive yields a Receipt (what changed, evidence, rollback handle) — your auditability requirement |

Concretely: the **background review fork** is just *the kernel's own subagent primitive* (ContextIsolation + BudgetLimit + tool whitelist + cached-prompt fork) pointed at the skill toolset. We don't build a bespoke daemon; we reuse the Subagent System with a `memory+skill` tool whitelist and an approval callback that auto-denies dangerous ops (exactly Hermes' `_bg_review_auto_deny`).

---

## 12. MVP Plan

Each version is independently shippable and useful. Background/auto features come **late and opt-in** by design.

- **v0.1 — Manual skills + registry + selector.** SkillStore (files + sidecar), SkillRegistry (install/pin/archive/restore), SkillSelector (description-based retrieval), SkillLoader (lazy bodies). No writing, no evolution. Bundled 3-hash sync. *This alone is a usable, LangChain-unlike composable skill layer.*
- **v0.2 — Candidate drafts.** SkillReviewer reads a Run trace and emits `SkillCandidate`s with the evidence envelope. **Nothing auto-writes.** `/skill learn` shows drafts; user applies by hand. EventLog online.
- **v0.3 — Review mode.** `validated→active` via ApprovalPolicy. Write modes `manual`/`review`. Drafts become one-click-apply with a Receipt. Anti-pattern/`rejected` retention.
- **v0.4 — Curator.** Phase-1 deterministic transitions + Phase-2 consolidation with history-aware input, conflict detection, per-skill version history, tar.gz + per-skill rollback. `/curator run`, pin, dry-run.
- **v0.5 — Evaluator / replay.** Promotion gate kinds: replay, script/unit-test, ci-lint-typecheck. `auto` write mode unlocked (now safe because gated). `/skill evolve` imitation-recording mode + bounded validation loop.
- **v1.0 — Multi-agent + workspace policy.** Audience tags, role-scoped sharing, scope promotion gates, enterprise policy (redaction, retention, no-background-by-default, approval-required), multi-judge evidence, capability statistics dashboard.

---

## 13. Open Questions (need your decision)

1. **Default write mode.** I'm proposing `review` as the shipped default with background loops **off**. Confirm — or do you want `manual` as the conservative default and `review` opt-in?
2. **Trace storage retention.** Replay evidence needs the original Run trace to exist later. How long do we keep full traces, and where (you already have JSONL tiered traces per ADR `0006`)? Replay quality is bounded by this.
3. **Scope inference vs. declaration.** Should the Writer *infer* scope from the trace (workspace path, repo remote) and let the user correct, or always ask? Inference is smoother but can mis-scope.
4. **Anti-pattern TTL policy.** What's the default soft-TTL before an anti-pattern must be re-confirmed? Too long → Hermes' "tool X is broken forever" bug; too short → no protection. (I'd start at 30d, scoped.)
5. **Where does SkillMemory sit** — inside the Memory System or the Skill System? (See Q1 below: I lean "skills ARE a memory subtype but with execution/eval semantics," which argues for a shared store, separate lifecycle.)
6. **Cross-repo skill sharing / a hub.** Do we want a HuggingFace-like push/pull registry for `agent-created` skills in v1.0, and if so, what's the trust model for *downloading* someone else's evolved skill (re-gate on import)?
7. **Curator compute budget.** Hard token/cost ceiling per curator run, and what happens when a consolidation pass would exceed it (partial pass + resume, or skip)?

---

## Appendix A — Answers to the six cross-cutting questions

**Q1. Skill vs Memory boundary.** Memory = *facts and state* ("who the user is", "what the current operation is"). Skill = *procedure* ("how to do this class of task"). Operational test: if it's true regardless of any task → memory; if it only matters while *doing* a kind of task → skill. Hermes draws this exact line in-prompt and it holds. Corollary: a user style preference belongs in **both** — the fact in memory, the *applied procedure* in the governing skill (Hermes is explicit about this double-write).

**Q2. Skill vs Tool boundary.** A skill is prompt-level guidance; a tool is executable capability. The decision signal is in the telemetry: **if a skill exists mainly to compensate for a missing capability — it keeps telling the agent to hand-run the same commands — that's a tool/script/indexer/validator waiting to be born, not more prompt.** Promote it: the skill's `scripts/` graduate into a real registered tool. (This is the LSP/lint/pytest/RTK-as-capability thread from your background.) Rule of thumb: guidance → skill; deterministic re-runnable action → script under a skill → registered tool once it stabilizes.

**Q3. Skill vs Workflow boundary.** A skill is *advisory* (the model may ignore it). A workflow is *enforced* (a state machine the kernel drives). Convert skill→workflow when: the sequence is failure-prone if reordered, requires approval gates between steps, must be resumable/auditable, or must run identically every time. If "skip a step and it breaks" → workflow. If "here's how I usually approach this" → skill. The kernel's State Machine (§4) is the substrate for the workflow form; a skill can *reference* and launch a workflow.

**Q4. Avoiding "越学越烂".** Five structural defenses, none relying on prompt discipline alone: (a) **evidence gate** — no unvalidated active skill (§8); (b) **scoping** — bad repo lessons can't go global (§9); (c) **anti-pattern TTL** — negative beliefs expire and must be re-confirmed (§6 data model), directly defusing Hermes' worst failure; (d) **history-aware curator** — detects thrashing/contradiction across patches (§10); (e) **injection quarantine** — untrusted-content sessions force `manual` review (§8). Overfitting specifically is caught by the "single-Run one-off → auto-reject" gate check.

**Q5. Token control in selection.** Three layers: (1) only `description` strings are *always* in context (the Selector's input) — never bodies; (2) Selector returns a *ranked, budget-capped* set, usage-weighted from the EventLog (high-ignore skills demoted); (3) bodies load lazily and `references/templates/scripts` load only on explicit `skill_view`/script-run. The curator's token-budget pass keeps the description set itself small by demoting bulk into lazy references. Net: cost scales with *relevant* skills, not library size.

**Q6. Sharing across subagents.** Skills carry `audience: AgentRole[]` and `scope`. A code subagent and a research subagent draw from one store but see different *selected* slices (audience-filtered). Provenance is preserved across delegation: a candidate extracted inside a subagent Run is stamped with that role and re-gated before it can broaden its audience. The review/curator forks are themselves subagents on the kernel's Subagent System — so "who can write skills" is just an audience/whitelist policy, uniformly enforced.

**Q7. Enterprise.** Policy values, not code forks: `writeMode = manual` (suggestions only), `background = off` (no silent token burn), `redaction` on the Writer's trace input (secrets never enter a candidate), `retention` caps on traces/skills/snapshots, `approvalRequired` on every promotion (routes through the kernel ApprovalPolicy → Receipt → AuditLog). Because provenance and audit are kernel-level and every mutation yields a Receipt, the enterprise story is "tighten the policy", not "build a separate product."
