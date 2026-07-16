# Asset Package and Governance Redirection Review

## Review Status

- Status: Read-only
- Date: 2026-07-12
- Purpose: adjudicated review handoff recording the frozen redirection applied
  to the implementation-ready Skill managed-change master design.
- Source check: current Skill package hashing/evolution, Markdown Agent
  discovery, Workflow folder parsing/script execution/version pinning, Agent
  trace attribution, and Workflow usage/event paths were read.
- Tests: not run; this document proposes design changes and does not change
  runtime behavior. The decisions below are closed unless new implementation
  evidence requires reopening them.

## Executive Decision

The existing Skill managed-change implementation remains valid. The design no
longer assumes that Agent and Workflow assets need the same proposal,
approval-receipt, history, restore, registry, or self-evolution lifecycle.

The revised direction is:

1. Keep the complete managed-change transaction for project Skills.
2. Separate managed Skill mutations from direct filesystem/Git mutations.
3. Make package identity cover every ordinary file that can affect behavior.
4. Treat Markdown Agents as user-owned files/packages with validation,
   semantic diff, ordinary final-write approval, and version attribution—not a
   Skill-style proposal store.
5. Treat Workflows as version-pinned folder packages. Fix package identity and
   resume consistency before considering authoring proposals or evolution.
6. Preserve Agent and Workflow statistics as trace-derived, package-versioned
   observations, but do not use them to trigger automatic mutation yet.
7. Share package and observation primitives where they are genuinely common;
   do not extract a generic managed-artifact lifecycle on the current evidence.

This is a correction of scope, not a rejection of the Phase 1/2 Skill work.

## Background

The original design started from a real Skill problem: model-authored Skill
changes needed a recoverable prepared package, an approval bound to the final
effect, optimistic concurrency, history, and rollback. Phase 1 and Phase 2 now
provide that path for the converged creation surfaces.

The design then projected the same lifecycle onto Agent and, eventually,
Workflow assets. Review exposed three differences:

- A Skill is already a multi-file package and has an active proposal/evolution
  product flow. Its managed transaction solves an observed mutation boundary.
- A Markdown Agent is primarily an author-readable role/profile document. Git,
  file diff, validation, and existing workspace-write approval already solve
  most ordinary authoring needs. Its advanced project-wide governance remains
  in config and should not be casually mutated by an Agent authoring tool.
- A Workflow is a folder asset plus a durable running instance. Its immediate
  correctness requirement is that `workflow.md`, config, and executable scripts
  share one pinned package identity. Asset evolution is secondary to reliable
  execution and resume.

The current implementation also exposes two package-identity gaps:

- Skill `packageHash` currently covers `SKILL.md` plus only
  `references/`, `templates/`, and `scripts/`. A behavior-affecting ordinary
  file elsewhere in the Skill directory can be omitted from hash, snapshot,
  diff, history, and restore.
- Workflow `contentHash` currently covers only `workflow.md`, while optional
  config and asset-local scripts can affect execution. Script invocation
  resolves against the live asset directory, so Markdown-only identity is not
  sufficient evidence that a resumed execution uses the same package.

## Product and Design Principles

### User-owned Markdown remains primary

Skill, Agent, and Workflow assets should remain understandable and editable
without a SparkWright-specific database. Direct editor and Git operations are
valid inputs, not corruption by definition.

### The filesystem is current truth; managed records are provenance

A managed receipt proves what SparkWright prepared, approved, and applied. It
must not claim authorship of a direct user/Git edit. A reconciliation operation
may establish a new baseline, but it must record that the content was adopted,
not retroactively approved and applied by SparkWright.

### Hash everything that can affect behavior

An asset version identity is incomplete if an executable, config, prompt,
reference, template, fixture, or other consumed ordinary file can change while
the identity remains stable.

### Asset definition and runtime state stay separate

No run state, logs, leases, receipts, stats caches, or generated runtime files
belong inside the asset package. Package hashes cover definitions and authored
resources only.

### Observation does not imply evolution

Agent and Workflow telemetry is useful for reliability and cost diagnosis even
when the product never automatically proposes a change. The initial contract is
`observe -> aggregate -> diagnose`, not `observe -> mutate`.

