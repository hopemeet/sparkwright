# Skills

## Purpose

`@sparkwright/skills` owns deterministic Skill discovery, manifest parsing,
package identity, matching, loading, preprocessing hooks, and advisory usage
records. Host, CLI, and TUI compose those primitives into runtime loading,
project creation, diagnostics, and statistics. SparkWright no longer owns a
Skill self-evolution/proposal/history subsystem.

See [../maps/capabilities/skills.md](../maps/capabilities/skills.md) for the
current loading, creation, and statistics flow. The former change pipeline is
recorded only as retired history in
[../maps/capabilities/skill-evolution.md](../maps/capabilities/skill-evolution.md).

## Main Files

- `packages/skills/src/index.ts`
- `packages/skills/src/preprocess.ts`
- `packages/skills/src/loader.ts`
- `packages/skills/src/registry.ts`
- `packages/skills/src/matcher.ts`
- `packages/skills/src/usage.ts`
- `packages/skills/src/usage-file.ts`
- `packages/skills/src/manifest.ts`
- `packages/skills/src/markdown-folder-asset.ts`
- `packages/skills/src/package-v2.ts`
- `packages/host/src/project-skill-create.ts`
- `packages/host/src/skill-report.ts`
- `packages/host/src/skill-stats.ts`
- `packages/host/src/skill-doctor.ts`
- `packages/host/src/skill-usage.ts`
- `packages/host/src/skill-roots.ts`
- `packages/host/src/tools.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/lib/create-capability.ts`
- `packages/tui/src/lib/skills-browser.ts`
- `packages/tui/src/components/skills-panel.tsx`
- `docs/reference/SKILLS.md`

## Owns / Does Not Own

Owns:

- canonical `SKILL.md` parsing and layered discovery
- package identity v2 and identical-set snapshot primitives
- deterministic goal matching, resident loading, and `skill_load`
- host-owned deterministic project scaffold creation
- trace-derived, rebuildable per-package statistics

Does not own:

- automatic learning, proposal review, version history, or rollback
- mutation authority for existing Skill packages
- process execution, sandboxing, or trace emission for inline shell
- core event semantics or TUI presentation state

## Contracts

- Root precedence is `builtin -> user -> project -> configured`. Configured
  roots remain strongest external read-only sources for SparkWright commands.
- `parseSkillManifest` is the sole canonical manifest parser and requires
  non-empty instructions. `package-v2.ts` owns complete canonical ordinary-file
  enumeration and returns `packageHashPolicyVersion: 2`.
- Runtime indexing, trace metadata, capability inspection, lockfiles, doctor,
  and Stats share package identity v2. Model-visible Skill content excludes
  host absolute paths and package hashes; diagnostics retain provenance.
- The model-facing surface is read-only: `list_skills` and optional
  `skill_load`. `create_skill` and `update_skill` are not registered tools.
- `createProjectSkill` is the shared CLI/TUI creation boundary. It validates a
  deterministic template before publishing, accepts only the project root,
  reserves the target directory exclusively, and never overwrites an existing
  Skill. It writes no proposal, registry, history, or learning state.
- Existing Skill updates are ordinary controlled workspace changes. Shell
  writes remain subject to the general untracked-mutation rollback guard.
- Stats keys evidence by Skill + layer + package hash policy + package hash.
  It scans the bounded requested recent-session window, reuses valid unchanged
  projections for sessions still in that window, and uses a rebuildable catalog
  to skip unrelated current candidates for targeted Skill/package queries. A
  cached session outside `--last` is not included. Raw traces remain
  authoritative.
- Stats does not read self-evolution records. Existing
  `.sparkwright/skill-evolution/`, registry, or suggestion data from older
  releases is inert and must not be deleted as a side effect of reads or
  creation.
- Host writes the advisory `.sparkwright/skill-usage.json` load counters, but
  the sidecar does not affect default ranking and no longer records patch
  activity.
- Inline shell preprocessing remains opt-in, host-executed, sandbox-enforced,
  no-write, fail-closed, and traced as `extension.process.*` with
  `kind: skill_script`.
- TUI `/skills` is read-only and joins trace stats to the effective package by
  exact name, layer, and package identity. `/create skill` uses the deterministic
  creator; no proposal or learning layers are registered.

## Consumers

