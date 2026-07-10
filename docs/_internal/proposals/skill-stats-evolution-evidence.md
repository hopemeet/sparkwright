# Skill Stats / Evolution Evidence Plan

Status: draft for review

Date: 2026-06-27

## Summary

Skill self-evolution should not rely on "the model thinks this Skill should
change." It needs an auditable evidence loop:

```txt
raw trace facts
  -> rebuildable stats projections
  -> findings with evidence pointers
  -> proposal draft
  -> human apply/reject
  -> history snapshot
  -> post-apply verification through stats
```

The key boundary:

- `trace.jsonl` remains the durable source of truth for raw facts.
- Skill stats are derived projections and may be deleted/rebuilt.
- Stats may alert and verify, but must not directly mutate Skills.
- Stats may rank findings/review priority only. They must not rank runtime Skill
  loading or selection in v1.
- Skill evolution changes still go through proposal/history/restore.
- Version identity must be captured at emit time in trace facts. Read-time hashes
  of the current filesystem may diagnose current state, but must not identify
  historical runs.

Do not add a `skill.stats.contribution` trace event for the first version. It is
derived data and can be reconstructed from raw Skill events. If performance
requires a fast path, write derived contribution data to a rebuildable projection
cache, not to append-only trace. Adding bounded identity metadata, such as a
package hash, to existing `skill.indexed` facts is different: identity metadata
is raw provenance, not a derived contribution.

## Goals

- Support a closed loop for Skill self-evolution without silent mutation.
- Make Skill update proposals reviewable with concrete run/session evidence.
- Track usage, load failures, version regressions, proposal/apply/restore
  activity, and freshness.
- Distinguish "associated with a Skill" from "caused by a Skill."
- Avoid the current `limit = 20 sessions` default as the self-evolution
  evidence boundary.
- Keep operational counters out of `SKILL.md`.

## Non-Goals

- Do not infer causality from aggregate counts alone.
- Do not let stats directly write, apply, reject, or restore a Skill.
- Do not write global lifetime counters as the only durable truth.
- Do not add a new core event type solely for derived stats.
- Do not treat cache data as authoritative when raw trace disagrees.
- Do not implement runtime/background stats computation in v1. Runtime should
  record raw facts only; projections are built on demand.

## Source Facts

The first version should use existing facts where possible:

```txt
skill.indexed
skill.loaded
skill.failed
tool.failed
run.completed
run.failed
run.cancelled
capability.mutation.completed
```

The first implementation should add `packageHash` to each
`skill.indexed.metadata.skills[]` entry. This keeps the raw event family stable
while making historical Skill identity rebuildable. On-demand `skill.loaded`
events intentionally do not expose `sourcePath`, `contentHash`, or
`packageHash`; stats should join a loaded Skill back to the same run's
`skill.indexed` entry by Skill name.

Additional file-backed facts already exist or belong in the Skill evolution
store:

```txt
.sparkwright/skill-evolution/proposals/*
.sparkwright/skill-evolution/history/*
```

`capability.mutation.completed` is useful audit evidence for file writes, but it
is not the authoritative proposal lifecycle source. Proposal state and history
rollups should read the Skill evolution store metadata.

The useful fact categories are:

- Which Skill was indexed.
- Which Skill was loaded.
- Whether the load was explicit (`skill_load`) or resident context injection.
- Whether loading failed.
- Which run/session the fact came from.
- Which terminal run status followed.
- Which tool failures occurred in the same run.
- Whether a proposal was created, applied, rejected, superseded, stale, failed,
  or restored.
- Whether an applied proposal produced a history snapshot.

## Association Is Not Causation

Stats must not say:

```txt
Skill A caused run B to fail.
```

Stats may say:

```txt
Skill A was loaded in run B, and run B failed.
```

The relation should be explicit in findings:

```ts
type SkillFindingRelation =
  | "associated"
  | "suspected_regression"
  | "confirmed_by_review";
```

