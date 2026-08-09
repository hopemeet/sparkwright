# Skills Capability

## Purpose

Skills provide reusable instructions and resources that can be indexed, loaded
into context, inspected, created deterministically at the project layer, and
measured from runtime traces. See
[../../modules/skills.md](../../modules/skills.md). Skill self-evolution is a
retired capability; its former map is historical only.

## Main Files

- `packages/skills/src/*`
- `packages/host/src/runtime.ts`
- `packages/host/src/runtime/capability-runtime-operations.ts`
- `packages/host/src/project-skill-create.ts`
- `packages/host/src/skill-stats.ts`
- `packages/host/src/skill-inline-shell.ts`
- `packages/host/src/skill-usage.ts`
- `packages/host/src/tools.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/lib/create-capability.ts`
- `packages/tui/src/lib/skills-browser.ts`
- `packages/tui/src/components/skills-panel.tsx`

## Data Flow

```txt
skill roots
  -> prepareSkillsForRun()
  -> optional host-owned inline-shell preprocessing
  -> skill.indexed / skill.failed
  -> resident context and/or skill_load
  -> skill.loaded
  -> session trace + advisory load counters

session traces
  -> fingerprinted per-session projection cache
  -> rebuildable name/key/package catalog
  -> bounded recent-window or targeted Stats report

CLI skills create / TUI create Skill
  -> deterministic manifest validation
  -> exclusive project-directory reservation
  -> publish SKILL.md once; never overwrite

TUI /skills
  -> effective layered Skill report
  -> trace-derived Stats
  -> exact identity join
  -> compact inventory -> Enter diagnostics
```

## Contracts

- Default host behavior exposes `skill_load` and does not resident-load selected
  Skills unless explicitly configured.
- Root precedence is `builtin -> user -> project -> configured`; project is the
  only CLI/TUI creation target.
- Manifest validation and all package-aware consumers use the required v2
  package identity. `contentHash` and name-only evidence are not version keys.
- `skill.indexed` metadata carries emit-time package identity. On-demand
  `skill.loaded` joins to that run-local index by name; failed loads remain
  structured failures and are retryable.
- The model can inspect/load Skills but cannot create or update them through a
  privileged Skill mutation tool.
- Creation validates before publication and fails if the target exists. It does
  not create registry, proposal, history, approval-receipt, or learning data.
- Stats reports indexing/loading, explicit/resident loads, load failures,
  associated run outcomes, and associated tool failures. Association is not a
  causality claim.
- The recent `--last` selection is bounded. Unchanged selected sessions reuse
  projections, while targeted name/key/package queries use the catalog to avoid
  unrelated sessions inside the same candidate window. Cached sessions outside
  the current bound do not contribute to totals. Both cache layers are
  disposable and rebuild after schema/algorithm/fingerprint mismatch.
- Old self-evolution directories are outside the Stats input contract. Readers
  and creators ignore them without deleting or migrating user data.
- TUI `/skills` shows current exact-identity usage; it has no draft count.
  `/create skill` shares the deterministic Host creator.
- Inline shell is opt-in, host-owned, no-write, fail-closed, and sandboxed.

## Public Surfaces

- CLI: `skills list|create|validate|stats|doctor`
- TUI: `/skills`, `/create skill`
- Model tools: `list_skills`, optional `skill_load`
- Config: loading roots, selection/loading limits, and inline-shell settings;
  there is no `capabilities.skills.evolution` field

## Change Checklist

- Preserve exact root/layer and v2 package identity across runtime and Stats.
- Preserve no-overwrite project creation and legacy-data non-deletion.
- Bump cache schema/algorithm versions when projection meaning changes.
- Update Host, CLI, TUI, schemas, public docs, test routes, and the retired map
  together when the public surface changes.

## Last Verified

- Status: Verified
- Date: 2026-08-08
- Scope: project Skill roots are omitted from discovery, indexing, and
  inline-shell preprocessing until their independent Project Trust scope is
  admitted. User Skills and the deterministic loader remain available.