### Reuse primitives, not unproven lifecycle abstractions

File enumeration, hashing, snapshotting, version attribution, trace scanning,
and projection caching can be shared. Approval semantics, validation,
statistics, reconciliation, and evolution policy remain asset-specific.

## Common Package Identity

### Canonical package file set

For a folder asset, the package file set contains every recursively
discovered ordinary file under the asset root except a small, documented set of
non-asset entries.

Frozen rules:

- Include the required entry Markdown file and all other ordinary files.
- Normalize relative paths to `/` separators and sort them bytewise before
  hashing.
- Hash `relativePath + NUL + fileBytes + NUL` for every included file.
- Empty directories do not affect identity.
- Reject symlinks, sockets, FIFOs, devices, and paths escaping the package root.
- Apply explicit maximum-file and maximum-byte limits before reading untrusted
  or unexpectedly large packages.
- Use the same enumerator for hash, snapshot, diff, apply, history, restore,
  import, and Workflow execution snapshotting.
- Do not use `.gitignore` as an implicit package contract; repository ignore
  rules are not stable artifact semantics.

The fixed v2 exclusions are:

```txt
.git/
.sparkwright/
node_modules/
.DS_Store
Thumbs.db
*.swp
*.tmp
*~
```

Matching uses normalized `/` relative paths and case-sensitive logical names on
every platform. Directory patterns match exact path segments and exclude their
subtrees; filename patterns match basenames at any depth. Platform case folding
must not broaden the logical exclusions, and ambiguous normalized/case-folded
paths fail closed. V2 does not read `.gitignore` and does not introduce a
manifest or package-specific ignore file. Excluded entries should remain
visible through doctor/validation so authors know they are not versioned.

### Hash metadata

Serialized records should carry the policy used to derive a package identity:

```ts
interface AssetPackageIdentity {
  packageHash: string;
  packageHashPolicyVersion: 2;
  fileCount: number;
  totalBytes: number;
}
```

The hash value retains the existing `sha256:<hex>` representation. Managed
Skill evolution proposal and history records require policy version 2; records
without it are outside the canonical schema and are rejected.

### Shared implementation boundary

A small package primitive may be shared by Skill, Agent, and Workflow owners:

```ts
interface AssetPackageSpec {
  rootPath: string;
  entryPath: string;
  exclusions: readonly string[];
  limits: { maxFiles: number; maxBytes: number };
}

listAssetPackageFiles(spec);
computeAssetPackageHash(spec);
snapshotAssetPackage(spec, destination);
```

This does not imply a shared proposal state machine or shared artifact store.

## Skill Governance

### Managed mutations

The current Skill transaction remains the owner of changes initiated through
SparkWright:

```txt
author final package
  -> persist prepared change
  -> doctor + guard + diff
  -> approve exact final effect
  -> revalidate base/after package hashes
  -> idempotently apply
  -> history + mutation receipt
```

Managed operations remain `create`, `update`, `import`, and `rollback`.

### Direct filesystem reconciliation

Direct editor, shell, Git checkout, merge, copy, move, and delete operations do
not enter the prepared-change state machine. They are observed by a read-only
reconciliation planner and may later be adopted through an explicit command.

| Direct operation                                  | Current filesystem meaning                                 | Pending prepared change                                   | Explicit reconciliation                                                                |
| ------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Add a new Skill directory                         | Discover, validate, and load it as an unregistered package | A same-target create becomes stale                        | `adopt` may register a new identity/baseline                                           |
| Modify `SKILL.md` or any included file            | The changed package is current truth                       | A base mismatch makes the proposal stale; never overwrite | Preserve identity at the same path and report unmanaged drift                          |
| Delete a Skill directory                          | It is no longer loadable                                   | Related create/update/apply work becomes stale            | Preserve an orphan tombstone/history when registry support exists                      |
| Move or rename a Skill                            | V1 may appear as delete plus add                           | Related proposal becomes stale                            | One exact package-hash match may preserve identity; ambiguity requires a user decision |
| Copy a Skill                                      | The copy is a distinct package instance                    | No effect unless the target collides                      | Allocate a new identity and optionally record `derivedFrom`                            |
| Replace all content at the same path              | The replacement is current truth                           | Existing proposal becomes stale                           | Default to path continuity; use `reidentify` when semantically new                     |
| Edit a proposal's staged `after` package directly | Not a valid managed revision                               | After-hash mismatch makes the proposal stale              | Re-author/revise through the command service                                           |
| Introduce Git conflict markers or invalid files   | Validation fails closed                                    | Never apply                                               | Resolve externally, then rescan                                                        |
| Concurrently edit one Skill                       | Last durable filesystem content is current truth           | Optimistic hash checks prevent silent overwrite           | Review drift, then adopt or revise                                                     |

