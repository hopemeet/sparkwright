# Skill Runtime v1 Redesign Proposal

Status: Draft for review
Date: 2026-06-27

> Internal planning document. This proposal does not change runtime behavior by
> itself. It captures a cleanup and upgrade path for SparkWright Skills based on
> current source and internal design notes.

## Purpose

SparkWright already has the important safety posture for Skills: default
on-demand loading, explicit inline-shell opt-in, guarded mutation, proposal
history, and human-only apply/restore. The next upgrade should not mainly add
more surfaces. It should consolidate the split implementation and make the
existing progressive model easier to reason about, test, and evolve.

The target is a small `Skill Runtime v1` contract:

- one canonical manifest shape;
- one default loading mode;
- one trace-visible load path;
- durable sidecar usage data;
- governed mutation through proposals/history;
- experimental surfaces either wired into host/CLI/TUI or clearly demoted.

## Current Facts

Read before reviewing:

- [project map: modules/skills](../project-map/modules/skills.md)
- [project map: capabilities/skills](../project-map/maps/capabilities/skills.md)
- [project map: skill-evolution](../project-map/maps/capabilities/skill-evolution.md)
- [`packages/skills/src/index.ts`](../../../packages/skills/src/index.ts)
- [`packages/skills/src/manifest.ts`](../../../packages/skills/src/manifest.ts)
- [`packages/skills/src/loader.ts`](../../../packages/skills/src/loader.ts)
- [`packages/skills/src/usage-file.ts`](../../../packages/skills/src/usage-file.ts)
- [`packages/host/src/runtime.ts`](../../../packages/host/src/runtime.ts)
- [`packages/host/src/skill-evolution.ts`](../../../packages/host/src/skill-evolution.ts)

Observed implementation shape:

- Host runtime defaults to on-demand loading: inject a lightweight Skill index
  and expose `skill_load`; it does not resident-load matcher-selected Skill
  bodies unless configured.
- `@sparkwright/skills` has two partially overlapping surfaces:
  - legacy `prepareSkillsForRun` / `SkillDefinition` / `body`;
  - discovery protocol `SkillManifest` / `instructions` /
    `loadSkillsFromDirectory` / `SkillRegistry`.
- `parseSkill` in `index.ts` is now a compatibility adapter over the manifest
  parser. The canonical manifest path remains strict about non-empty
  `instructions`; the legacy adapter preserves the old empty-body behavior by
  mapping empty markdown bodies to `SkillDefinition.body: ""`.
- `FileSkillUsageRecorder` exists, but host runtime does not yet wire it into
  Skill selection, `skill_load`, or mutation flows. The file-backed recorder now
  reloads the current sidecar before reads and mutations so two recorder
  instances in one process do not overwrite each other's latest records.
- On-demand `skill_load` already emits `skill.loaded` / `skill.failed` from
  the core run loop with `mode: "on_demand_tool"`. Resident context loading
  emits `skill.loaded` from the skills package with
  `mode: "resident_context"`. Any usage sidecar must preserve that distinction.
- Skill evolution is governed for model-authored mutations: `create_skill` and
  `update_skill` draft proposals, apply is human-only, history keeps snapshots,
  and restore can revert. Manual CLI `sparkwright skills create` remains a
  human direct-write management command.
- Bundles and capability projection exist in `@sparkwright/skills`, but are not
  currently integrated into host/CLI/TUI behavior.
- Public docs now distinguish the low-level helper's resident-context default
  from SparkWright host-created runs, which default to on-demand loading.

## Design Principles

1. **Consolidate before expanding.**
   Remove split contracts and duplicated parsers before adding new Skill
   features.

2. **Default to progressive disclosure.**
   The default run gets only a path-free index. Skill body and resources enter
   context only when `skill_load` is called, or when a config explicitly opts
   into resident loading.

3. **Treat Skills as instructions, not authority.**
   A Skill can suggest tools or workflows. Tool visibility, approvals,
   workspace writes, shell sandboxing, and trace emission remain host/core
   responsibilities.

4. **Keep model writes proposed, not applied.**
   Model-authored changes should create reviewable proposals. Human CLI/TUI
   surfaces apply, reject, supersede, prune, and restore.

5. **Keep operational counters out of `SKILL.md`.**
   Usage, lifecycle state, timestamps, and patch counts live in sidecar state.
   Skill packages stay reviewable and merge-friendly.

