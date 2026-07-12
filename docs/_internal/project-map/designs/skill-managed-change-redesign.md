# Skill Managed Change Redesign

## Status

- Status: Verified
- Date: 2026-07-12
- Scope: frozen design for managed Skill identity, prepared changes, approval,
  recovery, provenance, reconciliation, evidence, and the first authored-create
  vertical slice.
- Source check: current Skill proposal, guard, history, stats, host tool, core
  approval, protocol, CLI, and TUI paths were read. The source tree already
  contains session-scoped draft revise/dedupe and an in-progress post-run TUI
  handoff, but not the transaction described here.
- Tests: the Phase 1 safe-authored-create slice passed host evolution/tool
  focused tests, affected typechecks, and TUI approval rendering/controller
  tests. Later phases remain design-only.

## Purpose

Give Skill creation, update, import, evolution, and rollback one managed-change
contract without exposing proposal plumbing as the normal user experience.

The ordinary interaction is:

```txt
inspect final effect -> approve once -> receive the applied result
```

The durable implementation is:

```txt
author final package
  -> persist prepared change
  -> doctor + guard + diff
  -> wait for hash-bound approval
  -> revalidate
  -> idempotently apply
  -> persist history + receipt
```

Proposal storage is retained. It is the recovery, deduplication, audit, hash
gate, and history substrate, not an extra user task.

## Implemented Facts

These are current-source facts, not target-state claims.

- Project Skills are folder packages under `.sparkwright/skills/<name>`.
- `packageHash` covers the package; the older `contentHash` identity primarily
  describes `SKILL.md` and is insufficient for rename/copy reconciliation.
- Model `create_skill` and `update_skill` persist proposals under
  `.sparkwright/skill-evolution/proposals/<proposalId>` and do not apply them.
- Proposal packages contain `metadata.json`, `proposal.md`, `patch.diff`, an
  `after/<skill>` snapshot, and an update `before/<skill>` snapshot.
- Apply verifies the staged after-package hash, reruns the Skill guard, checks
  the base package, writes the target, runs doctor, and writes history.
- Apply rolls back the target when doctor or history persistence fails, but the
  current state model has no durable applying/receipt recovery protocol.
- Model drafts dedupe by session (run fallback), and changed content revises the
  same proposal id with a monotonic revision and prior after-hash. Closed
  proposals are immutable.
- CLI `skills create` and TUI `/create skill` still directly write a Skill;
  TUI `/skill-create` and model tools draft proposals.
- Current risky-tool approval occurs before `create_skill` executes, so it
  approves proposal staging arguments rather than the inspected final effect.
- The in-progress TUI handoff projects proposal metadata into a post-run action
  band. Applying there occurs after the originating run and requires a separate
  low-visibility keyboard flow.
- Proposal list/review/reject/prune, history, and restore are already public
  host/CLI/TUI behaviors and must remain compatible.
- Workflow records and task actor outboxes provide durable waiting patterns,
  but Skill code must not depend on `WorkflowRunRecord` and TUI memory must not
  become the canonical waiting store.
- Spawn-time agent grants establish the useful authorization doctrine: the
  grant is approved at the parent boundary and can authorize only the exact
  scoped downstream effect.
- Skill stats currently use a name/layer/package-hash identity and preserve
  legacy buckets. There is no stable project-local `artifactId` registry yet.
- `create_agent` directly mutates prompt/model/tools configuration and has no
  equivalent proposal/history/restore transaction.

## Adjudicated Design

### Boundary

Managed change semantics depend on whether the approver can inspect the final
effect and whether the approval is bound to it. They do not depend on whether
the caller is CLI, TUI, or a model.

- Explicit authored change with a complete final package: eligible for the
  fast path after validation.
- Incomplete intent, automatic learning, low-confidence suggestion, or batch
  generation: persist to the review inbox; never auto-apply.
- Dangerous findings: show the final effect and risks, then require explicit
  approval for those exact risks.