- Host runtime preparation and capability inspection
- CLI `skills list|create|validate|stats|doctor`
- TUI `/skills` and `/create skill`
- trace/session diagnostics and lockfile producers

## Change Checklist

- Check root precedence, manifest validation, and package identity v2.
- Check model tool inventory remains read-only for Skills.
- Check creation never overwrites and leaves legacy state untouched.
- Check Stats cache schema/algorithm invalidation and exact package identity.
- Check CLI/TUI/public docs and the retired capability map together.
- Keep trace events bounded; never require a full Skill body in event payloads.

## Last Verified

- Status: Verified
- Date: 2026-08-02
- Scope: removed Skill self-evolution across Host, CLI, TUI, config, and Stats;
  retained deterministic non-overwriting project creation, package identity v2,
  layered loading, doctor, and trace-derived cached statistics. Legacy state is
  ignored and preserved.
- Read: Skills package, Host creation/runtime/stats/tool/config paths, CLI/TUI
  adapters, schemas, public reference, and focused tests.
- Tests: Skills/Host builds, full affected workspace suites, final four-case
  creator regression, repository test typecheck, and generated schema passed.

- Status: Verified
- Date: 2026-08-02
- Scope: recorded the focused TUI `/skills` inventory as a read-only consumer
  of current layered reports, exact-identity trace statistics, and proposal
  summaries. Skill package, loading, ranking, mutation, and storage ownership
  are unchanged.
- Read: Skill report/stats/proposal sources, TUI browser projection and panel,
  capability Skill map, and user-facing TUI documentation.
- Tests: focused TUI Skills projection/rendering, formatting, and Markdown
  links passed; project-map drift completed.

- Status: Verified
- Date: 2026-07-26
- Scope: confirmed `AssetPackageIdentity.fileCount` as a retained public
  package-size diagnostic in both hash and snapshot results. The field is now
  explicitly reserved and both producers have regression assertions; package
  enumeration, hashing, and snapshot behavior are unchanged.
- Read: Skills package-v2 source/tests and asset-package identity design
  contracts.
- Tests: focused Skills 27/27, Skills typecheck, strict reserved-field check,
  project-map drift, and the full release gate passed.

- Status: Verified
- Date: 2026-07-19
- Scope: reviewed skill statistics after terminal outcome migration. Skill
  success/failure accounting now reads persisted assessment where semantic run
  health is needed; Skill discovery, authoring, mutation, and package contracts
  are unchanged.
- Read: Host skill statistics and unchanged Skill ownership surfaces.
- Tests: affected Host and CLI Skill coverage passed before final real-model
  canaries.

- Status: Verified
- Date: 2026-07-18T08:52:13+0800
- Scope: Skill statistics expose one load-failure DTO,
  `loadFailures.total/byMode/byStatus`. Host aggregation and caches no longer
  persist the duplicate `loadFailureCount` summary; session projection schema
  v3 invalidates the retired DTO and rebuilds from trace evidence.
- Read: Host Skill stats aggregation/cache/analyzer, CLI JSON/text rendering,
  focused tests, public Skill reference, and Skill project/test maps.
- Tests: focused CLI Skill stats/review/catalog/doctor 5/5, full CLI 155/155,
  Host and CLI typechecks, repository test typecheck, schema check, project-map
  drift, and the full release gate passed.

- Status: Verified
- Date: 2026-07-18T08:08:47+0800
- Scope: renamed current custom-root identity from `legacy` to `configured`
  without changing its strongest precedence or project-shadow evolution
  boundary. Runtime metadata, doctor findings, capability output, stats cache
  readers, docs, and tests now share the canonical layer.
- Read: Skills index/root types, Host roots/report/doctor/stats, CLI/TUI
  consumers and tests, public reference, and Skill capability/evolution maps.
- Tests: Skills 27/27, Host 21/21, CLI 4/4, TUI 13/13, plus affected package
  typechecks.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: TUI Skill creation has one human entrypoint, `/create skill`; the
  compatibility shortcut and its dedicated adapter path were removed without
  changing `SkillCommandService` proposal/apply ownership.
- Read: Host command service boundary, TUI generic creation and Skill
  update/review adapters, public Skill reference, and capability map.
- Tests: TUI create/evolution/command 22/22 and TUI typecheck passed.