### Reconciliation records are not mutation receipts

If direct content is adopted, persist a distinct reconciliation receipt such
as:

```ts
interface SkillReconciliationReceipt {
  kind: "adopt" | "move" | "copy" | "reidentify" | "orphan";
  artifactId: string;
  observedPackageHash: string;
  previousPath?: string;
  currentPath?: string;
  reconciledAt: string;
}
```

It must not contain an approval assertion for a change SparkWright did not
prepare or apply.

### Registry is continuity, not basic safety

Base/after hash gates already prevent a prepared change from overwriting direct
edits. The registry is needed later for stable identity across rename, copy,
orphaning, history, and statistics. Ordinary direct-edit safety must not depend
on shipping the registry first.

## Agent Asset Direction

### Governance boundary

Agent authoring should target Markdown Agent assets, not
`capabilities.agents.profiles[]` in project config.

The ordinary flow is:

```txt
author final Markdown Agent
  -> parse and validate
  -> resolve effective model/tools/hooks/exposure
  -> show file diff and semantic capability summary
  -> use existing final-write approval
  -> atomically write
  -> validate and report callability
```

No separate Agent proposal store, applying journal, approval receipt, mutation
receipt, history tree, registry, or automatic evolution is required in this
slice. Git remains the ordinary history/rollback mechanism.

Advanced project-wide Agent governance—such as global delegate policy,
`maxDepth`, and exact config-owned profiles—remains explicit config and outside
the Markdown authoring tool.

### Supported shapes

Current source recursively discovers `.md` files; nested directories organize
files but are not package identity. The target design may support two explicit
forms:

```txt
# Single-file form
.sparkwright/agents/reviewer.md

# Folder-package form
.sparkwright/agents/reviewer/
  AGENT.md
  references/
  templates/
  scripts/
  fixtures/
  ...
```

Both map to one logical package:

```ts
interface AgentAssetPackage {
  id: string;
  form: "single-file" | "folder";
  rootPath: string;
  entryPath: string;
  packageHash: string;
}
```

Rules:

- A single file is logically hashed as a package containing `AGENT.md` so a
  future file-to-folder conversion has a stable entry-file convention.
- A folder package defaults its id from the folder name, not the `AGENT.md`
  basename.
- An explicit frontmatter id must be valid and should match the derived id
  unless an explicit namespacing rule is later accepted.
- `<id>.md` and `<id>/AGENT.md` in the same layer are a fail-closed collision.
- Organizational nested Markdown paths remain compatible, but duplicate ids
  continue to fail closed.
- Folder package hash covers every included ordinary file.

The first authoring slice may produce only `<id>.md`. Folder creation should be
enabled when Agent-local references/scripts have a defined loading or execution
contract, not merely because the scanner can find `AGENT.md`.

### Agent semantic review

Before write, report at least:

- prompt change
- resolved model change
- effective tool/capability narrowing or widening
- workspace-write or shell potential
- mode and main-run impact
- delegate exposure/callability
- hook additions, especially command or HTTP hooks
- max-step and run-budget changes

Capability widening, primary/main impact, delegate exposure, and side-effecting
hooks are high-risk review findings. This is validation/approval policy, not an
Agent self-evolution system.

## Workflow Asset Direction

### Package identity is a correctness requirement

A Workflow is already a folder package:

```txt
.sparkwright/workflows/bugfix/
  workflow.md
  config.yaml
  scripts/
  ...
```