6. **Do not persist transient failures as permanent wisdom.**
   Automatic learning must not harden environment failures, flaky tool output,
   repo logs, webpage content, or one-off task narratives into stable Skills.

7. **Expose provenance to diagnostics, not the model.**
   Absolute paths, content hashes, and trust metadata are useful for trace,
   doctor, and apply gates, but should not be injected into provider prompts or
   model-visible `skill_load` output.

## C8 Resolved Decisions (2026-07-06)

C8 closes the four remaining v1 open questions:

- Archived Skills do not enter the model-visible `skill_index`. They may appear
  in human diagnostics such as inspect, doctor, stats, or review surfaces.
- `allowedTools` is a declaration of expected tool needs, not an authorization
  grant. Host/config/policy/toolset compilation remain the only enforcement
  boundary, and loading a Skill must not widen tool visibility.
- Manual CLI `sparkwright skills create` remains a human direct-write management
  command. Model-facing Skill creation and updates remain on the proposal path.
- Bundles are not part of the product/runtime surface for v1. The batch-3
  no-customer audit found no host/CLI/TUI/runtime product consumers, and C8
  removed the package-level bundle helpers, slash resolution, and tests.

## Target Architecture

```txt
skill roots
  -> SkillSourceResolver
  -> SkillManifestLoader
  -> SkillRegistry / SkillIndex
  -> SkillRuntimePreparer
       -> context: path-free skill_index
       -> tools: skill_load(name, resource?)
  -> SkillUsageStore
  -> SkillDoctor / Guard / Evolution
```

### Components

- **SkillSourceResolver**
  Resolves builtin, user, project, and configured legacy roots in weak-to-strong
  order. Owns layer labels and shadow diagnostics.

- **SkillManifestLoader**
  Loads directory `SKILL.md`, flat `*.skill.md`, and `*.skill.json` through one
  parser. Produces the canonical `SkillManifest`.

- **SkillRegistry / SkillIndex**
  Holds effective manifests by name and computes deterministic relevance. The
  model-visible index includes `name`, `description`, `version`, `triggers`, and
  weak relevance hints only. Archived Skills are excluded from this index.

- **SkillRuntimePreparer**
  Replaces the current dual-purpose `prepareSkillsForRun` internals. It turns
  manifests into context and tools, but does not own process execution,
  approvals, or policy.

- **SkillLoadTool**
  The governed path for on-demand Skill body/resource loading. Core already
  projects `skill_load` tool results into `skill.loaded` / `skill.failed`
  events; v1 should consume those events rather than adding a second emission
  path.

- **SkillUsageStore**
  Durable sidecar recorder backed by a stale-safe file recorder. It records
  load/mutation observations for stats and doctor. It must not drive Skill
  ranking in v1; usage-aware routing is a later experiment after the observation
  signal is proven useful.

- **SkillDoctor / Guard**
  Doctor validates structure and package hashes. Guard inspects trust, dangerous
  content, secret-exfil patterns, script assets, and inline shell. Keep these
  separate: doctor answers "is this package structurally valid?", guard answers
  "is this content safe enough for this trust level?"

- **SkillEvolution**
  Owns proposal, apply, reject, supersede, prune, history, and restore. Model
  tools may draft proposals only; manual CLI direct writes remain a human
  management surface.

## Canonical Manifest

`SkillManifest` should be the package-wide internal shape:

```ts
interface SkillManifest {
  name: string;
  description: string;
  instructions: string;
  triggers?: string[];
  examples?: string[];
  allowedTools?: string[];
  requiredCapabilities?: string[];
  version?: string;
  license?: string;
  compatibility?: string[];
  source?: string;
  assetsDir?: string;
  assets?: Partial<Record<"references" | "templates" | "scripts", string[]>>;
  metadata?: Record<string, unknown>;
}
```

Compatibility rules:

- Old `SkillDefinition.body` becomes an adapter-only alias for
  `SkillManifest.instructions`.
- Phase 1 decision: keep `parseSkillManifest` strict and keep `parseSkill` as a
  compatibility adapter. Empty instructions are invalid for canonical
  manifests, but an old `SKILL.md` with an empty body still parses through
  `parseSkill` with `body: ""`.
- `license` and `compatibility` are first-class compatibility fields and must
  not disappear during manifest unification.
- `version` may be authored as a top-level manifest field or as
  `metadata.version`; loaders normalize either form to the canonical manifest
  `version`, while the legacy adapter bridges top-level `version` back into
  `metadata.version` for old consumers.