- Status: Verified
- Date: 2026-07-17T20:55:00+0800
- Scope: made Skill package identity v2 canonical across runtime loading,
  trace/capability projection, lockfiles, doctor, statistics, proposal/history
  artifact continuity, and advisory suggestions. Removed the v1 package API,
  content/name-only stats buckets, and proposal artifact fallbacks.
- Read: Skills v1/v2 package paths, Host stats/evolution/registry/report/doctor,
  protocol capability schema, CLI consumers, public references, and focused maps/tests.
- Tests: Skills 73/73; Host Skill/protocol 81/81; focused CLI Skill stats/review/catalog/doctor 5/5; affected typechecks passed before the full release gate.

- Status: Verified
- Date: 2026-07-16T19:11:00+0800
- Scope: removed the Skill evolution v1 record/hash reader and made policy 2
  mandatory without changing the separate runtime Skill identity path.
- Read: Host Skill evolution, Skills v1/v2 package primitives, Host/CLI tests,
  and the Skill evolution capability map.
- Tests: focused Host Skill evolution and CLI stats suites; Host and test
  typechecks; full release gate; project-map drift check.

- Status: Verified
- Date: 2026-07-16T19:20:00+0800
- Scope: Removed the public `parseSkill` and internal
  `parseSkillManifestCompat` surfaces. All disk/runtime/evolution parsing now
  enters through strict `parseSkillManifest`; empty instructions are invalid.
- Read: Skills manifest/index/loader/tests, Host evolution consumers, Skills
  capability map, and parser proposal notes.
- Tests: Skills focused/full tests and typecheck; Host skill-evolution focused
  tests and typecheck; test typecheck; project-map drift check.

- Status: Verified
- Date: 2026-07-16T11:49:00+0800
- Scope: reviewed during cumulative branch drift checking; Skill loading and
  usage code uses canonical built-in tool names but does not consume Host
  protocol terminal failure payloads. No Skill contract changed in protocol 2.0.

- Status: Verified
- Date: 2026-07-13
- Scope: moved inline-shell OS-specific no-write/read-grant compilation into
  shell-sandbox; Skills injection and Host process/trace ownership are unchanged.
- Read: Skill inline-shell contract, Host adapter, and shell-sandbox compiler.
- Tests: Host Skill inline-shell focused tests and shell-sandbox tests passed.

- Status: Verified
- Date: 2026-07-12T23:45:00+0800
- Scope: `skill_load` returns the loaded Skill's `allowed-tools` as declarative
  tool dependencies for run-local deferred schema hydration.
- Read: Skills manifest/loader, capability-builder Skill, core consumer, and
  focused tests.
- Tests: focused Skills loader and core deferred-tool tests passed.

- Status: Verified
- Date: 2026-07-12
- Scope: proposal lifecycle reconciliation and competing-draft closure across
  host create/apply and TUI inbox recovery.
- Tests: focused host and TUI Skill proposal suites and affected typechecks.

- Status: Verified
- Date: 2026-07-12T20:00:00+0800
- Scope: hardened v2 snapshot disjointness and completed registry uniqueness,
  cross-volume-aware path relationships, recovery journal, transactionally
  origin-backed import, and suggestion cooldown behavior.
- Read: `packages/skills/src/package-v2.ts`, host Skill registry/suggestions,
  and focused package/host tests.
- Tests: focused Skills and host registry/suggestion suites passed.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked v2 package consumers, registry reconciliation, and advisory evidence suggestions.
- Tests: focused host/CLI tests and the 2026-07-15 release gate passed.

- Status: Verified
- Date: 2026-07-12T14:03:23+0800
- Scope: verified managed Skill v2 proposal/history/restore operations while
  deferring runtime stats identity.
- Read: `packages/host/src/skill-evolution.ts`,
  `packages/host/src/capability-package-mutation.ts`,
  `packages/skills/src/package-v2.ts`, and focused host tests.
- Tests: host focused Skill evolution/package-mutation suites and host
  typecheck/build.

- Status: Verified
- Date: 2026-07-12T13:45:22+0800
- Scope: added the standalone package identity v2 substrate without changing
  the v1 Skill runtime/evolution package path.
- Read: `packages/skills/src/package.ts`, `packages/skills/src/package-v2.ts`,
  `packages/skills/src/index.ts`, and `packages/skills/test/index.test.ts`.
- Tests: `npm --workspace @sparkwright/skills test`; Skills typecheck/build;
  `npm run check:package-boundaries`; `npm run check:internal-imports`.