- Imported/community content: may collect local evidence and propose a local
  project fork; never mutates the external source and never silently enables
  inline-shell preprocessing.

### Common interfaces

The following logical interfaces are frozen before the Skill command service
or agent governance work proceeds. Their physical package may move when the
general managed-artifact lifecycle is extracted, but their fields and
invariants are shared.

```ts
type PreparedChangeState =
  | "ready"
  | "waiting"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "stale"
  | "failed";

interface PreparedChange {
  schemaVersion: 1;
  proposalId: string;
  artifactKind: "skill" | "agent";
  artifactId: string;
  operation: "create" | "update" | "rollback" | "import";
  revision: number;
  state: PreparedChangeState;
  target: { layer: string; path: string };
  basePackageHash: string | null;
  afterPackageHash: string;
  originDigest: string | null;
  capabilityRequirements: string[];
  effectHash: string;
  preparedAt: string;
  updatedAt: string;
}

interface ApprovalReceipt {
  schemaVersion: 1;
  receiptId: string;
  proposalId: string;
  proposalRevision: number;
  effectHash: string;
  decision: "approved" | "rejected";
  approvedRiskFingerprints: string[];
  approvedAt: string;
  actor?: { kind: string; id?: string };
}

interface MutationReceipt {
  schemaVersion: 1;
  receiptId: string;
  proposalId: string;
  effectHash: string;
  artifactId: string;
  beforePackageHash: string | null;
  afterPackageHash: string;
  targetPath: string;
  historyId: string;
  appliedAt: string;
}
```

`SkillCommandService` will expose prepare, inspect, approve, apply/resume,
reject, move/rename/copy/reidentify, import, history, and restore operations.
CLI, TUI, and model tools become adapters over that service rather than owners
of distinct mutation semantics.

### Effect hash

`effectHash` is the SHA-256 of canonical JSON containing only stable final
effect fields:

```json
{
  "schemaVersion": 1,
  "artifactKind": "skill",
  "artifactId": "...",
  "operation": "create",
  "target": { "layer": "project", "path": ".sparkwright/skills/name" },
  "basePackageHash": null,
  "afterPackageHash": "...",
  "originDigest": null,
  "capabilityRequirements": ["project_skill_write"]
}
```

- Canonical objects use fixed key order; requirement arrays are sorted and
  deduplicated.
- `guardPolicyVersion`, guard message text, runtime version, and model identity
  are excluded.
- Revising a proposal changes `afterPackageHash`, revision, and `effectHash`.
  Any prior receipt whose revision/effect hash differs is unusable.

### Guard delta authorization

Guard runs at prepare and immediately before apply. A risk fingerprint is a
stable hash of `ruleId + severity + location + dangerous-object identity`;
message prose is excluded.

- A receipt authorizes the exact dangerous fingerprints visible at approval.
- A guard version or harmless wording change does not require reapproval.
- A new dangerous fingerprint, severity promotion to dangerous, or a changed
  dangerous object returns the change to `waiting`.
- Guard execution failure is fail-closed and leaves the prepared package
  recoverable.

### Waiting and recovery

The canonical waiting state is the persisted prepared change. The active run
is merely one actor that may consume it.

- Fast path: the tool prepares the final package, marks `waiting`, asks through
  the run approval channel with `proposalId + revision + effectHash`, records
  the receipt, and applies before returning the tool result.
- Slow path: if no interactive approver exists, the run is cancelled, or the
  client disconnects, the proposal remains `waiting` and appears in the durable
  Suggestions/Review Inbox.
- A later session reads the proposal, recomputes effect/base/guard state, and
  either resumes apply or marks it stale/requires reapproval.
- A generic actor waiting/outbox interface may reuse the file-backed actor
  substrate, but Skill records must not import workflow record types.

### Crash consistency and idempotency

- `approved` means a valid receipt exists; `applying` means an apply journal or
  mutation intent exists.