- `loadSkills`, `loadSkill`, and `prepareSkillsForRun` may stay exported during
  migration, but they should internally use manifests.
- `contentHash` and package hash remain diagnostic/apply metadata, not part of
  model-visible manifest output.

## Loading Contract

Default host behavior:

1. Resolve and parse effective Skills.
2. Inject one path-free `skill_index` context item.
3. Register `skill_load` unless `includeLoaderTool: false`.
4. Do not resident-load selected Skill bodies unless
   `loadSelectedSkills: true`.

`skill_load(name)` returns:

- status;
- name;
- description;
- version;
- body content;
- skill-relative resource file list.

`skill_load(name, resource)` returns the resource content only if the resolved
path stays inside the Skill package and the file is an allowed support file.

Resident loading remains an advanced compatibility mode for small, stable,
high-priority Skills. It should not be described as the default in public or
internal docs.

## Usage Sidecar

Wire a fixed `FileSkillUsageRecorder` into host runtime behind a small
host-owned resolver, for example:

```txt
.sparkwright/skill-usage.json
```

or, if we want all evolution-adjacent state together:

```txt
.sparkwright/skill-evolution/usage.json
```

Entry condition: the file recorder must reload/merge on mutation (or use an
append-log / host singleton with equivalent guarantees) before host wiring.
The existing load-once + whole-file-rewrite behavior loses updates across
multiple recorder instances.

Suggested observations for v1:

- `recordExplicitLoad(name)` or equivalent when a Skill body is successfully
  loaded through on-demand `skill_load` (`mode: "on_demand_tool"`).
- `recordResidentLoad(name)` or equivalent when a Skill body is injected by
  configuration (`mode: "resident_context"`). This is a load observation, not
  evidence that the model selected the Skill.
- `recordPatch(name)` when a proposal apply, restore, or direct manual create
  mutates a project Skill.
- `state: active | stale | archived`, controlled by explicit CLI/TUI commands
  first; automatic stale/archive can be a later phase.

Do not treat tool failures after loading a Skill as proof the Skill caused the
failure. Existing stats already correctly calls them associated failures, not
causal failures.

Do not feed usage into ranking in v1. The first durable sidecar should support
stats and doctor only. A later usage-ranking experiment may use
`on_demand_tool` loads as a weak positive signal, but must not boost
`resident_context` loads.

## Mutation Boundary

Keep the actor split:

```txt
model tools       -> draft proposal
human CLI/TUI     -> apply / reject / supersede / prune / restore
filesystem effect -> project skill package + history snapshot
```

Recommended change:

- Keep model-facing `create_skill` on the proposal path instead of writing
  directly; the direct writer is the clearly human/manual CLI-only operation.
- Keep project Skill root as the only writable v1 target:
  `.sparkwright/skills/`.
- Keep builtin, user, and legacy roots read-only for evolution; update creates a
  project fork/shadow proposal when the effective Skill comes from those layers.
- Keep draft and apply guard checks independent. A draft can record caution
  findings; apply blocks dangerous findings unless a human force path is used.

## Bundles And Experimental Surfaces

Current bundle/capability helpers should not remain ambiguous.

C8 decision for v1: bundles are killed from the SparkWright product/runtime
surface. Batch 3 verified there were no host/CLI/TUI/runtime product customers
and removed `bundles.ts`, slash resolution, and the package-level tests.

Do not reintroduce bundle behavior in user-facing docs unless a future host
behavior exists. If a future product need revives bundle-like behavior, it must
use the same `skill_load` and usage/trace path rather than injecting untracked
bodies.

## Doctor Upgrades

Add checks after the manifest unification lands:

- duplicated parser/schema drift should be impossible;
- stale docs/default mismatch: docs should say default is on-demand;
- oversized `SKILL.md` body warning;
- too many support files warning;
- missing usage sidecar warning only when usage scoring is enabled;
- legacy root effective warning retained;
- shadow/fork diagnostics retained;
- model mutation boundary warning if any model-facing tool applies current
  Skill package changes directly.

Doctor should stay deterministic. It should not call a model.

## Delivery Plan

### Phase 0: Documentation cleanup

- Update `packages/skills/README.md` and `docs/reference/SKILLS.md` to say
  on-demand loading is the host default.
- Add this proposal to the internal proposal set.
- Update the project map to state that model-facing create/update tools draft
  proposals and human CLI/TUI surfaces own apply/direct management.
