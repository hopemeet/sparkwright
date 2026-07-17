# Skill Managed Change Redesign

## Status

- Status: Verified
- Date: 2026-07-12
- Scope: implementation-ready master design after the asset-governance review.
  Skill Phase 1-8 delivery slices are implemented; remaining open questions
  concern policy tuning and retention, not a missing managed lifecycle.
- Source check: current Skill package enumeration, prepared-change lifecycle,
  command service, Agent Markdown discovery, Workflow parsing/execution/resume,
  and Agent/Workflow trace attribution paths were read.
- Tests: not run; documentation-only redesign.

## Purpose and Frozen Boundary

SparkWright keeps one complete managed-change transaction, and it belongs to
project Skills:

```txt
prepare -> inspect -> approve exact effect -> apply -> history/receipt
```

Direct editor, shell, and Git changes use a separate lifecycle:

```txt
scan -> finding -> explicit adopt/move/copy/reidentify
```

The second lifecycle never claims that SparkWright prepared, approved, or
applied an external mutation. Agent authoring and Workflow execution reuse
package, validation, trace, and atomic-write primitives where appropriate, but
do not inherit the Skill proposal/history/restore lifecycle.

Explicitly out of scope:

- managed Agent proposals, history, restore, registry, or self-evolution;
- Workflow reuse of the Skill proposal store or Workflow self-evolution;
- a generic managed-artifact lifecycle extraction;
- implementation of any post-Phase-2 work in this documentation change.

## Implemented Skill Facts: Phase 1 and Phase 2

These current-source facts remain valid and are not redesigned:

- Project Skills are packages under `.sparkwright/skills/<name>`.
- A prepared change is persisted before approval and carries revision,
  base/after package hashes, `artifactId`, and an `effectHash` bound to the
  intended final effect.
- Model-authored safe creates can wait durably, receive effect-bound approval,
  apply in the same tool episode, and persist deterministic history plus a
  mutation receipt. Disconnect or absent approval leaves recoverable waiting
  state.
- Apply revalidates staged content, base/after hashes, doctor, and guard;
  dangerous guard deltas require renewed approval. Base drift is stale and is
  never overwritten.
- Applying-state recovery is idempotent: an already-written target matching the
  approved after hash is reconciled through doctor, history, and receipt rather
  than rewritten.
- Model, CLI, canonical TUI `/create skill`, and compatibility
  `/skill-create` creation paths converge on `SkillCommandService`; persistent
  proposal storage remains the durable review/recovery surface.
- Existing proposal inspection/rejection, history, receipt, restore, revision,
  provenance, and session-scoped deduplication remain supported.

The current package-hash policy is v1. It enumerates `SKILL.md` and recursive
ordinary files only under `references/`, `templates/`, and `scripts/`. It
rejects a symlink or special file when encountered in that enumerated set, but
ignores other root entries. Phase 3A therefore changes observable identity and
fail-closed coverage; it is not a behavior-neutral refactor.

## Managed Skill Change

### Transaction contract

```txt
author final package
  -> persist prepared change
  -> doctor + guard + diff
  -> wait for approval bound to proposal id + revision + effect hash
  -> re-enumerate and revalidate base/after packages
  -> idempotently apply
  -> persist history + mutation receipt + applied state
```

Approval authorizes only the exact final effect. Revising the package changes
the after hash, revision, and effect hash and invalidates the old receipt. A
new dangerous fingerprint also returns the change to waiting. A harmless guard
message or policy-version change alone does not change effect identity.

The registry is not a safety prerequisite. Base/after package hashes already
prevent a prepared change from overwriting a direct edit. Registry and origin
records later provide identity continuity and provenance across paths.

### Recovery invariants

- Persist proposal and waiting/approval/applying state before the corresponding
  external effect.
- Treat target-equals-after as a recovery case, not a new mutation.
- Write `applied` only after target hash, doctor, deterministic history, and
  mutation receipt are durable.
- On base drift, staged-package tampering, package validation failure, or an
  unprovable partial write, fail closed without overwriting current content.
- Keep reconciliation records distinct from approval and mutation receipts.

## Package Identity v2

### Canonical file set

For Skill and Workflow folder packages, v2 recursively considers every entry
under the package root. It includes every ordinary file except this fixed first
version exclusion table:

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

Matching rules are frozen as follows:

- Normalize relative paths to `/` before matching, sorting, hashing, storage,
  and display.
- Directory patterns ending in `/` match a path segment with that exact name
  and exclude the full subtree. `.git`, `.sparkwright`, and `node_modules`
  matching is case-sensitive on every platform.
