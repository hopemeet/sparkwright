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
  hash; runtime/model fingerprints remain outside that identity. The broader
  `artifactId + packageHash` registry/stats migration is designed but not yet
  implemented.

- Default host behavior exposes loader tool and does not auto-reside all selected skills.
- Project skill root defaults to `.sparkwright/skills`.
- Skill metadata parsing is manifest-centered. `parseSkillManifest` is the
  strict canonical parser and rejects empty `instructions`; the legacy
  `parseSkill` loader path is a compatibility adapter that still accepts empty
  markdown bodies. The shared parser preserves first-class `license` and
  `compatibility`, splits list fields consistently, and promotes
  `metadata.version` to canonical `version`.
- `capabilities.skills.inlineShell.enabled` is required before `` !`cmd` ``
  snippets in `SKILL.md` execute. Execution is host-owned, forces sandbox
  enforcement, disables workspace writes, fails closed when the OS sandbox is
  unavailable, and traces as `extension.process.*` with `kind: skill_script`.
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
  resource path, and package/content identity. Repeating the same resource for
  the same Skill version returns a short `already_loaded` result without the
  content or another file read; failed/denied loads are never cached. The cache
  is loader-scoped and does not replace package-hash identity or trace stats.
- Skill index and resident Skill context must not expose host absolute
  `sourcePath`/`contentHash` values to provider prompts. Keep source provenance
  in metadata and trace events.
- `skill.indexed` trace metadata includes per-Skill emit-time package identity
  (`packageHash` when available, `contentHash`, and layer). On-demand
  `skill.loaded` remains path/hash-free and read-time stats join it back to the
  same run's indexed Skill by name. Resident `skill.loaded` may carry package
  identity because it is trace metadata, not model-visible content.
- Runtime indexing computes package identity through a shared process-local
  hasher cache, reducing repeated content reads for unchanged packages across
  runs/agents. The run-time identity path has conservative file/byte guardrails;
  direct exact hash computation remains available to evolution guard paths.
- `packages/skills/src/package-v2.ts` provides the dormant v2 canonical package
  substrate for later Skill/Workflow migration: complete ordinary-file
  enumeration, fixed exclusions, normalized NUL-framed hashing, identical-set
  snapshots, policy version 2, and fail-closed special-file/path/size checks.
  It does not change current Skill index/load or proposal behavior until
  Phase 3B.
- `skills stats` is read-time only in v1. It aggregates by
  `name + layer + packageHash`, classifies old traces as legacy/unknown,
  separates explicit and resident loads, classifies load failures by mode/status,
  splits associated tool failures before vs after first load, scans agent trace
  files with event-id dedupe, and rolls up proposal/history metadata only when
  package hashes align. It also reports trace/evolution windows, freshness
  timestamps, analyzer findings, and rebuildable session projection cache
  hit/miss/write/error counts. Session projection Skill entries carry event
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

- Status: Read-only
- Date: 2026-07-12
- Scope: checked v2 Skill package identity, reconciliation, and evidence-review consumers.
- Tests: focused Skill/host tests passed; release gate pending.

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