- Read: project trust manifest, Host Skill-root resolution, run/capability
  preparation, CLI/TUI discovery, and the existing Skill runtime boundary.
- Tests: focused Host trust/preparation and TUI project-discovery coverage
  passed; the real Host regression confirmed pre-execution denial.

- Status: Verified
- Date: 2026-08-02
- Scope: removed privileged Skill mutation, proposal/history/learning state,
  config, UI, and Stats rollups; retained layered loading, deterministic
  creation, exact package identity, and cached trace statistics.
- Read: package loading/identity, Host runtime/creator/stats/tools/config,
  CLI/TUI adapters, schemas, docs, and focused coverage.
- Tests: full affected workspace suites, final four-case creator regression,
  repository test typecheck, and generated schema passed.

- Status: Verified
- Date: 2026-08-01
- Scope: added the focused TUI `/skills` inventory/usage projection over the
  existing layered report, trace stats, and proposal sources without changing
  Skill runtime, Host storage, or protocol contracts.
- Read: Host Skill report/stats/evolution exports, TUI loader/component/action/
  route wiring, and exact-identity projection tests.
- Tests: TUI typecheck, focused 11/11, full TUI 83 files / 550 tests, build,
  and real 80-column `/skills` PTY inspection passed.

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
- Scope: reviewed Host skill-stat consumers after assessment consolidation.
  Persisted Core health replaces the removed outcome sidecar where semantic
  status is needed; Skill package/application contracts are unchanged.
- Read: Host skill stats and current Skill capability ownership.
- Tests: affected Host/CLI Skill coverage passed.

- Status: Verified
- Date: 2026-07-18T08:52:13+0800
- Scope: Skill stats load failures now have one structured counter/classifier
  contract. The parallel summary field and its merge/increment/serialization
  path are gone, CLI renders the structured total, and v2 session projections
  rebuild under schema v3.
- Read: Host stats projection/cache, CLI stats formatter and integration tests,
  public Skill reference, and Skill module/test maps.
- Tests: focused CLI Skill stats/review/catalog/doctor 5/5, full CLI 155/155,
  Host and CLI typechecks, repository test typecheck, schema check, project-map
  drift, and the full release gate passed.

- Status: Verified
- Date: 2026-07-18T08:08:47+0800
- Scope: configured Skill roots now carry the sole canonical `configured`
  layer through loading, trace/capability projection, doctor, and statistics;
  stale `legacy` catalog/session cache layers are rejected and rebuilt.
- Read: Skills loader/root contracts, Host root/report/doctor/stats paths,
  CLI/TUI projections, tests, and public Skill documentation.
- Tests: Skills 27/27, Host 21/21, CLI 4/4, TUI 13/13, and affected package
  typechecks.

- Status: Verified
- Date: 2026-07-17T20:55:00+0800
- Scope: runtime Skill identity now uses the same policy-2 full-package primitive
  as evolution. Trace, capability inspection, stats, doctor, and lockfiles no
  longer expose or fall back to v1/content-only identity.
- Read: Skills loader/package/tests; Host report/doctor/stats/evolution/runtime;
  protocol schema and CLI stats consumers.
- Tests: Skills 73/73; focused Host Skill/protocol 81/81; focused CLI Skill gates 5/5; affected typechecks.

- Status: Verified
- Date: 2026-07-16T11:49:00+0800
- Scope: reviewed during cumulative branch drift checking; Skill capability
  discovery is independent of Host `run.failed` serialization and requires no
  protocol 2.0 change.

- Status: Verified
- Date: 2026-07-13
- Scope: centralized Skill inline-shell no-write/read filesystem grants in
  shell-sandbox without changing opt-in, fail-closed, or trace behavior.
- Read: Host Skill inline-shell adapter and shell-sandbox compiler.
- Tests: Host Skill inline-shell tests 5/5 and shell-sandbox tests 14/14.

- Status: Verified
- Date: 2026-07-12T23:45:00+0800
- Scope: body-level Skill loading carries declared tool dependencies to core;
  only dependencies already registered in the run become model-visible.
