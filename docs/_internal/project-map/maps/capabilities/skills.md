# Skills Capability

## Purpose

Skills provide reusable instructions and resources that can be indexed, matched,
loaded into context, or exposed through a governed loader tool.

See [../../modules/skills.md](../../modules/skills.md). For mutating skills
(propose/apply/history/revert) rather than loading them, see
[skill-evolution.md](skill-evolution.md).

## Main Files

- `packages/skills/src/*`
- `packages/host/src/runtime.ts`
- `packages/host/src/runtime/capability-runtime-operations.ts`
- `packages/host/src/skill-usage.ts`
- `packages/host/src/skill-inline-shell.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/skill-evolution.ts`
- `packages/tui/src/app.tsx`

## Data Flow

```txt
skill roots
  -> prepareSkillsForRun()
  -> optional inline shell preprocessing via host runner
  -> skill.indexed/failed events
  -> context and/or skill_load tool
  -> skill.loaded event
  -> host Skill usage sidecar (.sparkwright/skill-usage.json; advisory only)
```

## Contracts

- The first managed-change fast path applies only to a complete, clean,
  model-authored create. Its package hash participates in a stable final-effect
  hash; runtime/model fingerprints remain outside that identity. Managed
  proposals carry required artifact identity and policy-2 package identity.

- Default host behavior exposes loader tool and does not auto-reside all selected skills.
- Capability inspection indexes configured Skill roots without resident
  selection through `CapabilityRuntimeOperations`; live-run loading remains in
  HostRuntime run preparation. Fatal index diagnostics preserve the canonical
  `run.created -> capability.index.failed -> run.failed` trace order.
- Project skill root defaults to `.sparkwright/skills`.
- Root precedence is `builtin -> user -> project -> configured`.
  `capabilities.skills.roots` supplies the canonical configured layer, which
  remains strongest for deterministic workspace overrides. Runtime reports,
  traces, stats, doctor, CLI, and TUI use that same label; `legacy` is not an
  accepted layer.
- Skill metadata parsing has one entry: `parseSkillManifest`. It rejects empty
  `instructions`; disk loaders, runtime preparation, and Skill evolution use
  that same strict parser. The parser preserves first-class `license` and
  `compatibility`, splits list fields consistently, and promotes
  `metadata.version` to canonical `version`.
- `capabilities.skills.inlineShell.enabled` is required before `` !`cmd` ``
  snippets in `SKILL.md` execute. Execution is host-owned, forces sandbox
  enforcement, disables workspace writes, fails closed when the OS sandbox is
  unavailable, and traces as `extension.process.*` with `kind: skill_script`.
  The platform-specific no-write/read-grant profile is compiled by
  `shell-sandbox`; Host retains process, timeout, output, and trace ownership.
  `skill_script` command arguments are redacted in lifecycle previews; failed
  stderr stays in trace summaries but is not inserted into model-facing Skill
  content.
- On-demand `skill_load` must turn missing/denied Skill loads and missing
  resources into structured `tool.failed` results (`SKILL_LOAD_FAILED`) and a
  `skill.failed` event carrying the original `toolCallId` so CLI summaries,
  trace diagnostics, and skill stats do not treat degraded context as success or
  double-count recovered companion failures. Missing resource failures include
  the Skill's available reference files when known, so a model that guessed a
  path like `README.md` can recover by loading the body and choosing an exact
  `<skill_files>` entry.
- A loader/run caches successful reference loads by Skill name, canonical
  resource path, and package identity. Repeating the same resource for
  the same Skill version returns a short `already_loaded` result without the
  content or another file read; failed/denied loads are never cached. The cache
  is loader-scoped and does not replace package-hash identity or trace stats.
- Skill index and resident Skill context must not expose host absolute
  source paths or package hashes to provider prompts. Keep source provenance
  in metadata and trace events.
- `skill.indexed` trace metadata includes required per-Skill emit-time package
  identity (`packageHash`, `packageHashPolicyVersion: 2`, and layer). On-demand
  `skill.loaded` remains path/hash-free and read-time stats join it back to the
  same run's indexed Skill by name. Resident `skill.loaded` may carry package
  identity because it is trace metadata, not model-visible content.
- `packages/skills/src/package-v2.ts` is the canonical Skill package substrate:
  complete ordinary-file
  enumeration, fixed exclusions, normalized NUL-framed hashing, identical-set
  snapshots, policy version 2, and fail-closed special-file/path/size checks.
  Runtime loading and managed evolution share it; the v1 package surface is gone.
- `skills stats` is read-time only. It aggregates by
  `skill + layer + name + packageHashPolicyVersion + packageHash`,
  ignores rows without canonical v2 identity,
  separates explicit and resident loads, and exposes load failures only through
  `loadFailures.total/byMode/byStatus`,
  splits associated tool failures before vs after first load, scans agent trace
  files with event-id dedupe, and rolls up proposal/history metadata only when
  package hashes align. It also reports trace/evolution windows, freshness
  timestamps, analyzer findings, and rebuildable session projection cache
  hit/miss/write/error counts. Projection schema and algorithm versions
  invalidate stale cache DTOs. Session projection Skill entries carry event
  windows plus bounded sample/failure run ids. A lightweight catalog cache maps
  Skill names, Skill keys, and package hashes to session projections for
  targeted `--skill`, `--skill-key`, and `--package-hash` queries. These are
  association signals, not causal claims.
- Capability snapshots and CLI `capabilities inspect` expose a path-free
  `skills.inlineShell` policy summary (`enabled`, `writePolicy`,
  `sandboxMode`, `failClosed`, timeout/output caps).
- Skill bundles are not a v1 runtime capability. The experimental package-level
  bundle registry, `.bundle.json` loader, and slash-command resolver were
  removed; grouped Skill behavior must not bypass the governed `skill_load`
  events, usage sidecar, or trace surfaces.
- Skill create/update tools are managed capability mutations, not raw shell
  writes; successful managed mutations emit `capability.mutation.completed`.
  Their model-authored `body` content is proposal-first: `create_skill` wraps
  instructions-only content, and both `create_skill` and `update_skill`
  normalize full `SKILL.md` bodies by filling a missing frontmatter
  `description` from the tool description while rejecting mismatched names.
- File-backed Skill usage recorders reload the current sidecar before reads and
  mutations so multiple recorder instances in one process do not overwrite each
  other's latest records. Host runtime now writes successful `skill.loaded`
  observations to `.sparkwright/skill-usage.json`: `mode:
"on_demand_tool"` increments `explicitLoadCount`, `mode:
"resident_context"` increments `residentLoadCount`, and both increment
  aggregate `useCount`. Proposal apply/restore and direct project
  `skills create` record `patchCount`. This is still an advisory observation
  store, not a routing authority; usage-based ranking remains outside the host
  default path.

## Consumers

- Host runtime.
- CLI `skills` commands.
- TUI `/skill-create`, `/skill-update`, `/skill-review`, `/skill-learn`.
- Capability inspection.

## Change Checklist

- Check root layering and shadowing behavior.
- Check event payloads for indexed/loaded/failed skills.
- Check inline-shell opt-in config and trace/sandbox behavior if preprocessing changes.
- Check `skill_load` tool failure normalization, CLI summaries, trace summary,
  and `skills stats` if loader output statuses change.
- Check TUI and CLI proposal flows if evolution behavior changes.
- Keep untrusted session learning separate from stable runtime loading.

## Known Debts

- Self-evolution design exists, but automatic learning should remain clearly opt-in/reviewed.

## Last Verified

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

- Status: Reviewed
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