- No runtime changes.

### Phase 1: Manifest unification decision + compatibility tests

- Implemented decision: canonical manifests require non-empty `instructions`;
  legacy `parseSkill` delegates through a compatibility adapter that preserves
  empty markdown bodies.
- `SkillManifest` is the parser-normalized shape for skill metadata fields:
  description validation, list splitting, `license`, `compatibility`,
  `allowedTools`, top-level `version`, and `metadata.version`.
- `SkillDefinition.body` remains the exported compatibility alias for
  `SkillManifest.instructions`; top-level `version` is bridged into legacy
  metadata when needed.
- Tests cover empty body, description required/length rules, first-class
  compatibility fields, list splitting, `metadata.version`, and the intentional
  `parseSkill` / `parseSkillManifest` strictness difference.

### Phase 2a: Fix usage recorder durability semantics

- Implemented baseline: `FileSkillUsageRecorder` keeps the sync hot-path
  interface and reloads before reads/mutations so multiple instances for one
  path do not overwrite each other's latest records.
- Keep this as a prerequisite for any host usage observation hookup.
- Tests: two recorder instances constructed before either writes must preserve
  both instances' increments and state changes.

### Phase 2b: Usage observation hookup

- Implemented baseline: host resolves the durable sidecar at
  `.sparkwright/skill-usage.json` through `packages/host/src/skill-usage.ts`.
- Runtime subscribes to `skill.loaded` events before buffered extension events
  are flushed, so both successful on-demand `skill_load`
  (`mode: "on_demand_tool"`) and configured resident loads
  (`mode: "resident_context"`) are recorded.
- `SkillUsageRecord` keeps aggregate `useCount` plus separate
  `explicitLoadCount` and `residentLoadCount` fields; `recordPatch` records
  proposal apply, restore apply, and direct project `skills create` mutations.
- Observations are best-effort and advisory. A bad sidecar must not break a
  run or a successful mutation. Skill ranking remains unchanged in this phase.
- Tests: recorder load-mode persistence, runtime resident-load observation,
  simulated on-demand load observation, proposal apply/restore `recordPatch`,
  and direct CLI create `recordPatch`.

### Phase 3: Usage ranking experiment (deferred)

- Add only after sidecar observations show keyword ranking misses that usage can
  plausibly improve.
- Must be opt-in and default off.
- Must use only `on_demand_tool` loads as a weak positive signal; resident loads
  are not selection evidence.
- Must preserve deterministic fallback ordering for Skills with no usage data.

### Phase 4: Mutation boundary cleanup

- Implemented baseline: model-facing `create_skill` and `update_skill` draft
  proposals only. Manual CLI `sparkwright skills create` remains the human
  direct-write management path.
- Remaining cleanup is documentation/diagnostic hardening around the existing
  actor split, not moving model create off a direct-write path.
- Preserve guard, doctor, hash, rollback, and history behavior.
- Tests: model create/update draft only; CLI apply writes; restore still works.

### Phase 5: Delete experimental bundle surface

- C8 outcome: bundles are not promoted to runtime behavior.
- Implemented 2026-07-06: Batch 3 no-customer audit found no product
  consumers, then deleted bundle helpers, slash resolution, exports, and tests.

## Non-Goals

- No background auto-writer by default.
- No semantic/vector retrieval requirement.
- No broad YAML parser unless a real use case requires it.
- No direct execution of Skill-authored scripts during discovery.
- No automatic mutation of user, builtin, or legacy Skill roots.
- No claim that associated run failures were caused by loaded Skills.

## Resolved Questions

- Archived Skills are excluded from model-visible `skill_index` and visible only
  to human diagnostics.
- `allowedTools` remains declarative and does not authorize tools.
- Manual CLI `skills create` remains direct-write for humans; model paths draft
  proposals.
- Bundles are pending deletion unless the batch-3 no-customer audit finds a real
  product consumer.

## Review Decision: 2026-07-03 Source Check

The review pass against current source confirmed the main design direction but
changed the implementation priority. The closed loop should be made reviewable
before adding more durable observation plumbing.

Decision: implement in this order:

1. **Proposal quality first.** Model-facing `create_skill` currently accepts
   only `action` / `name` / `description` / `root`, so new-Skill proposals can
   degrade into a frontmatter shell plus a generated one-line body. Add a
   `body` (full `SKILL.md`) parameter and plumb it into the existing
   `createSkillCreateProposal({ content })` path. `update_skill` already has a
   `body` parameter; when omitted it deliberately appends a
   `## Proposed Evolution` intent stub, so review surfaces should label that as
   intent-only and high-friction for apply.