- Read: Skills loader, core run loop, capability-builder Skill, and focused
  tests.
- Tests: focused Skills loader and core deferred-tool tests passed.

- Status: Verified
- Date: 2026-07-12T20:00:00+0800
- Scope: v2 snapshots reject ancestor targets; reconciliation enforces one
  active owner per path and recovers journaled registry/receipt writes; import
  records origin in the same recoverable transaction; review suggestions
  support durable cooldown dismissal. Snapshot overlap checks are cross-volume
  aware on Windows.
- Read: package-v2, Skill registry, suggestions/review, CLI and tests.
- Tests: focused Skills, host, and CLI suites passed.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked v2 Skill package identity, reconciliation, and evidence-review consumers.
- Tests: focused Skill/host tests and the 2026-07-15 release gate passed.

- Status: Verified
- Date: 2026-07-12T14:05:58+0800
- Scope: checked the loader/runtime capability path after managed Skill v2
  evolution migration; its v1 runtime package identity contract is unchanged
  pending the separate Phase 6 event-time stats migration.
- Read: `packages/host/src/skill-evolution.ts`,
  `packages/host/src/capability-package-mutation.ts`,
  `packages/skills/src/index.ts`, and `packages/skills/src/package-v2.ts`.
- Tests: focused host/CLI/Skills suites and full `npm run release:check`.

- Status: Verified
- Date: 2026-07-12T13:45:22+0800
- Scope: verified the standalone package identity v2 substrate and that current
  Skill runtime identity still uses the v1 hasher.
- Read: `packages/skills/src/package.ts`, `packages/skills/src/package-v2.ts`,
  `packages/skills/src/index.ts`, and `packages/skills/test/index.test.ts`.
- Tests: full `@sparkwright/skills` suite, Skills typecheck/build, package
  boundaries, and internal-import checks.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: safe authored create prepared-change identity and apply path; runtime
  Skill indexing/loading contracts are unchanged.
- Read: `packages/host/src/skill-evolution.ts`, `packages/host/src/tools.ts`,
  `packages/skills/src/package.ts`, `packages/skills/src/guard.ts`.
- Tests: host focused Skill suites and affected typechecks.

- Status: Verified
- Date: 2026-07-12T00:56:00+0800
- Scope: added run-scoped Skill reference deduplication keyed by canonical
  resource path and package/content identity; repeat results omit resource
  content while preserving failure recovery and version boundaries.
- Read: `packages/skills/src/index.ts`, `packages/skills/test/index.test.ts`,
  `packages/core/src/run.ts`, and this map.
- Tests: `npm --workspace @sparkwright/skills test -- test/index.test.ts`;
  `npm --workspace @sparkwright/skills run typecheck`.

- Status: Verified
- Date: 2026-07-07T13:18:00+0800
- Scope: Skill mutation tool contract update after real mini QA: `update_skill`
  authored bodies now share frontmatter description normalization with
  `create_skill`; managed mutation events, proposal-first behavior, and source
  package non-application were verified.
- Read: `packages/host/src/tools.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/maps/capabilities/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/test-map/coverage/skills.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"update_skill|create_skill|Skill"`; `npm --workspace @sparkwright/host
test -- test/tools.test.ts`; `npm --workspace @sparkwright/host run
typecheck`; `npm run build --workspace @sparkwright/host`; `npm run
check:dist-fresh`; `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini
SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities`.

- Status: Verified
- Date: 2026-07-06T20:08:48+0800
- Scope: C8-bundles deletion removed the experimental package-level bundle
  capability surface after confirming no product customers; Skill loading and
  evolution remain the supported capability paths.
- Read: `packages/skills/src/index.ts`, deleted
  `packages/skills/src/bundles.ts`, deleted
  `packages/skills/test/bundles.test.ts`, `packages/skills/README.md`,
  `docs/_internal/project-map/maps/capabilities/skills.md`.
