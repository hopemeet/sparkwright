# Skills

## Purpose

`@sparkwright/skills` indexes, validates, matches, loads, and packages Skill
sources. Host and CLI layers turn those primitives into runtime context,
loader tools, reports, proposals, and evolution workflows.

See also [../maps/capabilities/skills.md](../maps/capabilities/skills.md) (loading)
and [../maps/capabilities/skill-evolution.md](../maps/capabilities/skill-evolution.md)
(the propose/apply/history/restore change pipeline).

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
- `packages/host/src/skill-report.ts`
- `packages/host/src/skill-evolution.ts`
- `packages/host/src/skill-review-digest.ts`
- `packages/host/src/skill-usage.ts`
- `packages/host/src/skill-roots.ts`
- `docs/reference/SKILLS.md`
- `docs/_internal/project-map/maps/capabilities/skills.md`
- `docs/_internal/project-map/maps/capabilities/skill-evolution.md`

## Owns / Does Not Own

Owns:

- skill package/index/load primitives
- skill metadata and validation
- Skill body preprocessing hooks and the inline-shell runner interface
- skill usage/reporting helpers in package scope

Does not own:

- host capability layering policy by itself
- TUI proposal UI
- automatic long-term learning decisions
- core event semantics
- process execution, sandboxing, or trace emission for inline shell

## Contracts

- Skill events include `skill.indexed`, `skill.failed`, and `skill.loaded`.
- `skill.indexed.metadata.skills[]` carries emit-time identity provenance,
  including `contentHash`, `packageHash` when available, and layer. Skill stats
  use `name + layer + packageHash` as the strong version identity and keep old
  traces in legacy/unknown buckets rather than merging them into package-hash
  identities. Stats scan both session traces and `agents/<agent-id>/trace.jsonl`
  files, dedupe repeated event ids, and roll up proposal/history activity only
  when evolution metadata hashes match the package-hash identity.
- Runtime Skill indexing uses a shared process-local package hasher cache to
  avoid rereading unchanged package contents across runs/agents and applies
  conservative file/byte limits on the run-time identity path. Direct
  `computeSkillPackageHash()` remains the exact, uncached path for evolution
  apply/restore guard checks.
- `skills stats` materializes rebuildable per-session projections under
  `.sparkwright/skill-stats/sessions/`, keyed by trace fingerprints plus a
  projection algorithm version. Reports expose trace/evolution windows,
  freshness timestamps, cache hit/miss/write/error counts, and analyzer
  findings. Per-session Skill entries include event windows and bounded run
  samples for later targeted evidence queries. A lightweight
  `.sparkwright/skill-stats/catalog.json` routes `--skill`, `--skill-key`, and
  `--package-hash` queries to relevant session projections; it is still a
  rebuildable cache, not a full Skill rollup or source of truth.
- Host writes an advisory Skill usage sidecar at
  `.sparkwright/skill-usage.json`. Successful on-demand `skill_load` events
  increment `useCount` + `explicitLoadCount`; configured resident loads
  increment `useCount` + `residentLoadCount`; proposal apply/restore and direct
  project `skills create` increment `patchCount`. The sidecar is best-effort
  and does not affect default ranking.
- Host defaults to on-demand loading via `skill_load` unless config opts into
  selected skill residency.
- Markdown-folder asset helpers own only generic folder discovery,
  frontmatter/body splitting, loose frontmatter parsing, and content hashing.
  Domain schemas and diagnostics remain with the owner, such as host skills,
  agent profiles, or workflow assets.
- `SkillManifest` is the canonical parser-normalized metadata shape. The
  canonical `parseSkillManifest` path requires non-empty `instructions`, while
  legacy `parseSkill` delegates through a compatibility adapter that still
  accepts an empty `SKILL.md` body and exposes it as `SkillDefinition.body: ""`.
  The shared parser owns description length validation, list splitting,
  `license`, `compatibility`, `allowedTools`, top-level `version`, and
  `metadata.version` normalization.
- Skill index and resident Skill context must keep host absolute source paths
  out of model-visible content/source labels; diagnostics retain provenance in
  metadata and trace events.
- Inline shell preprocessing is opt-in. `@sparkwright/skills` only exposes the
  `preprocess.inlineShellRunner` injection point; host owns execution,
  sandboxing, and trace events. Failed inline shell expansion should insert a
  short marker into Skill content rather than raw stderr; host trace summaries
  carry the bounded diagnostic output.
- Experimental Skill bundle helpers are retired. `@sparkwright/skills` no
  longer exports bundle registries, slash-command bundle resolution, or
  `.bundle.json` loading; any future grouped-skill product surface must use the
  governed `skill_load`/trace/usage path rather than injecting untracked bodies.
- Project skills live under `.sparkwright/skills/` by default.
- Evolution is actor-split for proposal application: model-facing
  `create_skill` and `update_skill` only draft proposals; model tools can
  provide `body` content, with `create_skill` accepting either full `SKILL.md`
  or instructions-only content that the host wraps with `name` and
  `description`. For full `SKILL.md` bodies supplied to either `create_skill`
  or `update_skill`, host fills a missing frontmatter `description` from the
  tool description and still rejects mismatched frontmatter names. Proposal
  metadata records whether content is authored, a generated create template, or
  an intent-only update stub. Apply, reject,
  supersede, prune, and restore are human-only CLI/TUI surfaces, never model
  tools. Manual CLI `sparkwright skills create` remains a direct project Skill
  management command. Applied proposal changes snapshot to history; `skills
  restore --to before` is the revert edge. See
  [../maps/capabilities/skill-evolution.md](../maps/capabilities/skill-evolution.md).
- `skills review` is a host-backed CLI digest that combines draft proposal
  backlog with actionable trace-stats findings (`SKILL_LOAD_FAILURES` and
  `ASSOCIATED_TOOL_FAILURES`) without relying on the usage sidecar.
- Repeated model-authored `create_skill` / `update_skill` drafts for the same
  skill within the same run return the existing draft proposal instead of
  creating another one.

## Consumers

- Host runtime preparation.
- CLI `skills` commands.
- TUI `/skill-*` flows.
- Capability inspection.

## Change Checklist

- Check skill roots and layer precedence.
- Check host runtime context injection and loader-tool behavior.
- Check inline-shell preprocessing defaults, runner injection, and host sandbox
  routing when changing `preprocess.ts` or `loadSkill`.
- Check skill evolution proposal/history flows.
- Keep trace events small; do not require full skill body in event payloads.

## Known Debts

- Skill self-evolution machinery is solid: immutable snapshots,
  hash/doctor-gated apply, model-authored create/update drafts,
  `update_skill --body` for authored content, `guard.inspectSkill` at
  draft+apply, and history with `restore --to before` revert. Proposals drafted
  during a run record run/session provenance (reverse-lookup via `proposals
  list --run/--session`); failed drafts self-clean. See
  [../maps/capabilities/skill-evolution.md](../maps/capabilities/skill-evolution.md#known-debts).

## Last Verified

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
- Scope: recorded Phase 1 Skill parser/manifest unification decision and
  compatibility adapter behavior.
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