Retain `contentHash` temporarily as the legacy Markdown-body identity where
compatibility requires it, but add `packageHash` as the strong identity used by
new execution records, statistics, comparison, and future authoring flows.

`packageHash` covers every included ordinary file, including `workflow.md`,
config, scripts, fixtures, and other authored dependencies.

### Version pinning

New Workflow instances pin:

```ts
interface PinnedWorkflowAsset {
  assetName: string;
  version?: string;
  contentHash: string; // compatibility/Markdown identity
  packageHash: string; // strong package identity
  packageHashPolicyVersion: 2;
  definitionSnapshot: unknown;
  packageSnapshotRef: string;
}
```

Instantiate copies the canonical package, hashes the snapshot, and re-hashes
the live source after the copy. It commits only when the pre-copy, snapshot,
and post-copy identities agree; otherwise it retries within a bounded policy or
fails closed. Workflow/config parsing, every normal node, and every resume use
the snapshot `sourceDir`. Live-folder equality is not a substitute for the
committed executable snapshot. A definition snapshot paired with live scripts
is not a valid pinned execution.

This work belongs to Workflow execution consistency. It does not require a
Workflow proposal/history/evolution system.

### Authoring and iteration

Keep the current review-first direction:

```txt
trace
  -> workflow distill
  -> Markdown draft on stdout
  -> human review/edit
  -> save + validate
  -> workflow shadow
  -> Git review/version
```

Only consider a persistent Workflow proposal inbox when distill/shadow/replay
produce a demonstrated cross-session review need. A running Workflow never
mutates its own live definition; new asset versions affect future instances,
while existing instances remain pinned.

## Statistics and Evidence

### Shared observation identity

All asset observations should capture identity at event/run time rather than
joining against whatever files happen to exist later:

```ts
interface ArtifactObservationIdentity {
  artifactKind: "skill" | "agent" | "workflow";
  artifactId?: string;
  name: string;
  layer: string;
  packageHash: string;
  packageHashPolicyVersion: number;
  runId: string;
  sessionId?: string;
}
```

Without a stable registry, the temporary strong key is
`kind + layer + name + packageHash`. A later unambiguous reconciliation may map
it to `artifactId`; ambiguous legacy observations remain legacy.

### Storage doctrine

- Raw trace and Workflow run records remain durable evidence.
- Stats are rebuildable projections/catalogs, not authority.
- Creation/import does not invent a zero-use observation bucket.
- Package identity is captured when a Skill is loaded, Agent is spawned, or
  Workflow is instantiated.
- Evidence pointers distinguish available, pruned, and inaccessible sources.
- Runtime/model/tool-policy dimensions are attribution fields, not part of the
  package identity key.

Shared trace scanning, projection cache, catalog, freshness, and evidence
pointer primitives are acceptable. Metric definitions and diagnostics remain
asset-specific.

### Skill projection

Keep current Skill-specific concerns: indexed/loaded/use counts, load failures,
associated tool failures, proposal/history activity, and package-aligned
evidence.

### Agent projection

Derive, by Agent package version:

- spawn/delegate count
- completion, failure, partial, cancellation, and step-limit rates
- token, cost, model-call, tool-call, and wall-time totals/distributions
- workspace-write count
- tool failures and permission denials
- model/provider attribution
- human/parent takeover or repeated delegation signals where evidence exists

Current `subagent.*` attribution and usage rollup provide much of the raw
evidence. Add package identity to spawn-time attribution rather than inferring
it afterward.

### Workflow projection

Derive, by Workflow package version:

- run completion/failure/interruption/resume rates
- per-node first-pass rate
- retry counts and transition outcomes
- verifier verdict distributions
- waiting/human-intervention frequency
- escalation count when implemented
- per-node and whole-workflow token, cost, model-call, tool-call, and duration
- package-version regressions

Current `workflow.*` events and `WorkflowRunRecord.metadata.workflowUsage`
provide the raw base. Add strong package identity and a rebuildable aggregation
projection; do not create a second source of run truth.

### Evolution remains deferred

Agent and Workflow statistics initially stop at diagnosis. Reopen automated
revision suggestions only when:

- evidence is package-version aligned,
- success/failure semantics are stable,
- false-positive costs are understood,
- replay/shadow or equivalent validation exists,
- users demonstrate demand for a persistent suggestion inbox.

## Revised Delivery Plan

### Completed: Skill Phase 1 and Phase 2

Preserve the implemented safe authored-create transaction, command-service
convergence, effect-bound approval, durable waiting/review, history, receipt,
and recovery behavior. Do not rewrite these slices as part of redirection.

### Phase 3A: package identity v2 substrate

- Add shared ordinary-file enumeration with path normalization, exclusions,
  special-file rejection, limits, and policy versioning.
- Make hash/snapshot/diff/restore consume the same file list.
- Preserve legacy hash/history readability.
- Add focused traversal, symlink, exclusion, limit, determinism, and round-trip
  tests.

Exit condition: one package snapshot round-trips byte-for-byte and its computed
hash is identical before/after snapshot across supported platforms.

### Phase 3B: Skill full-package and external-change safety

- Move Skill package hashing/snapshots to the v2 file policy.
- Add doctor findings for excluded/unmanaged/special entries.
- Freeze the direct-operation matrix in public/internal contracts.
- Confirm every pending create/update/apply path becomes stale on a relevant
  target change without overwrite.
- Keep `adopt` and all identity-changing reconciliation writes in Phase 7;
  Phase 3B defines their distinct receipt semantics without persisting them.

Exit condition: changing any included ordinary file changes Skill package
identity and cannot be silently overwritten by an older prepared change.

### Phase 4: Workflow package pinning correctness

- Compute Workflow `packageHash` over Markdown, config, scripts, and all other
  included files.
- Persist package identity at instantiation.
- Snapshot the executable package or fail closed when the live package differs
  during resume.
- Attribute Workflow events/usage to the pinned package version.
- Keep runtime state outside the asset folder.

Exit condition: editing a Workflow script/config after instantiation cannot
silently alter a resumed instance under the old package identity.

### Phase 5: Markdown Agent authoring and identity

- Redirect ordinary Agent authoring from config-backed profiles to Markdown.
- Implement parse/validate, semantic capability review, final diff approval,
  atomic write, and post-write callability validation.
- Capture the Agent package identity at spawn/delegate time.
- Initially author single files; add folder-package creation only with a real
  Agent-local resource contract.
- Keep advanced/global governance in explicit config.

Exit condition: a user can create/update a readable Markdown Agent with a
reviewable effective-capability summary, and later runs identify the exact
package version used.

### Phase 6: Agent and Workflow stats projections

- Reuse raw trace/run evidence and rebuildable projection infrastructure.
- Add asset-specific Agent and Workflow aggregators and targeted queries.
- Do not emit evolution proposals or automatic mutations.
- Validate version attribution across file changes and legacy observations.

Exit condition: reports compare outcomes/costs across exact package versions
without joining historical runs to current file content.

### Phase 7: Skill registry, origin, import, and reconciliation

- Add stable Skill identity only after direct-edit safety is independent of it.
- Implement adopt/move/rename/copy/reidentify/orphan semantics.
- Preserve ambiguous legacy history/stats rather than guessing.
- Define ordinary Git merge/conflict behavior for the tracked registry.
- Implement frozen/notify import and origin records.

### Phase 8: evidence-driven Skill suggestions

- Separate learning, upstream-update, and local-evolution queues.
- Add churn controls, evaluation metadata, observation windows, and rollback
  recommendation.
- Keep Agent/Workflow suggestion generation outside this phase.

### Removed as scheduled work

- Managed Agent proposal/history/restore transaction.
- Automatic Agent self-evolution.
- Workflow reuse of the Skill proposal store by default.
- Generic managed-artifact lifecycle extraction.

These may be reopened only from demonstrated user/product requirements, not
from structural similarity among Markdown assets.

## Migration and Compatibility

- Existing Skill prepared changes, history, and receipts remain readable and
  retain their recorded hashes/snapshots.
- A v2 Skill scan may produce a different package hash when previously omitted
  files exist; this is a new observed version, not corruption.