- Tests: `npm --workspace @sparkwright/skills test`;
  `npm --workspace @sparkwright/skills run typecheck`;
  `npm --workspace @sparkwright/skills run build`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-03T12:53:49+0800
- Scope: recorded Skill package identity in indexed trace metadata, read-time
  stats aggregation/failure classification semantics, agent trace scanning,
  package-hash-aligned proposal/history rollups, trace/evolution windows,
  freshness timestamps, analyzer findings, rebuildable session projection
  cache behavior, targeted query fields, lightweight catalog routing, shared
  runtime package hasher cache semantics with run-time IO limits, and host
  usage sidecar observations for on-demand loads, resident loads, and project
  Skill mutations without ranking changes, plus missing-resource recovery
  hints for the governed `skill_load` tool.
- Read: `packages/skills/src/index.ts`,
  `packages/skills/src/package.ts`,
  `packages/skills/src/usage.ts`,
  `packages/skills/src/usage-file.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/skill-usage.ts`,
  `packages/host/src/skill-evolution.ts`,
  `packages/host/src/skill-stats.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/skill-usage.test.ts`,
  `packages/host/test/skill-evolution.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/skills/test/index.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/skill-stats-evolution-evidence.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/usage.test.ts`;
  `npm --workspace @sparkwright/skills test -- test/index.test.ts -t
"reference file|repeated skill load"`;
  `npm --workspace @sparkwright/skills run build`;
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
- Scope: confirmed loader/bundle cleanup did not change skill loading,
  on-demand load, or then-current bundle behavior. Superseded by C8-bundles
  deletion on 2026-07-06.
- Read: `packages/skills/src/loader.ts`,
  `packages/skills/src/bundles.ts` (deleted later by C8-bundles),
  `packages/skills/src/index.ts`,
  `packages/skills/test/index.test.ts`,
  `packages/skills/test/skills.test.ts`,
  `packages/skills/test/bundles.test.ts` (deleted later by C8-bundles).
- Tests: `npm --workspace @sparkwright/skills run typecheck`;
  `npm --workspace @sparkwright/skills test -- test/skills.test.ts
test/index.test.ts test/bundles.test.ts` (historical).
- Prior verification — Date: 2026-06-27T17:52:04+0800
- Scope: recorded Phase 1 Skill parser/manifest unification and compatibility
  adapter behavior for the loading capability.
- Read: `packages/skills/src/index.ts`,
  `packages/skills/src/manifest.ts`, `packages/skills/src/loader.ts`,
  `packages/skills/src/types.ts`, `packages/skills/test/index.test.ts`,
  `packages/skills/test/skills.test.ts`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/skills.test.ts
test/index.test.ts`; `npm --workspace @sparkwright/skills test`;
  `npm --workspace @sparkwright/skills run typecheck`.
- Prior verification — Date: 2026-06-27T17:35:00+0800
- Scope: clarified file-backed Skill usage recorder merge/reload behavior and
  kept usage observations out of default ranking.
- Read: `packages/skills/src/usage-file.ts`,
  `packages/skills/test/usage.test.ts`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/usage.test.ts`;
  `npm --workspace @sparkwright/skills run typecheck`.
- Prior verification — Date: 2026-06-20
- Read: `packages/skills/src/index.ts`, `packages/skills/src/preprocess.ts`, `packages/skills/src/guard.ts`, `packages/host/src/runtime.ts`, `packages/host/src/skill-inline-shell.ts`, `packages/host/src/traced-process-runner.ts`, `packages/host/src/skill-stats.ts`, `packages/core/src/context.ts`, `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/cli/src/run-outcome.ts`, `packages/protocol/src/index.ts`, `schemas/host-message.schema.json`, `docs/reference/SKILLS.md`, `docs/reference/TRACE_EXTENSION_EVENTS.md`, `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/index.test.ts`; `npm --workspace @sparkwright/core test -- test/context.test.ts`; `npm --workspace @sparkwright/core test -- test/trace.test.ts test/run.test.ts`.