- Status: Verified
- Date: 2026-07-12T08:25:00+0800
- Scope: create-entrypoint convergence behind `SkillCommandService`, including
  shared dedupe and effect-bound human review apply.
- Read: service, model tool, CLI and TUI adapters, focused tests.
- Tests: host service/evolution/tool suites, CLI create/apply tests, TUI generic
  and dedicated create/review tests, affected typechecks, and full
  `npm run release:check` on the same source tree.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: first managed-change vertical slice for safe model-authored Skill
  creation, including effect-bound approval, same-run apply, receipts, revision
  invalidation, and crash reconciliation.
- Read: `packages/host/src/skill-evolution.ts`, `packages/host/src/tools.ts`,
  `packages/core/src/types.ts`, `packages/core/src/run.ts`.
- Tests: host Skill evolution/tool focused suites (109 tests); affected
  typechecks; TUI approval render/controller focused suites.

- Status: Verified
- Date: 2026-07-12T00:56:00+0800
- Scope: added version-aware, run-scoped reference-load deduplication to bound
  repeated model observation cost without changing Skill routing or stats.
- Read: `packages/skills/src/index.ts`, `packages/skills/test/index.test.ts`,
  and `maps/capabilities/skills.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/index.test.ts`;
  `npm --workspace @sparkwright/skills run typecheck`.

- Status: Verified
- Date: 2026-07-11T23:20:00+0800
- Scope: added the structured model-draft to human-review handoff without
  widening the model-facing mutation boundary.
- Read: `packages/host/src/tools.ts`, `packages/host/src/skill-evolution.ts`,
  `packages/tui/src/lib/skill-evolution.ts`, and
  `maps/capabilities/skill-evolution.md`.
- Tests: host Skill tool/evolution focused suites and TUI Skill review focused
  suites passed; proposal-id review was verified through a real PTY.

- Status: Verified
- Date: 2026-07-11T22:17:00+0800
- Scope: model-facing create/update proposals now reuse session drafts across
  continuation runs and visibly revise changed draft content instead of
  creating duplicate directories or discarding later bodies.
- Read: `packages/host/src/tools.ts`, `packages/host/src/skill-evolution.ts`,
  `packages/host/test/tools.test.ts`, and
  `maps/capabilities/skill-evolution.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts
test/skill-evolution.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-07T13:18:00+0800
- Scope: real-mini Skill update proposal fix kept evolution actor boundaries
  unchanged while extending authored-body frontmatter normalization to
  `update_skill`: missing `description` is filled from the tool description,
  mismatched names remain fail-closed, and source Skill packages are not applied
  by model-facing tools.
- Read: `packages/host/src/tools.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/project-map/modules/skills.md`,
  `docs/_internal/test-map/runs/2026-07-07-real-mini-broad-trace-qa.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"update_skill|create_skill|Skill"`; `npm --workspace @sparkwright/host
test -- test/tools.test.ts`; `npm --workspace @sparkwright/host run
typecheck`; `npm run build --workspace @sparkwright/host`; `npm run
check:dist-fresh`; `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini
SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities`.

- Status: Verified
- Date: 2026-07-06T20:08:48+0800
- Scope: C8-bundles deletion retired the experimental Skill bundle helper and
  slash-resolution surface after the no-customer audit found no host/CLI/TUI or
  runtime product consumers.
- Read: `packages/skills/src/index.ts`, deleted
  `packages/skills/src/bundles.ts`, deleted
  `packages/skills/test/bundles.test.ts`, `packages/skills/README.md`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/skills test`;
  `npm --workspace @sparkwright/skills run typecheck`;
  `npm --workspace @sparkwright/skills run build`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: added the shared markdown-folder-asset primitive for folder-backed
  assets, moved workflow asset parsing onto it, and migrated Skill manifest
  frontmatter/content-hash helpers plus the Agent.md frontmatter scan copy
  while keeping owner-specific schema validation outside
  `@sparkwright/skills`.
- Read: `packages/skills/src/markdown-folder-asset.ts`,
  `packages/skills/src/index.ts`, `packages/skills/src/manifest.ts`,
  `packages/skills/test/markdown-folder-asset.test.ts`,
  `packages/host/src/agent-profiles.ts`, `packages/host/src/workflows.ts`,
  `docs/_internal/project-map/modules/skills.md`.