- Before target mutation, persist an applying record containing the intended
  effect hash and expected before/after hashes.
- Apply is idempotent: if target already equals `afterPackageHash`, finish
  doctor/history/receipt reconciliation instead of rewriting.
- History identity is deterministic from proposal/effect, or history creation
  detects an existing equivalent entry.
- `applied` is written only after target hash, doctor, history, and mutation
  receipt are all durable.
- A base hash mismatch marks `stale`; it never overwrites.
- A partial target write rolls back from the proposal before snapshot. If
  rollback cannot be proven, state becomes failed with a repair finding rather
  than claiming success.

## Identity and Origin Drafts

### Artifact registry

Proposed versioned store:

```txt
.sparkwright/skill-registry/v1/registry.json
```

It is project data and SHOULD be version controlled. Ephemeral scan locks and
rebuildable indexes live outside the tracked document. Direct unregistered
folders receive an in-memory provisional id during read-only scans; only an
explicit mutation/reconciliation command registers it. Doctor shares the
planner and reports findings but never writes the registry.

```ts
interface SkillArtifactRecordV1 {
  artifactId: string; // project-stable identity
  activePath?: string;
  packageHash?: string; // full current package
  lineageId?: string; // verified upstream lineage only
  derivedFrom?: string;
  status: "active" | "orphaned" | "conflicted";
  createdAt: string;
  updatedAt: string;
}
```

### Origin store

Origin is stored outside the Skill package so operational metadata cannot
perturb `packageHash`:

```txt
.sparkwright/skill-registry/v1/origins/<artifactId>.json
```

```ts
interface SkillOriginV1 {
  kind: "local-path" | "git" | "url" | "registry";
  locator: { canonical?: string; redacted: string };
  revision?: string;
  subpath?: string;
  resolvedDigest?: string;
  importedAt: string;
  importedPackageHash: string;
  updatePolicy: "frozen" | "notify" | "track";
  evolutionPolicy: "disabled" | "manual" | "suggest";
  trust: "trusted" | "community" | "agent-created";
  lineageId?: string;
}
```

Only verified git/registry sources may assert portable `lineageId`. Local paths
do not preserve cross-project lineage by default. Import v1 implements frozen
and notify; track and automatic three-way merge are deferred. Upstream changes
use upstream-to-imported and imported-to-local diffs plus human adjudication.

### Reconciliation doctrine

- Same path, changed content: preserve artifact id; report unmanaged drift.
- Missing path plus one exact `packageHash` at a new path: recognize rename and
  preserve artifact id.
- Missing path plus one content-only match with different package/assets:
  probable rename finding; no automatic decision.
- Missing path plus multiple hash matches: ambiguous move finding.
- Original path still exists plus an exact package copy: allocate a new artifact
  id and optionally record `derivedFrom`.
- New unmatched directory: provisional new artifact; register on explicit
  mutation/reconciliation.
- Registry entry without a directory: orphan tombstone preserving history and
  stats.
- One artifact id at two active paths: blocker requiring owner/copy/reidentify.
- Explicit move/rename/copy/reidentify receipts override heuristics.
- Same-path full replacement defaults to path continuity; users use
  `reidentify` when replacement is semantically new.

## Stats and Evidence Draft

The strong statistics key becomes `artifactId + packageHash`. Do not include
runtime fingerprints in this key.

Each observation may carry bounded attribution dimensions:

- SparkWright/runtime version
- model/provider
- tool catalog digest
- permission/access mode
- effective content hash
- preprocessing policy
- origin kind/digest and lineage id
- evidence pointer plus `available | pruned | inaccessible`

Creation/import writes only artifact/package/origin/history baseline. It does
not invent a zero-use statistics bucket. Local observations begin on first
index/load/run. External project statistics are marked priors/aggregates and
never copied into local facts. Each upstream digest starts a new package bucket.
Evidence labels distinguish association, suspected regression, and confirmed.