- `.DS_Store` and `Thumbs.db` match an exact basename with the listed case at
  any depth.
- `*.swp` and `*.tmp` match a basename suffix, and `*~` matches a basename
  suffix `~`, all case-sensitive.
- Host filesystem case folding must not change these logical matching rules.
  Two discovered paths that normalize or case-fold to an ambiguous package
  identity fail closed on affected platforms.
- No manifest, package-local ignore file, or `.gitignore` interpretation is
  introduced in v2.

Every non-excluded entry must be a directory or regular file. Reject symlinks,
sockets, FIFOs, devices, path escape, ambiguous normalized paths, excessive
file count, excessive individual file size, and excessive total bytes. Limits
must be checked during enumeration and before unbounded reads or copies.

Hash included files in stable bytewise relative-path order using the existing
framing:

```txt
relativePath + NUL + raw file bytes + NUL
```

One canonical enumerator and policy object must drive hash, snapshot, diff,
apply, history, restore, Skill reconciliation, Workflow instantiate snapshot,
and Workflow execution source construction. No consumer may silently add or
omit files.

### Policy-version boundary

New strong identities carry at least:

```ts
interface AssetPackageIdentity {
  packageHashPolicyVersion: 2;
  packageHash: string; // sha256:<hex>
  fileCount: number;
  totalBytes: number;
}
```

Managed Skill evolution records require policy version 2. Equality and
statistics grouping require both policy version and hash; the same hash text
under different policies does not erase the boundary.

## Direct Filesystem Reconciliation

Reconciliation first scans without writing and emits findings. A later explicit
command may adopt, move, copy, reidentify, or record an orphan. Its receipt
records observation and user adjudication, never a fictional managed approval.

| Direct operation                     | Phase 3B: safety behavior                                                | Phase 7: identity continuity                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| add                                  | Discover and validate; colliding prepared create becomes stale.          | `adopt` assigns a registered identity and baseline.                                             |
| modify any included file             | Current filesystem wins; base mismatch is stale; never overwrite.        | Same-path identity may be retained and unmanaged drift recorded.                                |
| delete                               | Asset stops loading; related apply fails closed.                         | Preserve an orphan/tombstone with history and stats.                                            |
| move/rename                          | Without registry, observe delete plus add; make no continuity promise.   | One unambiguous identity/hash match may be confirmed by `move`; ambiguity requires user choice. |
| copy                                 | Treat the new path as a separate package; target collisions fail closed. | `copy` creates a new identity and may record `derivedFrom`.                                     |
| same-path replacement                | Current content wins and pending work becomes stale.                     | Default to path continuity; `reidentify` declares a new logical asset.                          |
| staged proposal tampering            | After-hash mismatch marks stale; never apply.                            | Re-author through the managed command service; no reconciliation shortcut.                      |
| Git conflict or invalid/special file | Validation fails closed; never apply or load as valid.                   | Resolve externally, rescan, then explicitly adjudicate if needed.                               |
| concurrent edit                      | Re-enumeration and optimistic hashes prevent silent overwrite.           | Rescan and choose adopt/revise/reidentify after the race settles.                               |

A reconciliation receipt has its own kind and observed package identity. It
must not contain an assertion that SparkWright approved or applied the observed
filesystem change.

## Workflow Executable Package Pinning

A Workflow is a folder package. Its v2 `packageHash` covers `workflow.md`,
configuration, scripts, and every other included canonical ordinary file.
The live parser may expose `contentHash` as a Markdown-only inspection
fingerprint; durable execution identity is exclusively the v2 package pin.

Instantiation must:

1. Enumerate the live package with policy v2.
2. Copy the canonical set to an immutable executable package snapshot.
3. Hash the snapshot with the same enumerator.
4. Re-enumerate/hash the live source after copying.
5. Commit the instance only if pre-copy, snapshot, and post-copy identities
   agree; otherwise discard and retry within a bounded policy or fail closed.
6. Parse `workflow.md` and config from the snapshot and persist `packageHash`,
   `packageHashPolicyVersion`, and `packageSnapshotRef` with the run record.

Every node, script, verifier, normal continuation, and resume executes with the
snapshot as `sourceDir`. A run must never use a new live script/config under an
old recorded package identity. Missing or invalid snapshot state fails closed;
live-folder equality is not a substitute for a durable snapshot once the
instance has been committed.

Pinning covers authored files inside the Workflow package only. External
Node/Python/bash runtimes, workspace dependencies, `PATH`, environment
variables, OS/toolchain, and other host state are execution environment. Store
a bounded environment fingerprint for attribution and diagnosis, but exclude it
from `packageHash`. `node_modules` remains excluded and instantiate never
installs dependencies. A dependency that must be pinned must be vendored into
an explicitly supported package-local directory other than `node_modules`.