2. **Review digest second.** A useful digest does not need the usage sidecar.
   Existing trace-based `skills stats` already produces load-failure findings,
   associated tool-failure findings, proposal/history rollups, and freshness
   windows. Route those findings, draft proposal backlog, and learning drafts
   into a human action queue before investing in long-horizon sidecar signals.
3. **Usage sidecar third.** Wire successful on-demand loads, resident loads,
   and skill mutations into `FileSkillUsageRecorder` after the proposal/review
   path can produce actionable content. The sidecar remains advisory; ranking
   stays a deferred, opt-in experiment.

Implementation status (2026-07-03): the three ordered steps above have a
baseline implementation. `create_skill` accepts authored `body` content (full
`SKILL.md` or instructions-only content wrapped by the host with `name` and
`description`); proposal metadata records `contentMode` so review surfaces
label authored/template/intent-only proposals; `skills review` aggregates draft
proposal backlog with load/tool-failure findings from trace stats; and the host
writes successful load + patch observations into
`.sparkwright/skill-usage.json` without changing Skill ranking.

Real-model mini QA (2026-07-03) found that a natural create-Skill prompt could
lead the model to guess `skill_load(resource: "README.md")` for the builtin
capability-builder Skill and to pass only prose in `create_skill.body`. The
follow-up fix keeps missing resources as trace-visible failures but includes
available reference files for recovery, and normalizes create bodies that are
authored instructions rather than full frontmatter documents. A re-run with
`openai/gpt-5.4-mini` created an authored draft proposal without tool failures.

Source-check clarifications:

- Trace-based observation remains the primary stats evidence:
  `skill_load` results emit `skill.loaded` / `skill.failed`, and
  `skills stats` consumes those events. Durable sidecar recording is now wired
  separately for successful loads and mutations, and remains advisory rather
  than a causal or ranking signal.
- `selectSkills` (resident context) and `rankIndexedSkillsByGoal` (on-demand
  index ordering) share the private `scoreSkillAgainstGoal` helper in
  `packages/skills/src/index.ts`. The duplicated scoring surface is
  `index.ts`'s legacy prepare/rank path versus `packages/skills/src/matcher.ts`
  and `SkillRegistry.match`.
- `matchSkills` is already reused by delegate routing in
  `packages/host/src/delegate-capability.ts`. Any consolidation into one
  shared matcher should move toward the addendum's shared routing layer and
  must include delegate-routing regression tests so Skill ranking changes do
  not silently change agent/delegate exposure.
- `/skill-learn apply` is a bounded automatic write path: it only auto-applies
  the `session-learnings` proposal, still goes through `applySkillProposal`
  hash/doctor checks, and uses only the user's prompt as evidence. It is not a
  general bypass of the human apply boundary, but it is the one configured path
  from an explicit user instruction to persistent loadable Skill text without a
  separate review click. Capability inspection and docs should say that
  clearly.
- `session-learnings` is the TUI automatic-learning sink. C10 deleted the
  prompt-text `detectSkillLearnTarget` guesser, so automatic `/skill-learn`
  drafts no longer infer an existing named Skill from prose; explicit update
  paths can still pass a target name into the proposal helper. There is still no
  lifecycle that clusters accumulated learnings, proposes promotion into a new
  named Skill, or archives stale learnings.

## Review Prompt

Use this prompt in a fresh review window:

```txt
Review docs/_internal/proposals/skill-runtime-v1-redesign.md in the SparkWright
repo. Treat it as an internal design proposal with some baseline fixes already
landed and the remaining phases still proposed.

Please check:
1. Does the proposal accurately describe the current Skill implementation in
   packages/skills/src/* and packages/host/src/runtime.ts?
2. Are the recommended consolidations sound, especially making SkillManifest the
   canonical internal shape and keeping default loading on-demand?
3. Does the mutation boundary remain safe enough: model drafts proposals, human
   CLI/TUI applies, project root is the only writable v1 target?
4. Is the usage sidecar hookup practical with FileSkillUsageRecorder, and is the
   suggested event timing correct?
5. Which items should be deleted/demoted instead of implemented, especially
   bundles/capability projection and any duplicated parser surfaces?
6. Identify missing tests, hidden migration risks, or places where this proposal
   contradicts current project-map contracts.

Return findings first with file/line references, then a short recommendation:
approve, approve with changes, or redesign needed.
```