- Existing Agent Markdown discovery remains compatible. Folder-package support
  adds an explicit `AGENT.md` sentinel and collision rules rather than changing
  every nested directory into a package.
- Config-backed Agent profiles remain supported for explicit configuration;
  only the ordinary authoring tool direction changes.
- Existing Workflow `contentHash` remains available for compatibility while
  new records use `packageHash` as the strong version identity.
- Existing Workflow run records without package snapshots remain legacy. Resume
  policy for them must be explicit and fail closed when exact execution content
  cannot be proven.
- Existing raw trace is immutable. Stats migration reads legacy identities but
  never rewrites historical events.

## Acceptance Matrix

| Concern              | Required evidence                                                              |
| -------------------- | ------------------------------------------------------------------------------ |
| Package determinism  | Same file set/bytes produces the same hash independent of discovery order      |
| Package completeness | Changing any included ordinary file changes package hash                       |
| Boundary safety      | Symlink/special/escaping/oversized packages fail clearly                       |
| Snapshot consistency | Hash, snapshot, diff, restore, and execute consume the same canonical file set |
| Skill concurrency    | Direct target edit makes an older proposal stale without overwrite             |
| Skill provenance     | Adopted direct content is not represented as a managed mutation receipt        |
| Agent UX             | Final Markdown and effective capability change are reviewable before write     |
| Agent attribution    | Spawn/delegate trace carries the package version used                          |
| Workflow pinning     | Live script/config edits cannot alter a pinned/resumed instance silently       |
| Workflow attribution | Run/node/usage facts carry the pinned package version                          |
| Stats authority      | Projections rebuild from trace/run records and are never execution authority   |
| Evolution boundary   | Agent/Workflow reports do not create or apply revision proposals               |

## Adjudication Handoff

The master design has incorporated this review. The following decisions are
closed for the next implementation sequence:

1. Full managed-change lifecycle remains Skill-only; Phase 1/2 stand.
2. Managed Skill mutation and direct filesystem reconciliation are distinct
   chains with distinct receipts.
3. Package identity v2 covers the fixed canonical ordinary-file set through
   one enumerator and carries an explicit policy version; v1 records are not
   rewritten.
4. Registry/origin/import/reconciliation provide later identity continuity and
   are not prerequisites for base/after-hash overwrite safety.
5. Workflow instantiate creates a race-checked executable snapshot, and all
   normal/resumed execution uses its `sourceDir`; `node_modules` stays excluded
   and no dependency installation occurs during snapshot.
6. Phase 5 authors only `.sparkwright/agents/<id>.md` with ordinary write
   approval and no Agent proposal/history/evolution system. Folder packages wait
   for runtime contracts; any future `AGENT.md` sentinel requires doctor-led
   migration. A future frontmatter id may be namespaced and owns collision
   semantics.
7. Agent/Workflow stats are trace-derived, rebuildable, captured with package
   identity at event time, policy-boundary aware, and diagnostic-only.
8. The frozen sequence is Completed Skill Phase 1/2, then Phases 3A through 8
   as listed above. Managed Agent and generic lifecycle phases are removed.

## Remaining Open Questions

1. What exact file-count, per-file-size, and total-package-size limits apply per
   asset kind, and which limits may be configured?
2. Where are Workflow executable snapshots stored, how are they referenced
   durably, and what retention/GC policy protects active and resumable runs?
3. Which bounded/redacted fields form the execution-environment fingerprint?
4. Which non-`node_modules` package-local vendoring conventions receive
   explicit runtime support and validation?
5. What registry merge/conflict representation is safe under ordinary Git
   collaboration?
6. What retention/privacy policy applies to origin locators, evidence pointers,
   and rebuildable projection caches?

## Last Verified

- Status: Read-only
- Date: 2026-07-12
- Scope: adjudicated review handoff synchronized with the restructured master
  design; previously open package, Agent, Workflow, stats, and phase decisions
  are now frozen, leaving only implementation-detail questions.
- Read: Skill managed-change design and package hashing; Skill evolution apply
  base/after checks; Markdown Agent discovery/parser; Workflow folder parser,
  script invocation and resume; Agent/Workflow trace and project maps.
- Tests: not run; documentation-only redesign.