Most automatic findings start as `associated`. A finding may become
`suspected_regression` only when version comparison and evidence samples support
that hypothesis, for example after an apply/restore boundary. It becomes
`confirmed_by_review` only through a human review decision or another explicit
verification gate.

## Skill Identity

Stats should aggregate by Skill version, not just by name.

Recommended v1 identity:

```txt
name + layer + packageHash
```

Display can still group by `name`:

```txt
code-reviewer
  project sha256:new: loaded 12, unresolved failures 0
  project sha256:old: loaded 30, unresolved failures 7
```

Notes:

- `packageHash` is the version coordinate already used by proposal/history
  snapshots. Stats should use the same coordinate so version comparisons,
  apply/restore boundaries, and post-apply verification can join cleanly.
- `contentHash` only hashes `SKILL.md`; it misses changes in
  `references/`, `templates/`, and `scripts/`. It may be used as a legacy weak
  fallback, but not as the v1 version identity.
- `packageHash` must be emitted when the Skill is indexed. Computing a package
  hash at stats read time over current files is not valid for historical run
  identity because the filesystem may have changed since the run.
- Emit-time package hashing may use a shared process-local hasher cache keyed by
  package file fingerprint to avoid rereading unchanged packages across runs and
  agents. This is an optimization only; direct package hash computation remains
  available for apply/restore guard checks.
- On-demand `skill.loaded` does not carry identity hashes. The identity resolver
  should join `skill.loaded.payload.name` to the same run's
  `skill.indexed.metadata.skills[]` entry.
- `layer` should come from emit-time identity metadata. If older traces lack it,
  use `unknown` and mark the identity confidence as legacy instead of merging
  unrelated roots.

Suggested identity confidence:

```ts
type SkillIdentityConfidence =
  | "package_hash"
  | "legacy_content_hash"
  | "name_only_unknown";
```

Rules:

- `package_hash` is the only identity strong enough for automatic version
  comparison.
- `legacy_content_hash` may support human diagnostics, but findings must state
  that support-file changes are invisible.
- `name_only_unknown` must not be merged with package-hash identities and must
  not trigger version-regression findings.

## Projection Cache

Use a rebuildable projection for fast stats queries:

```txt
.sparkwright/skill-stats/
  catalog.json
  sessions/<sessionId>.json
  skills/<skillKey>.json
```

The cache is not the source of truth. It is a materialized view over raw trace
and Skill evolution files.

Implemented v1 scope currently writes the session projection cache and a
lightweight `catalog.json` that maps Skill names, Skill keys, and package hashes
to session projections for targeted queries. Full `skills/<skillKey>.json`
rollups remain a follow-up.

### Session Projection

`sessions/<sessionId>.json` stores derived facts for one session trace as of a
specific fingerprint. It must not mean "the session is finished." Sessions are
open-ended containers; the projection is valid only while its fingerprint still
matches the underlying trace.

```ts
interface SkillStatsSessionProjectionV1 {
  schemaVersion: "skill-stats-session.v1";
  algorithmVersion: "skill-stats-trace-v3";
  sessionId: string;
  traceFingerprints: TraceFingerprint[];
  window: {
    firstEventAt?: string;
    lastEventAt?: string;
    runCount: number;
    terminalRunCount: number;
    openRunCount: number;
  };
  skills: SkillStatsEntry[];
  computedAt: string;
}

interface TraceFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}
```

Session projection `SkillStatsEntry` records include per-Skill `firstEventAt`,
`lastEventAt`, bounded `sampleRunIds`, and bounded `failureRunIds`. These fields
make targeted evidence queries possible without rereading raw trace when the
projection is fresh.

### Catalog Projection

`catalog.json` is a routing cache, not a rollup:

```ts
interface SkillStatsCatalogV1 {
  schemaVersion: "skill-stats-catalog.v1";
  algorithmVersion: "skill-stats-catalog-v1";
  sessionProjectionAlgorithmVersion: "skill-stats-trace-v3";
  sessionRootDir: string;
  sessionLimit: number;
  sessions: Array<{
    sessionId: string;
    updatedAt: string;
    traceFingerprints: TraceFingerprint[];
  }>;
  skillKeys: Record<
    string,
    {
      skillKey: string;
      name: string;
      layer?: string;
      packageHash?: string;
      legacyContentHash?: string;
      identityConfidence: SkillIdentityConfidence;
      sessionIds: string[];
      firstEventAt?: string;
      lastEventAt?: string;
    }
  >;
  skillNames: Record<string, string[]>;
  packageHashes: Record<string, string[]>;
  computedAt: string;
}
```

When `--skill`, `--skill-key`, or `--package-hash` is present, stats first tries
the catalog. If the catalog matches the current session list and trace
fingerprints, it only loads relevant session projections. If it misses or is
stale, stats falls back to scanning the requested session window and rewrites
the catalog best-effort.

### Skill Index Projection

`skills/<skillKey>.json` stores query-friendly rollups:

```ts
interface SkillStatsIndexProjectionV1 {
  schemaVersion: "skill-stats-index.v1";
  algorithmVersion: "skill-stats-trace-v1";
  skillKey: string;
  name: string;
  layer?: string;
  packageHash?: string;
  legacyContentHash?: string;
  identityConfidence: SkillIdentityConfidence;
  firstSeenAt?: string;
  lastIndexedAt?: string;
  lastLoadedAt?: string;
  lastExplicitLoadedAt?: string;
  lastFailedAt?: string;
  lastProposalAt?: string;
  lastAppliedAt?: string;
  lastRestoredAt?: string;
  counts: SkillStatsCounts;
  exemplarRunIds: string[];
  proposalIds: string[];
  historyIds: string[];
  findings: SkillStatsFinding[];
  computedAt: string;
}

interface SkillStatsCounts {
  indexed: number;
  residentLoaded: number;
  explicitLoaded: number;
  loadFailures: {
    total: number;
    byMode: Record<string, number>;
    byStatus: Record<string, number>;
  };
  associatedRuns: {
    completed: number;
    failed: number;
    cancelled: number;
  };
  associatedToolFailures: {
    total: number;
    unresolved: number;
    byTool: Record<string, number>;
    byCode: Record<string, number>;
    beforeFirstLoad: number;
    afterFirstLoad: number;
  };
  proposals: {
    draft: number;
    applied: number;
    rejected: number;
    superseded: number;
    stale: number;
    failed: number;
  };
  history: {
    create: number;
    update: number;
    restore: number;
  };
}
```

## Rebuild Policy

Projection cache should be rebuilt when:

- cache file is missing;
- cache JSON is invalid;
- `schemaVersion` is unsupported;
- `algorithmVersion` changed;
- trace fingerprint changed;
- proposal/history metadata changed;
- user explicitly requests rebuild.

There is no reliable session-end hook. v1 should not add runtime/background
projection writers. Readers should build projections on demand and treat any
future projection file as an as-of-fingerprint cache. If a run has no terminal
event, stats may include it in human diagnostics as open/partial evidence, but
evolution evidence and post-apply verification should require terminal runs.

Commands can be added later:

```bash
sparkwright skills stats rebuild
sparkwright skills stats rebuild --all
sparkwright skills evolve evaluate --rebuild-stats
```

The safe behavior is:

```txt
read cache
  -> validate schema + fingerprint
  -> use if valid
  -> otherwise rebuild from raw trace and proposal/history
```

## Stats Query Semantics

Every stats read should be backed by an explicit query shape. This prevents a
common footgun: trace counts from a recent-session window mixed with all-time
proposal/history rollups.

Suggested query shape:

```ts
interface SkillStatsQuery {
  scope: "human_diagnostics" | "evolution_evidence" | "post_apply_verification";
  sessionLimit?: number;
  timeWindow?: { since?: string; until?: string };
  skillName?: string;
  skillKey?: string;
  packageHash?: string;
  includeResidentLoads: boolean;
  includeExplicitLoads: boolean;
  minimumEffectiveSamples?: number;
  proposalBoundary?: {
    proposalId?: string;
    historyId?: string;
    side: "before" | "after" | "since_apply";
  };
}
```

Rules:

- Human CLI diagnostics may keep `limit = 20` as a default, but the report must
  label the session window.
- Evolution evidence must use a target-oriented query: Skill identity, Skill
  name, failure code, proposal boundary, or explicit time window.
- Proposal/history rollups must report their own scope. Do not silently combine
  all-time lifecycle counts with a recent trace window as if they share one
  denominator.
- Version comparisons require `identityConfidence: "package_hash"` and a
  minimum effective sample count on both sides.

## Replacing `limit = 20`

The current human CLI default of "last 20 sessions" is not a good
self-evolution evidence boundary. Recent sessions may be irrelevant, while older
sessions may contain the strongest examples.

Self-evolution queries should be target-oriented:

```txt
for this skill identity, find the latest K relevant runs
for this skill name, compare current version with previous versions
for this apply boundary, compare before/after samples
for this failure code, find Skills associated with repeated failures
for this proposal, find motivating runs and follow-up outcomes
```

Recommended query dimensions:

- `skillKey`
- Skill `name`
- `packageHash`
- `layer`
- time window
- minimum effective samples
- explicit load only vs resident load included
- failure-only samples
- proposal/history boundary

`limit = 20` can remain the default for interactive human diagnostics. The
self-evolution path should use an explicit query window such as:

```txt
latest 50 effective runs for this skill identity
last 30 days for this skill name
all runs since this proposal was applied
```

## Findings

Stats should emit findings, not patches.

Example finding shape:

```ts
interface SkillStatsFinding {
  code:
    | "SKILL_UNUSED"
    | "SKILL_LOAD_FAILED"
    | "HIGH_ASSOCIATED_FAILURE_RATE"
    | "HIGH_UNRESOLVED_TOOL_FAILURES"
    | "VERSION_REGRESSION_SUSPECTED"
    | "RESTORE_AFTER_APPLY"
    | "PROPOSAL_CHURN"
    | "INSUFFICIENT_DATA";
  severity: "info" | "warning" | "attention";
  relation: SkillFindingRelation;
  summary: string;
  evidence: SkillEvidencePointer[];
  metrics: Record<string, number>;
}

interface SkillEvidencePointer {
  kind:
    | "run"
    | "session"
    | "trace_event"
    | "proposal"
    | "history"
    | "doctor_finding";
  id: string;
  reason: string;
}
```

Useful findings:

- current version load failures;
- current version associated unresolved failures;
- new version worse than previous version after apply;
- restore happened soon after apply;
- many proposals for a Skill are rejected/superseded;
- Skill is frequently resident-loaded but rarely explicitly loaded;
- Skill has not been used recently;
- evidence is insufficient to make a recommendation.

Automatic draft trigger boundary:

- Associated tool/run failures alone may only produce `relation: "associated"`.
- Findings based only on associated failures should be `severity: "info"`.
- Associated failures must not trigger an automatic draft proposal by
  themselves.
- Associated failure rollups should distinguish failures that happened before the
  first Skill load from failures that happened after the Skill load, using trace
  `sequence`/`monotonicUs` ordering when available.
- Load failure findings should classify mode/status. `not_found` and
  `resource_denied` are different from resident parse/preprocess failures and
  should not be collapsed into one operational meaning.
- A finding may trigger a draft only when there is stronger evidence, such as an
  explicit user reuse/correction signal, repeated load failures for the current
  package identity, or a package-hash apply/restore boundary with enough
  before/after samples.