Workflow proposal, history, restore, and evolution systems remain deferred.

## Markdown Agent Authoring

The ordinary Agent authoring target is one file:

```txt
.sparkwright/agents/<id>.md
```

Phase 5 authors final Markdown, parses and validates it, resolves an effective
capability summary, shows the final file diff, uses the existing workspace-write
approval, writes atomically, then reloads and validates callability. It does not
mutate config-backed profiles and does not create an Agent proposal store,
history, receipt, registry, restore, or automatic evolution system. Advanced
global governance stays in explicit configuration.

Phase 5 generates only the single Markdown file. Folder Agent packages are
deferred until references/scripts/templates have explicit runtime contracts.
Before introducing an `AGENT.md` sentinel, doctor must warn that current
recursive discovery parses files such as `reviewer/AGENT.md` as an ordinary
Markdown profile whose filename-derived id is `AGENT`; migration must never
silently change that meaning.

In a future folder form, the folder name remains the sole id. Frontmatter does
not redirect identity; collisions are judged by that canonical folder or
single-file name.

Agent spawn/delegate events must capture the resolved Agent identity and package
identity at the event boundary. Stats must not infer an older invocation's
identity by reading the current Markdown file later.

## Trace-Derived Statistics

Skill, Agent, and Workflow retain asset-specific projections over shared trace
scanning, observation identity, freshness/catalog, and projection-cache
primitives. Raw trace and Workflow run records remain evidence; projections are
rebuildable and never become runtime authority. Do not copy three new raw
evidence stores.

The strong observation identity contains at least:

```txt
artifactKind + layer + logicalName/artifactId
  + packageHashPolicyVersion + packageHash
```

Capture it when the event occurs: Skill index/load/use, Agent spawn/delegate,
and Workflow instantiate/run/node/usage. Later registry reconciliation may add
an unambiguous `artifactId`, but must not guess across ambiguity.

The v1-to-v2 transition is an identity-policy boundary. Projections do not
automatically merge buckets across it and reports distinguish:

- content changed;
- policy changed;
- both content and policy changed.

A policy-only boundary is not reported as a real performance regression.
Agent and Workflow initially support only `observe -> aggregate -> diagnose`;
their statistics cannot trigger mutation or evolution.

## Delivery Plan

### Completed: Skill Phase 1 and Phase 2

Retain the implemented prepared-change, effect-bound approval, durable waiting,
history, receipt, recovery, and four-entry command-service convergence.

### Completed: Phase 3A package identity v2 substrate

- `packages/skills/src/package-v2.ts` provides canonical enumeration, fixed
  exclusions, special-file/path/size rejection, NUL-framed hashing, same-set
  snapshots, and `packageHashPolicyVersion: 2` without migrating current
  consumers.
- The v1 substrate remains isolated to the distinct runtime identity path.
  Phase 3B performs the explicit Skill evolution migration.

### Completed: Phase 3B Skill full-package and external-change safety

- New managed proposals, revisions, staged snapshots, apply/recovery, history,
  restore, and mutation receipts use the v2 canonical set and carry policy 2.
- Proposal/history readers require policy version 2. Included external
  ordinary-file drift marks a proposal stale without overwriting the target;
  registry-based continuity and runtime stats attribution remain later phases.

### Completed: Phase 4 Workflow executable package pinning correctness

- Instantiate creates a v2 executable snapshot, verifies source-before,
  snapshot, and source-after hashes, then parses snapshot `workflow.md`/config.
- Content-addressed snapshots publish through a verified temporary directory
  and atomic rename; concurrent pins safely reuse an already-published hash.
- Durable records persist strong identity and `packageSnapshotRef`; normal and
  resumed execution require the snapshot hash and snapshot-backed `sourceDir`.
- The later canonicalization pass made layer, revision/generation, v2 package
  identity, snapshot reference, and snapshot-backed definition required, and
  removed Markdown `contentHash` plus legacy default readers from durable runs.

### Completed: Phase 5 Markdown Agent authoring and version attribution

- `create_agent` now writes only `.sparkwright/agents/<id>.md`, parses the
  final file before approval, reports its effective capability summary and v2
  single-file identity, uses the workspace-write path, and rediscoveres the
  file after writing before declaring it callable.
- Explicit config profiles remain advanced governance and fail closed when they
  shadow the requested Markdown id. No Agent proposal/history/receipt/registry
  lifecycle was introduced.