Migration keeps existing `name + layer + packageHash` projections readable as
legacy identities. Registry reconciliation maps an unambiguous current package
to an artifact id; ambiguous history stays legacy rather than being guessed.

## Evaluation Metadata Draft

Optional package-external file:

```txt
.sparkwright/skill-registry/v1/evaluations/<artifactId>.json
```

```ts
interface SkillEvaluationV1 {
  objective?: string;
  successSignals?: string[];
  failureSignals?: string[];
  replayCases?: Array<{ id: string; evidence: string }>;
  minimumSamples?: number;
  observationWindow?: { runs?: number; durationMs?: number };
}
```

Validation tiers are manifest/doctor, guard, deterministic fixtures/examples,
historical shadow/replay, post-apply local observation, and rollback
recommendation. V1 implements monitoring and a human rollback recommendation,
not traffic canarying.

## Evolution Pipelines

Keep three independently governed queues:

1. Learning candidates: user corrections, explicit future preference, or
   repeated local observations.
2. Upstream updates: supply-chain change from git/registry/url.
3. Local evolution: a proposed local package or project fork backed by local
   evidence.

Diagnosis chooses a suggested owner before proposing a Skill edit:

| Symptom                     | Suggested owner                              |
| --------------------------- | -------------------------------------------- |
| not routed/not loaded       | description, triggers, matcher               |
| manifest/package invalid    | Skill package                                |
| tool/MCP/agent missing      | capability/config                            |
| permission denied           | policy/agent profile                         |
| command/environment failure | workflow/tool/environment                    |
| loaded but ignored          | Skill content, context competition, or model |
| version regression          | rollback/update proposal                     |

Churn controls: one active proposal per artifact, effect/finding dedupe,
cooldown, review/mutation budgets, digest-only low confidence, reject reasons as
suppression evidence, and stop-after-repeated-reject/supersede. Real-time
interruptions default to explicit current change requests and high-confidence
severe rollback recommendations.

## UX Contract

Ordinary users see three surfaces:

1. Current task completion card: final effect, validation/files summary, and
   Create/Review/Cancel.
2. Persistent Suggestions Inbox: reason, confidence, impact, Review/Dismiss.
3. Skill detail: source, trust, health, usage, version, history, and
   Update/History/Rollback/Advanced.

Proposal ids, hashes, lineage, and raw evidence are Advanced/CLI details. User
copy says create/update/suggestion/rollback. It does not expose internal
off/notice/draft/apply modes or depend on a bare `a/r` action band.

## Failure and Recovery Matrix

| Failure point                        | Durable state                  | Resume behavior                                   |
| ------------------------------------ | ------------------------------ | ------------------------------------------------- |
| author/validation before persistence | none                           | report failure; no proposal                       |
| proposal persistence interrupted     | incomplete dir                 | quarantine/cleanup; never list as ready           |
| no resolver/client leaves            | waiting                        | inbox or later session resumes review             |
| proposal revised after approval      | ready/waiting, new effect hash | old receipt invalid; approve again                |
| guard wording/version changes only   | approved                       | no reapproval; apply after rerun                  |
| new dangerous risk                   | waiting                        | show delta and require reapproval                 |
| guard execution fails                | approved/waiting               | fail closed; retry guard later                    |
| base package drift                   | stale                          | preserve proposal; do not overwrite               |
| crash before target write            | applying                       | verify base/effect and retry                      |
| crash after target write             | applying                       | hash target; reconcile history/receipt            |
| doctor blocks                        | failed or waiting repair       | rollback before package; expose finding           |
| history/receipt write fails          | applying                       | reconcile deterministically; no duplicate history |

## Migration and Compatibility

- Read old `state: draft` proposals as `ready` when no transaction state exists.
- Continue accepting proposal-id list/show/review/apply/reject/prune commands.
- Existing revisions remain valid; missing effect hashes are computed on read
  and persisted only during an explicit managed mutation.