---

# Addendum: Capability Exposure Convergence (Skill / MCP / Agent / Delegate)

Status: Accepted for A-Phase 1-3; A-Phase 4 deferred to shared-routing review
Date: 2026-06-27

> This addendum widens the lens. The body above redesigns the Skill subsystem
> *internals*. This section is about *exposure*: how each external-capability
> surface is presented to the model's tool list and prompt. The thesis is that
> the Skill runtime's progressive-disclosure model is the canonical template, and
> MCP / Agent / Delegate should converge onto one shared substrate that already
> exists in `@sparkwright/core`. The Agent surface has already been refactored to
> this model (working tree, uncommitted on `feat/access-mode`); this addendum
> records that landing and proposes carrying the same pattern to MCP.

## C1 Disposition (2026-07-06)

C1 accepts the addendum direction through A-Phase 3 and defers A-Phase 4. Source
recheck on 2026-07-06 confirmed that the Agent indexed exposure baseline is on
current main (`delegate_agent`, `pinnedDelegates`, shared configured-delegate
ledger), while `mcp_call` / `pinnedTools` remain proposal-only.

Accepted sequence:

- A-Phase 1 records and stabilizes the Agent landing.
- A-Phase 2 structures the Agent index.
- A-Phase 3 aligns MCP to the indexed model with `mcp_call`, name-level
  deferral, and `pinnedTools`, opt-in first.
- A-Phase 4 shared routing is deferred and must be reviewed together with the
  capability-upgrade Phase 3b rank-before-hide routing work.

## A.0 The governing principle: load-cost vs invoke-cost asymmetry

The four surfaces look similar ("inject an external capability into the run"),
but they split on one axis that determines how aggressive disclosure can be:

- **Loading a Skill = injecting text.** Cheap, idempotent, reversible. A wrong
  load costs a little context, nothing else. So a Skill can afford the most
  aggressive disclosure: its name is **not even a tool** — it lives in a prose
  index and `skill_load` pulls the body on demand.
- **Invoking an Agent / MCP tool = a real call** with side effects, latency,
  cost, and (for agents) a spawned sub-run. Not idempotent. A wrong invocation
  is expensive. So an invoked capability must keep *discovery* resident (the
  model must see the index without paying a search round-trip first) even while
  it defers *schema* and folds individual capabilities behind a generic invoker.

This is why "make agents exactly like skills" is wrong in the limit: agents keep
a resident generic invoker (`delegate_agent`) carrying the index, rather than
pushing discovery itself behind a search step.

## A.1 The four surfaces today (three maturity tiers)

| Surface | Discovery (index) | Schema cost | Name-level bloat | Relevance routing | Invoke cost | Cross-entrypoint dedup |
|---|---|---|---|---|---|---|
| **Skill** | dedicated prose index | 0 until `skill_load` | none (name not a tool) | yes (matcher) | ~0 (text) | N/A |
| **MCP** | none; resident tool **names** are the index | 0 by default (`defer` → `tool_search`) | **yes** (every tool name resident) | **no** | high | not needed |
| **Agent** (landed) | index embedded in `delegate_agent` description | **1** (one generic tool) | none (default `indexed`) | not yet | high | **yes** (unified ledger) |
| **Delegate** (legacy `all`) | none | **N** | yes | no | high | partial |

Ranking for "invoked + growing in count": **Agent (indexed) > MCP (defer) >
legacy Delegate.** Skill is a different category (best for free-to-load text),
not directly comparable. The notable result: the Agent refactor **overtook MCP** —
MCP solved schema bloat but never solved name bloat or routing.

## A.2 The shared substrate already exists in core

Convergence does not require new infrastructure. `@sparkwright/core` already
ships the generic deferred-tool machinery — the same pattern the agent harness
itself uses:

- `tool_search` lazy discovery: deferred tools are listed by name + short
  description; full JSONSchema is **not** sent to the provider until the model
  calls `tool_search`
  ([`packages/core/src/tool-search.ts`](../../../packages/core/src/tool-search.ts),
  dispatch at [`run.ts:2835`](../../../packages/core/src/run.ts), defer skip at
  [`run.ts:2944`](../../../packages/core/src/run.ts), capability-delta context at
  [`context.ts:1557`](../../../packages/core/src/context.ts)).