## Evidence Bundles For Proposals

Skill proposals should be reviewable through an evidence bundle. The bundle
should contain summaries and pointers, not full trace copies.

Example:

```ts
interface SkillProposalEvidenceBundle {
  skillKey: string;
  proposedChangeReason: string;
  findings: SkillStatsFinding[];
  exemplarRunIds: string[];
  exemplarSessionIds: string[];
  relatedProposalIds: string[];
  relatedHistoryIds: string[];
  topFailedTools: Record<string, number>;
  failureCodes: Record<string, number>;
  versionComparison?: {
    currentPackageHash: string;
    previousPackageHash: string;
    currentSamples: number;
    previousSamples: number;
    currentAssociatedFailureRate: number;
    previousAssociatedFailureRate: number;
  };
}
```

This lets proposal review answer:

- Why did this proposal appear?
- Which runs support it?
- Was the Skill explicitly loaded or merely resident?
- Is this a structural problem or a behavioral correlation?
- Did a previous apply/restore boundary point to regression?

## Evidence Retention And Privacy

Evidence bundles should carry bounded summaries and stable pointers, not raw
conversation, trace, command output, webpage text, or logs.

Rules:

- Proposal metadata may be committed to a project repository, so it must avoid
  long user text and sensitive raw artifacts.
- User feedback evidence should be condensed to a short user-authored excerpt or
  a redacted summary, plus a session/run pointer.
- If a pointer target may be pruned by trace retention, the bundle should say so
  with an availability field rather than pretending the evidence is permanent.
- Proposal review should tolerate missing pointer targets and surface
  "evidence unavailable" instead of treating the proposal as verified.
- Store evidence either in a separate `evidence.json` file or in a bounded
  `metadata.evidence` object, but keep the schema explicit and size-limited.

## Stats Flow And Use Timing

Stats are read-time evidence, not a background writer of Skill changes.

The intended flow:

```txt
run starts
  -> skill.indexed emits package identity metadata
  -> skill.loaded / skill.failed records load mode and load outcome
  -> tool/run terminal events record failures and outcome snapshots

stats query requested
  -> choose query scope and window
  -> read session trace facts, including agent trace files
  -> read proposal/history metadata
  -> resolve loaded Skills to package-hash identities
  -> build the read-time projection
  -> roll up counts, lifecycle metadata, and findings

proposal/evolution path
  -> use stats findings as evidence pointers and review context
  -> model may draft proposal content
  -> human applies/rejects/supersedes/restores
  -> post-apply stats compare package-hash before/after samples
```

Stats should be used at these moments:

- **Human diagnostics:** `skills stats` answers "what happened recently?" and
  may default to the latest 20 sessions. It scans the session `trace.jsonl` and
  agent traces under `agents/<agent-id>/trace.jsonl`, deduping repeated event
  ids so a child run is not counted twice when it appears in both places.
- **Before drafting an evidence-backed proposal:** Skill evolution queries a
  target-oriented window and attaches findings/pointers to the draft.
- **During human review:** CLI/TUI shows the evidence bundle so the reviewer can
  inspect why the proposal exists.
- **After apply/restore:** stats compare samples across the package-hash
  boundary to verify improvement, insufficient data, or suspected regression.

Evolution evidence should count only terminal runs. Human diagnostics may show
open or partial runs, but must label them as such.

Stats should not be used:

- to directly apply, reject, restore, or edit a Skill;
- to boost runtime Skill selection/ranking in v1;
- to claim causation from aggregate same-run failures;
- to identify old runs by hashing the current filesystem.

## Stats And Doctor Boundary

Keep `stats` and `doctor` separate.

Stats owns behavior observations:

- usage;
- freshness;
- load mode;
- load failures;
- associated run outcomes;
- associated tool failures;
- proposal/history activity;
- version comparisons.

Doctor owns structural health:

- missing roots;
- invalid manifests;
- missing resources;
- broken package structure;
- shadowing diagnostics;
- package hash validation;
- guard/trust/inline-shell findings.

Doctor may consume stats for advisories such as "unused for a long time", but
usage is not a structural error.

## Closed Loop

The intended closed loop:

```txt
1. Record raw facts
   - skill indexed/loaded/failed
   - package identity at emit time
   - load mode
   - run/session provenance
   - proposal/apply/reject/restore/history

2. Build projections
   - session projection
   - skill identity projection
   - proposal/history rollups

3. Analyze
   - produce findings
   - attach evidence pointers
   - keep relation as associated unless stronger evidence exists

4. Draft proposal
   - skill-learn / skill-update uses evidence bundle
   - model proposes a change, but does not apply it

5. Human review
   - apply / reject / supersede / prune
   - applied proposals create history snapshots

6. Verify after apply
   - compare post-apply samples with pre-apply samples
   - detect suspected regression or improvement
```

The loop closes only when post-apply stats can verify whether the change helped.

## Phased Implementation

### v1: Version-aware read-time stats

- Add emit-time `packageHash` to `skill.indexed.metadata.skills[]`.
- Use a shared process-local Skill package hasher for runtime indexing so
  repeated runs/agents avoid rereading unchanged package contents; apply
  conservative run-time file/byte guardrails on this identity path.
- Change `collectSkillStats` aggregation from `name` to
  `name + layer + packageHash`, with explicit legacy fallback buckets for old
  traces.
- Join `skill.loaded` back to the same run's `skill.indexed` identity when the
  loaded event lacks path/hash metadata, and also when a resident loaded event
  has `packageHash` but no layer in older traces.
- Preserve grouped display by Skill name.
- Add explicit vs resident load counts.
- Scan `agents/<agent-id>/trace.jsonl` alongside the session trace and dedupe by
  event id.
- Add package-hash-aligned proposal/history rollups from the evolution store;
  keep lifecycle counts separate from trace denominators.
- Add `SkillStatsQuery` semantics and make report windows explicit.
- Add freshness fields with explicit trace/evolution windows.
- Add analyzer findings for legacy/unknown identity, load failures, associated
  tool failures, and evolution activity. Associated tool failures remain
  `relation: "associated"` and `severity: "info"`; they must not independently
  trigger draft proposals.
- Add `.sparkwright/skill-stats/sessions/<sessionId>.json` as a rebuildable
  session projection cache. Rebuild from raw trace when trace fingerprints or
  projection algorithm version change.
- Add `.sparkwright/skill-stats/catalog.json` as a lightweight routing cache for
  targeted Skill queries. It maps targets to session projections only; it does
  not store complete Skill rollups.
- Keep using raw trace as source of truth.
- Keep CLI `limit = 20` for humans, but allow self-evolution callers to pass a
  wider query window.

### v3: Skill identity query index

- Add `.sparkwright/skill-stats/skills/<skillKey>.json`.
- Support target-oriented rollups independent of recent-session ordering.
- Track exemplar runs and evidence pointers.

### v4: Version comparison findings

- Detect suspected regressions or improvements only around version/apply/restore
  boundaries, using package-hash-aligned before/after windows.

### v5: Evidence-backed evolution

- Attach evidence bundles to skill-learn / update proposals.
- Show evidence in CLI/TUI proposal review.
- Use post-apply stats to verify improvement or regression.

## Review Questions

1. Should `layer` be required in the v1 identity, or should unknown layer be
   allowed to avoid dropping older traces?
2. Should session projection and skill identity projection ship together, or
   should v2 only materialize sessions first?
3. Which findings should be considered strong enough to trigger a draft proposal
   automatically?
4. What is the minimum effective sample count before comparing versions?
5. Should proposal evidence live in `metadata.json`, a separate `evidence.json`,
   or both?
6. How should user feedback be represented as evidence without copying full
   conversation content into proposal metadata?