- Markdown discovery hashes the logical `AGENT.md` single-file package and
  spawn/delegate lifecycle metadata captures that identity at invocation time.

### Completed: Phase 6 Agent and Workflow stats projections

- Agent and Workflow observation helpers consume event-time Agent trace metadata
  and durable Workflow package pins; they never read current authored files to
  infer historical identity.
- Rebuildable aggregation keeps policy-version buckets distinct and labels
  content/policy/both changes without converting policy-only changes into
  performance claims.

### Completed: Phase 7 Skill registry, origin, import, and reconciliation

- The tracked project registry supports read-only scan plus explicit
  `adopt`/`move`/`copy`/`reidentify`/`orphan` operations through
  `skills reconcile`. Reconciliation receipts are distinct from managed
  mutation receipts and carry no approval/effect assertion.

### Completed: Phase 8 evidence-driven Skill suggestions

- Existing trace-derived load/tool-failure evidence now yields bounded,
  deterministic advisory suggestions in `skills review`. Existing draft
  proposals suppress duplicate suggestions; suggestions never create or apply
  a mutation. Agent and Workflow observations remain diagnostic-only.

## Acceptance Criteria

- Modifying any included ordinary Skill or Workflow file changes its v2
  `packageHash`.
- Hash, snapshot, diff, apply, history, restore, reconciliation, and Workflow
  execution consume the same canonical file set where applicable.
- Excluded entries do not affect identity; non-excluded symlink, special,
  escaping, ambiguous, or over-limit entries fail closed.
- The direct-operation matrix is covered without silent overwrite in Phase 3B;
  rename continuity is not promised before Phase 7.
- Running and resumed Workflows never execute new live script/config content
  under an old package identity.
- Workflow snapshot races either produce a snapshot identical to stable live
  source or retry/fail closed.
- Agent spawn/delegate and Workflow run/node/usage events record package
  identity at event time.
- v1 and v2 statistics boundaries stay visible, do not auto-merge, and do not
  mislabel policy-only change as performance regression.
- No Agent/Workflow observation triggers mutation or evolution.

## Canonical Boundaries

- Existing Phase 1/2 proposal commands, durable waiting, history, restore, and
  command entrypoints continue to use the same governed lifecycle.
- Skill evolution proposals, history, and receipts require
  `packageHashPolicyVersion: 2`; missing/non-v2 records are rejected.
- Workflow run records accept only v2 package identity and a snapshot-backed
  definition. Live Workflow inspection may still show the Markdown fingerprint,
  but it is not durable execution identity.
- Existing Markdown Agent discovery remains unchanged until Phase 5; the future
  `AGENT.md` sentinel requires an explicit doctor-led migration.
- Registry introduction may reconcile only unambiguous observations; ambiguous
  legacy identity remains legacy.

## Open Questions

- What exact `maxFiles`, per-file byte, and total-byte limits apply to each
  asset kind, and which are configurable?
- What retention/GC rules preserve active executable Workflow snapshots while
  reclaiming snapshots that are no longer referenced by durable runs?
- What bounded fields and redaction rules define the Workflow environment
  fingerprint?
- Which package-local vendored dependency directories receive explicit runtime
  support, and how are their language-specific entrypoints validated?
- What registry merge/conflict representation is safe under ordinary Git
  collaboration?
- What retention/privacy rules apply to origin locators, evidence pointers, and
  projection caches?

## Last Verified

- Status: Verified
- Date: 2026-07-16T23:38:00+0800
- Scope: aligned Phase 5 and the future folder form with filename-only Markdown
  Agent identity; frontmatter no longer redirects logical identity.
- Read: Host Markdown parser/authoring, Agent capability/module maps, public
  Agent docs, and focused tests.
- Tests: Host Agent profile/tools 125/125; focused Host protocol collision 1/1;
  CLI Agent/capability routes 7/7; Host, Agent Runtime, and CLI typechecks;
  repository test typecheck; project-map drift; full release gate.

- Status: Verified
- Date: 2026-07-12T20:00:00+0800
- Scope: post-review hardening completed disjoint snapshot containment,
  transactional/unique Skill reconciliation, local-path import origins,
  exact-file Agent callability validation and remove compatibility, production
  Agent/Workflow stats queries, and persisted Skill suggestion cooldowns.
  Follow-up fixes keep Workflow terminal counters run-scoped, persist the
  event-time Workflow layer, journal import origin with registry/receipt, and
  handle Windows cross-volume snapshot paths as disjoint.
- Read: package-v2, Skill registry/import, Markdown Agent manager/discovery,
  asset stats, Skill suggestion/review, CLI routing, and focused tests.