- `deferLoading` flag on `ToolDefinition` + an `alwaysLoad` override.
- A config-driven defer list `capabilities.tools.defer`
  ([`tools.ts:930` `applyToolConfig`](../../../packages/host/src/tools.ts)),
  whose `DEFAULT_DEFERRED_TOOLS` already defers `todo_write`,
  `read_anchored_text`, `edit_anchored_text`, `create_skill`, `create_agent`,
  `cron`.
- MCP already rides it **by default**:
  [`runtime.ts:271` `mcpToolSchemaLoad`](../../../packages/host/src/runtime.ts)
  returns `defer` unless `startup: eager`;
  [`mcp-adapter/src/index.ts:905`](../../../packages/mcp-adapter/src/index.ts)
  maps `defer` → `deferLoading: true`.

So Skill, MCP, and the deferred built-ins are already three consumers of one
substrate. Agent and legacy Delegate are the outliers.

## A.3 What landed on the Agent surface (reference implementation)

The Agent refactor is the working template for the rest of this addendum.
Verified in the working tree:

- **Default exposure flipped to `indexed`.**
  [`directDelegateExposureMode`](../../../packages/host/src/runtime.ts) returns
  `config?.exposure ?? "indexed"`. Individual `delegate_*` tools are no longer
  emitted by default; only pinned profiles (`pinnedDelegates`) or
  `exposeAsDelegate: true` get a direct tool.
- **Generic invoker `delegate_agent`** (`DELEGATE_AGENT_TOOL_NAME`,
  [`runtime.ts`](../../../packages/host/src/runtime.ts)) takes `{ agentId?,
  toolName?, goal, metadata? }`. The agent **index is carried inside its
  description** (`Available agents: reviewer (delegate_reviewer), ...`), so
  discovery stays resident without a `tool_search` hop.
- **Per-target guardrails preserved through the facade.** `delegate_agent`
  resolves the target then transcodes to `target.tool.policyForArgs(...)` and
  `target.tool.execute(...)` — so each agent's policy / governance /
  `workspaceAccess: none` admission survives the generic entry point. This is
  the key correctness property: the generic tool is a *router*, not a
  reimplementation.
- **Unified delegation ledger (the deep fix).** Dedup moved from a closure-local
  map to a parent-attached `delegationLedgersByParent` WeakMap keyed by
  `DelegationLedgerKey`
  ([`agent-runtime/src/index.ts:1068`](../../../packages/agent-runtime/src/index.ts)).
  Direct delegate, `delegate_agent`, and `delegate_parallel` all converge on the
  **same** `configuredDelegateLedgerKey(profileId, toolName)`
  ([`runtime.ts` configured delegate](../../../packages/host/src/runtime.ts) and
  the parallel path), so a goal already completed via a single delegate is
  recognized by the parallel path — the original "two singles then parallel =
  double run" failure is structurally gone, not patched.

Open follow-up on the Agent surface itself: the index is an unstructured blob
inside one description string. It grows linearly with agent count and has no
trigger/relevance gating. That is the seam Phase A.5 (routing) addresses.

## A.4 Proposal: align MCP to the indexed model

MCP is the least-evolved invoked surface. Bring it to the Agent tier,
symmetrically:

- **A.4a Name-level deferral (not just schema).** Add an MCP exposure mode that
  keeps tool **names** out of the resident list and behind discovery, mirroring
  `exposure: indexed`. Today `defer` only hides the schema; the names still
  bloat at high server/tool counts. Reuse `deferLoading` + `tool_search` for the
  name tier rather than inventing an MCP-specific index.
- **A.4b Generic invoker `mcp_call({ server, tool, args })`**, the MCP analogue
  of `delegate_agent`. It must transcode to the concrete MCP tool's policy /
  governance / approval exactly as `delegate_agent` does, so per-tool risk and
  approval gates are not flattened.
- **A.4c Pinned escape hatch** `capabilities.mcp.pinnedTools` (analogue of
  `pinnedDelegates`): high-value MCP tools stay direct.
- **Compatibility:** default stays at today's behavior (`defer`, names resident)
  until A.5 routing quality is proven; name-level deferral ships opt-in first.

## A.5 Proposal: one relevance-routing layer for delegate + MCP

Routing should not be per-surface. Build a single deterministic relevance layer
(reusing the CJK-aware Skill matcher, see `agent-capability-upgrade.md` Phase 3b
and `[[project_skill_selection_probes]]`) that scores both delegate targets and
MCP tools against the goal / `triggers` / `when.keywords` / description.