- Existing history is immutable. New mutation receipts point to old history
  when restoring or reconciling it.
- Direct CLI/TUI create commands migrate behind `SkillCommandService`; command
  syntax may remain compatible while mutation semantics change.
- Existing session draft dedupe remains and becomes the one-active-proposal
  rule once artifact ids exist.
- The post-run TUI action band may temporarily consume new waiting metadata,
  but is not the target UX and cannot be the only recovery surface.

## Phased Delivery

### Phase 1: safe authored create vertical slice

- Persist complete authored proposal and effect hash.
- Run doctor/guard/diff before requesting approval.
- Request exactly one approval for `proposalId + revision + effectHash` after
  the final effect exists.
- On approval, persist receipt and apply in the same run/tool episode.
- Leave a durable waiting proposal when no response is available.
- Invalidate approval on revise; enforce base/after hashes; write history and a
  mutation receipt.
- Keep template/intent/dangerous paths in review for this slice.

### Phase 2: command service and four-entry convergence

- Introduce `SkillCommandService` and route CLI create, TUI create,
  `/skill-create`, and model tools through it.
- Replace the bare action band with the completion card and persistent inbox.

### Phase 3: managed Agent changes

- Add prepared final effect, prompt/tool/model/capability diff, hash-bound
  approval, durable waiting/recovery, history, and restore to `create_agent`.

### Phase 4: registry, origin, import, reconciliation

- Ship artifact registry and read-only planner/doctor integration.
- Implement explicit identity commands and frozen/notify import.

### Phase 5: separated evolution and evaluation

- Split learning/upstream/local queues; add owner diagnosis, churn controls,
  evidence bundles, evaluation metadata, observation, and rollback advice.

### Phase 6: generic managed-artifact lifecycle

- Extract common prepared-change/waiting/receipt machinery after Skill and
  Agent prove the interface. Reuse actor substrate without coupling artifact
  records to workflows.

## Tests and Acceptance

Phase 1 is accepted only when tests prove:

- an explicit safe authored create finishes with a valid live Skill, applied
  proposal, history, and mutation receipt;
- proposal persistence precedes approval and the trace contains one approval
  bound to the final effect hash;
- there is no pre-staging approval for this path;
- missing/disconnected approval leaves a recoverable waiting proposal;
- a later session can approve/apply after full revalidation;
- revision changes the effect hash and invalidates the old receipt;
- harmless guard policy/message drift does not reapprove;
- new dangerous findings return to waiting;
- base drift marks stale without overwrite;
- apply resume is idempotent across simulated crashes and does not duplicate
  Skill/history;
- proposal list/review/history/restore and continuation dedupe remain green;
- doctor/reconciliation reads do not write registry state;
- focused tests, affected package typechecks/builds, project-map drift check,
  and the cross-package release gate pass before the slice is called complete.

## Open Questions

- Exact home package for the common interfaces before Phase 6 extraction.
- Whether waiting approval records should share the actor outbox directory or
  expose it through a generic adapter while proposals remain the source of
  truth.
- Stable dangerous-object extraction for findings that currently expose only
  rule/severity/location/message.
- Registry merge/conflict format under ordinary git collaboration.
- Actor identity and delegation fields required in approval receipts.
- Retention and privacy policy for evidence pointers and origin locators.
- Whether templates can become fast-path eligible after an explicit preview or
  should always stay review-required.

## Last Verified

- Status: Verified
- Date: 2026-07-12T02:00:00+0800
- Read: current `packages/skills` identity/guard code; host Skill evolution,
  stats, tool, review and doctor code; core tool/approval/runtime context;
  protocol/CLI/TUI proposal and approval surfaces; workflow/task waiting maps.
- Tests: host Skill evolution/tool suites (109 tests), affected core/host/TUI
  typechecks, focused TUI approval render/controller suites, and full
  `npm run release:check`.