- Tests: focused Skills/host/CLI suites and affected typechecks; full release
  gate recorded after the final verification pass.

- Status: Verified
- Date: 2026-07-12T17:28:16+0800
- Scope: completed Phase 5 single-file Markdown Agent authoring, callability
  validation, config-shadow rejection, and event-time package attribution.
- Read: `packages/host/src/tools.ts`, `packages/host/src/agent-profiles.ts`,
  `packages/agent-runtime/src/index.ts`, host agent/tool tests.
- Tests: focused host agent-profile/tool tests, agent-runtime/host typechecks,
  and full `npm run release:check`.

- Status: Read-only
- Date: 2026-07-12
- Scope: implemented Phase 6 observation/projection primitives, Phase 7 Skill
  reconciliation registry/CLI, and Phase 8 advisory evidence suggestions.
- Read: `packages/host/src/asset-stats.ts`, `skill-registry.ts`,
  `skill-suggestions.ts`, `skill-review-digest.ts`, `runtime.ts`, and CLI
  reconciliation routing.
- Tests: focused host/CLI tests, workspace check, regression matrix, source
  install smoke, and release install smoke passed.

- Status: Verified
- Date: 2026-07-12T16:47:44+0800
- Scope: closed Phase 4 with atomic content-addressed Workflow snapshot
  publication, concurrent same-package reuse, durable resume verification, and
  a reproducible full release gate.
- Read: `packages/host/src/workflows.ts`, `packages/host/src/runtime.ts`,
  `packages/skills/src/package-v2.ts`, durable Workflow record types/store,
  reserved-field diagnostics, and focused host/CLI tests.
- Tests: Workflow focused host/CLI suites, test typecheck, and full
  `npm run release:check`.

- Status: Verified
- Date: 2026-07-12T14:03:23+0800
- Scope: completed Phase 3B managed Skill migration to v2 package identity and
  external-file stale protection.
- Read: `packages/host/src/skill-evolution.ts`,
  `packages/host/src/capability-package-mutation.ts`,
  `packages/skills/src/package-v2.ts`, and focused host tests.
- Tests: host focused Skill evolution/package-mutation suites and host
  typecheck/build.

- Status: Verified
- Date: 2026-07-12T13:45:22+0800
- Scope: completed Phase 3A substrate only; existing v1 Skill loading and
  evolution consumers remain unchanged pending Phase 3B.
- Read: `packages/skills/src/package.ts`, `packages/skills/src/package-v2.ts`,
  `packages/skills/src/index.ts`, and `packages/skills/test/index.test.ts`.
- Tests: `npm --workspace @sparkwright/skills test`; Skills typecheck/build;
  package-boundary and internal-import checks.

- Status: Read-only
- Date: 2026-07-12
- Scope: adjudicated documentation refactor; froze package identity v2,
  Workflow executable snapshot, Markdown Agent, statistics, reconciliation, and
  revised delivery boundaries without runtime changes.
- Read: `packages/skills/src/package.ts`,
  `packages/skills/src/markdown-folder-asset.ts`,
  `packages/host/src/skill-evolution.ts`,
  `packages/host/src/skill-command-service.ts`,
  `packages/host/src/agent-profiles.ts`, `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`, `packages/host/src/runtime.ts`,
  and `packages/agent-runtime/src/workflows/*`.
- Tests: not run; documentation-only redesign.

- Status: Verified
- Date: 2026-07-12T08:36:00+0800
- Scope: Phase 2 completion-card and persisted Skill inbox recovery slice.
- Read: TUI proposal store projection, App lifecycle, completion-card render,
  capability/Skill create adapters, and review dialog route.
- Tests: focused TUI completion card, event-store, proposal inbox/create/review
  tests and TUI typecheck.

- Status: Verified
- Date: 2026-07-12T08:34:00+0800
- Scope: Phase 2 command-service extraction and convergence of model, CLI,
  `/create skill`, and compatibility `/skill-create` proposal preparation.
- Read: shared service, four entry adapters, approval/apply path, focused tests,
  and the linked project/test maps.
- Tests: focused host/CLI/TUI suites, affected typechecks, and full
  `npm run release:check` on the same source tree.

- Status: Verified
- Date: 2026-07-12T02:00:00+0800
- Read: current `packages/skills` identity/guard code; host Skill evolution,
  stats, tool, review and doctor code; core tool/approval/runtime context;
  protocol/CLI/TUI proposal and approval surfaces; workflow/task waiting maps.
- Tests: host Skill evolution/tool suites (109 tests), affected core/host/TUI
  typechecks, focused TUI approval render/controller suites, and full
  `npm run release:check`.