Hard constraints, inherited verbatim from `agent-capability-upgrade.md`
Review decision #5 (2026-06-27):

- **Rank before hide.** The default middle state annotates `relevant` / `low`
  and orders the index; it does not remove entries.
- **Hiding is opt-in and observable.** Any narrowing of the visible set is
  off-by-default and must leave a trace ("hidden/demoted X because matcher did
  not fire"). A matcher miss must never silently swallow a capability the user
  expected.
- **Escape hatches always win:** pinned delegates / pinned MCP tools and
  explicit author intent are never hidden.

## A.6 Config surface (target)

```jsonc
{
  "capabilities": {
    "agents": {
      "exposure": "indexed",            // landed default
      "pinnedDelegates": ["delegate_reviewer"],
      "enableParallelDelegates": true
    },
    "mcp": {
      "exposure": "all",                // A.4: flip to "indexed" opt-in first
      "pinnedTools": [],
      "toolSchemaLoad": "defer"         // existing
    },
    "routing": {                        // A.5: shared, not per-surface
      "mode": "rank",                   // "rank" (default) | "hide" (opt-in)
      "directLimit": 3
    }
  }
}
```

## A.7 Delivery plan

C1 decision: A-Phase 1-3 are accepted as the next capability-exposure sequence;
A-Phase 4 is deferred to the shared-routing / capability-upgrade Phase 3b
review.

- **A-Phase 1 — record + stabilize the Agent landing.** Tests asserting
  single→parallel cross-entrypoint dedup (same ledger key), per-target policy
  preserved through `delegate_agent`, and `exposure: indexed` default. Migration
  note: the default flip removes `delegate_*` names for existing configs unless
  pinned — surface it in `agents list` / capability inspect, do not let it happen
  silently.
- **A-Phase 2 — structure the agent index.** Move it out of the `delegate_agent`
  description blob into a structured, trigger-aware index entry.
- **A-Phase 3 — MCP alignment (A.4).** `mcp_call` facade + name-level deferral +
  `pinnedTools`, opt-in.
- **A-Phase 4 — shared routing (A.5).** Rank-before-hide layer spanning delegate
  + MCP; hide mode opt-in + traced.

## A.8 Risks / tradeoffs

- **Default exposure flip (already shipped on Agent) is a behavior change.**
  Every existing config loses resident `delegate_*` names. Legitimate product
  call, but needs a migration note and inspect-surface visibility, not silence.
- **MCP name deferral changes the provider tool list** for every run that opts
  in — ship opt-in, validate, then consider default.
- **Routing that hides** reintroduces the "silently dropped the tool the user
  wanted" failure. Mitigated by rank-before-hide + opt-in + trace + pins.
- **Facade flattening.** A generic invoker that forgot to transcode per-target
  policy would erase per-capability approval/risk. The Agent implementation
  avoids this; MCP's `mcp_call` must replicate it exactly.

## A.9 Cross-references

- Skill internals: body of this document (Skill Runtime v1).
- Agent phases 1–4 and the locked Review decisions: `agent-capability-upgrade.md`.
- Deferred-tool substrate: `packages/core/src/tool-search.ts`.

## A.10 Review prompt (addendum)

```txt
Review the "Capability Exposure Convergence" addendum in
docs/_internal/proposals/skill-runtime-v1-redesign.md.

Check, with file/line references:
1. Does A.1's tier table match actual exposure for Skill/MCP/Agent/Delegate in
   packages/host/src/runtime.ts, packages/mcp-adapter/src/index.ts, and
   packages/core/src/tool-search.ts?
2. Is the A.3 claim true that direct delegate, delegate_agent, and
   delegate_parallel share one DelegationLedgerKey, so cross-entrypoint dedup
   actually fires? Verify the key construction at both spawn sites.
3. Does delegate_agent genuinely preserve per-target policy/governance by
   transcoding to target.tool.execute / policyForArgs?
4. Is the A.4 MCP alignment sound and non-breaking as an opt-in, and does the
   A.5 routing layer honor the rank-before-hide / opt-in / trace constraints from
   agent-capability-upgrade.md Review #5?
5. Is the default exposure flip to "indexed" adequately flagged as a behavior
   change with a migration surface?

Return findings first, then: approve, approve with changes, or redesign needed.
```