- Tests: `npm --workspace @sparkwright/skills test --
test/markdown-folder-asset.test.ts test/index.test.ts`;
  `npm --workspace @sparkwright/skills run typecheck`.

- Status: Verified
- Date: 2026-07-03T12:53:49+0800
- Scope: recorded Skill stats v1 identity semantics plus the follow-up
  projection/finding layer, proposal content-quality metadata and review digest,
  create_skill body normalization for real-model ergonomics, and advisory usage
  sidecar observations: emit-time package hashes in
  `skill.indexed`, package-hash aggregation in read-time stats, legacy identity
  buckets, explicit/resident load counts, load-failure classification,
  before/after-load associated failure counts, agent trace scanning,
  package-hash-aligned proposal/history rollups, trace/evolution windows,
  freshness timestamps, analyzer findings, session projection cache behavior,
  targeted query fields, lightweight catalog routing, shared runtime package
  hasher cache semantics with run-time IO limits, and host sidecar recording
  for load/mutation observations without ranking changes.
- Read: `packages/skills/src/index.ts`,
  `packages/skills/src/package.ts`,
  `packages/skills/src/usage.ts`,
  `packages/skills/src/usage-file.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/skill-stats.ts`,
  `packages/host/src/skill-review-digest.ts`,
  `packages/host/src/skill-usage.ts`,
  `packages/host/src/skill-evolution.ts`,
  `packages/host/src/tools.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/skill-usage.test.ts`,
  `packages/host/test/skill-evolution.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/skills/test/index.test.ts`,
  `packages/skills/test/usage.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/capabilities/skills.md`,
  `docs/_internal/proposals/skill-stats-evolution-evidence.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/usage.test.ts`;
  `npm --workspace @sparkwright/skills test -- test/index.test.ts -t
"reference file|repeated skill load"`;
  `npm --workspace @sparkwright/skills run build`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"instruction bodies|missing create_skill body description|frontmatter
names"`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/host test --
test/skill-usage.test.ts test/skill-evolution.test.ts -t "skill usage
sidecar|applies update proposals|reverts applied skill history"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"prepares configured skills"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "creates,
lists, and validates workspace skills|skill review digest|skill stats|skill
proposals"`; `npm --workspace @sparkwright/cli run build`.
- Prior verification — Date: 2026-06-27T19:27:28+0800
- Scope: removed unused loader/bundle test scaffolding while preserving Skill
  parser, loader, index, and then-current bundle behavior. Superseded by
  C8-bundles deletion on 2026-07-06.
- Read: `packages/skills/src/loader.ts`,
  `packages/skills/src/bundles.ts` (deleted later by C8-bundles),
  `packages/skills/src/index.ts`,
  `packages/skills/test/index.test.ts`,
  `packages/skills/test/skills.test.ts`,
  `packages/skills/test/bundles.test.ts` (deleted later by C8-bundles),
  `docs/_internal/project-map/maps/capabilities/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`.
- Tests: `npm --workspace @sparkwright/skills run typecheck`;
  `npm --workspace @sparkwright/skills test -- test/skills.test.ts
test/index.test.ts test/bundles.test.ts` (historical).
- Prior verification — Date: 2026-06-27T17:52:04+0800
- Scope: recorded the initial Phase 1 Skill parser/manifest unification
  decision; the temporary compatibility adapter was removed in the later
  canonical-only parser cleanup.
- Read: `packages/skills/src/index.ts`,
  `packages/skills/src/manifest.ts`, `packages/skills/src/loader.ts`,
  `packages/skills/src/types.ts`, `packages/skills/test/index.test.ts`,
  `packages/skills/test/skills.test.ts`,
  `docs/_internal/project-map/maps/capabilities/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/skills.test.ts
test/index.test.ts`; `npm --workspace @sparkwright/skills test`;
  `npm --workspace @sparkwright/skills run typecheck`.
- Prior verification — Date: 2026-06-27T17:35:00+0800
- Scope: updated model-facing `create_skill` to match the proposal-only
  mutation boundary and documented run-scoped create/update draft idempotency.
- Read: `packages/host/src/tools.ts`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-23T13:20:00+0800
- Read: `packages/skills/src/index.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/skill-evolution.ts`, `packages/host/test/tools.test.ts`,
  `docs/reference/SKILLS.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run build`.
