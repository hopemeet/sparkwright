# Skill Evolution Capability (Retired)

## Status

Retired on 2026-08-02. This page is design and verification history, not an
active routing map. Current Skill contracts live in
[skills.md](skills.md) and [../../modules/skills.md](../../modules/skills.md).

## Removed Runtime Surface

- Host proposal/history/registry/suggestion/command-service modules
- model tools `create_skill` and `update_skill`
- CLI `skills review|reconcile|proposals|history|restore`
- TUI `/skill-update`, `/skill-review`, `/skill-learn`, proposal dialogs,
  human-action completion cards, and automatic learning
- `capabilities.skills.evolution` config and generated schema
- Stats proposal/history windows, rollups, findings, and freshness inputs
- patch counters tied to managed Skill changes

## Retained Contracts

- `package-v2.ts` remains the canonical runtime Skill identity primitive; it is
  not self-evolution state.
- Project creation remains deterministic through
  `packages/host/src/project-skill-create.ts` and never overwrites.
- Existing Skill changes are ordinary controlled workspace edits.
- Stats remains trace-derived and may reuse rebuildable historical session
  projections and the targeted catalog.
- Old `.sparkwright/skill-evolution/`, registry, suggestion, or cache data is
  inert legacy user data. No read, creation, or Stats command deletes it.

## Migration Notes

- Replace proposal create/apply with `skills create` for a new project Skill.
- Replace update/restore workflows with source control plus ordinary reviewed
  file edits.
- Remove `capabilities.skills.evolution` from config.
- Do not build new consumers against old proposal/history file formats.

## Last Verified

- Status: Verified
- Date: 2026-08-02
- Scope: removed the complete active Skill self-evolution path while retaining
  loading, identity v2, deterministic non-overwriting project creation, doctor,
  and trace-derived cached Stats. Legacy data is ignored and preserved.
- Read: deleted Host/TUI modules and consumers, CLI routing, config/schema,
  package exports, scripts, public docs, and current Skill maps.
- Tests: builds, full affected workspace suites, final four-case creator
  regression, and repository test typecheck passed.

- Status: Verified
- Date: 2026-07-18T08:08:47+0800
- Scope: evolution now describes current custom roots as `configured` and
  reports `CONFIGURED_*` findings while preserving project fork/shadow updates
  instead of mutating those strongest override sources.
- Read: Skill root resolution, doctor/reporting, evolution tests, public Skill
  reference, and loading/evolution maps.
- Tests: focused Host root/evolution 21/21, CLI capability/doctor/stats 4/4,
  TUI evolution 13/13, and affected package typechecks.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: removed the TUI `/skill-create` compatibility entry while preserving
  the canonical generic creation adapter and the same governed proposal,
  review, effect authorization, doctor, and history pipeline.
- Read: TUI command/capability/Skill actions, Host command service, public Skill
  reference, and focused TUI tests.
- Tests: TUI create/evolution/command 22/22 and TUI typecheck passed.

- Status: Verified
- Date: 2026-07-17T20:55:00+0800
- Scope: made prepared and historical Skill artifact identity required, removed
  `legacy:project:<name>` and random-history fallbacks, and preserved identity
  through registry/history resolution for later project updates.
- Read: Skill evolution, registry, stats rollup, Host/CLI tests, and managed-change design.
- Tests: Host Skill evolution 19/19 plus focused CLI Skill stats/review/doctor gates and affected typechecks.

- Status: Verified
- Date: 2026-07-16T19:11:00+0800
- Scope: Skill evolution proposal/history/receipt records require package hash
  policy v2; removed the missing-version fallback and v1 hash reader while
  leaving the distinct current runtime Skill identity path unchanged.
- Read: `packages/host/src/skill-evolution.ts`, Host/CLI tests,
  `packages/skills/src/package.ts`, and package-governance design notes.
- Tests: focused Host Skill evolution and CLI stats suites; Host and test
  typechecks; full release gate; project-map drift check.

- Status: Verified
- Date: 2026-07-16T19:34:00+0800
- Scope: Skill proposal/evolution parsing enters the strict canonical manifest
  parser; removing the legacy public parser did not change proposal lifecycle,
  package hashing, or apply gates.
- Read: `packages/skills/src/index.ts`, `packages/host/src/skill-evolution.ts`,
  and focused Skill evolution/command-service tests.
- Tests: Skills full suite and typecheck; focused Host Skill evolution and
  command-service suites; Host and test typechecks.

- Status: Verified
- Date: 2026-07-12
- Scope: competing-draft supersession, legacy inbox reconciliation, stale
  create/update classification, and TUI actionable-draft recovery.
- Read: `packages/host/src/skill-evolution.ts`,
  `packages/host/src/skill-command-service.ts`,
  `packages/tui/src/lib/skill-evolution.ts`, and focused tests.
- Tests: focused host Skill evolution/command-service and TUI Skill evolution
  suites; affected typechecks.

- Status: Verified
- Date: 2026-07-12T20:00:00+0800
- Scope: direct reconciliation remains distinct from mutation receipts and now
  has unique ownership, recovery journaling, explicit import origin, and
  persisted advisory-suggestion suppression. Import origin, registry, and
  reconciliation receipt recover from one pending transaction.
- Read: Skill evolution, registry, suggestion/review and CLI paths.
- Tests: focused registry, suggestion, evolution, and CLI suites passed.

- Status: Verified
- Date: 2026-07-12T14:03:23+0800
- Scope: migrated managed Skill package operations to the v2 canonical file
  set with external-file drift stale protection.
- Read: `packages/host/src/skill-evolution.ts`,
  `packages/host/src/capability-package-mutation.ts`,
  `packages/skills/src/package-v2.ts`, and focused host tests.
- Tests: host focused Skill evolution/package-mutation suites and host
  typecheck/build.

- Status: Verified
- Date: 2026-07-12T08:36:00+0800
- Scope: documented TUI persisted-inbox recovery and completion-card boundary.
- Read: TUI proposal helper, action hooks, event store, App and review dialog.
- Tests: focused TUI completion-card and persistent-inbox suites; TUI typecheck.

- Status: Verified
- Date: 2026-07-12T08:25:00+0800
- Scope: Phase 2 create-entrypoint convergence and service-owned later-session
  approve/apply.
- Read: host service/evolution, CLI and both TUI adapters, model tool.
- Tests: focused host, CLI and TUI entrypoint suites plus affected typechecks.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: first durable prepared-change vertical slice for safe authored create;
  existing list/review/history/restore and continuation draft dedupe preserved.
- Read: `packages/host/src/skill-evolution.ts`, `packages/host/src/tools.ts`.
- Tests: host Skill evolution/tool focused suites (109 tests); host typecheck.

- Status: Verified
- Date: 2026-07-11T23:20:00+0800
- Scope: closed the model-draft to human-apply handoff: proposal ids are valid
  TUI review targets, draft results expose host-owned human-action eligibility,
  and the fallback instruction prevents model apply-tool searches.
- Read: `packages/host/src/tools.ts`, `packages/host/src/skill-evolution.ts`,
  `packages/tui/src/lib/skill-evolution.ts`,
  `packages/tui/src/state/event-store.ts`, `packages/tui/src/app.tsx`, and
  `packages/tui/src/components/human-action-band.tsx`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts
test/skill-evolution.test.ts`; `npm --workspace @sparkwright/tui test --
test/skill-evolution.test.ts test/event-store-active-phase.test.ts
test/human-action-band-render.test.tsx test/skill-review-dialog-render.test.tsx`;
  PTY `/skill-review skillprop_mrggqcyvwiz9rts2` focused the requested draft.

- Status: Verified
- Date: 2026-07-11T22:17:00+0800
- Scope: session-scoped model draft reuse now spans todo-supervisor run-chain
  episodes; changed create/update bodies revise the same draft id with
  monotonic revision and prior-hash metadata, while equal bodies remain
  no-write idempotent and missing session provenance falls back to run scope.
- Read: `packages/host/src/tools.ts`, `packages/host/src/skill-evolution.ts`,
  `packages/host/test/tools.test.ts`, this map, and `modules/skills.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts
test/skill-evolution.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-07T13:18:00+0800
- Scope: real-mini update_skill authored-body regression: model-authored
  update bodies now share Skill frontmatter normalization with create_skill,
  filling missing `description` while keeping name mismatches fail-closed and
  preserving proposal-only mutation boundaries.
- Read: `packages/host/src/tools.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/project-map/modules/skills.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"update_skill|create_skill|Skill"`; `npm --workspace @sparkwright/host
test -- test/tools.test.ts`; `npm --workspace @sparkwright/host run
typecheck`; `npm run build --workspace @sparkwright/host`; `npm run
check:dist-fresh`; `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini
SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities`.

- Status: Verified
- Date: 2026-07-06T19:48:49+0800
- Scope: C10 removed the TUI prompt-text target detector for automatic
  `/skill-learn` drafts while preserving explicit target support in the proposal
  helper.
- Read: `packages/tui/src/app.tsx`, `packages/tui/src/lib/skill-learn.ts`,
  `packages/tui/test/skill-evolution.test.ts`,
  `docs/reference/SKILLS.md`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/tui test --
test/skill-evolution.test.ts`.

- Status: Verified
- Date: 2026-07-03T12:53:49+0800
- Scope: recorded proposal content-mode metadata, model-facing create/update
  body plumbing including instructions-only create bodies, review digest
  routing for draft proposals and actionable stats findings, proposal state
  transitions preserving draft-time guard/provenance metadata, and advisory
  usage `patchCount` recording on apply/restore/direct project create.
- Read: `packages/host/src/skill-evolution.ts`,
  `packages/host/src/skill-review-digest.ts`,
  `packages/host/src/skill-usage.ts`,
  `packages/host/src/tools.ts`,
  `packages/host/test/skill-evolution.test.ts`,
  `packages/host/test/skill-usage.test.ts`,
  `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"instruction bodies|missing create_skill body description|frontmatter
names"`;
  `npm --workspace @sparkwright/host test --
test/skill-usage.test.ts test/skill-evolution.test.ts -t "skill usage
sidecar|applies update proposals|reverts applied skill history"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "creates,
lists, and validates workspace skills|skill review digest|skill stats|skill
proposals"`; `npm --workspace @sparkwright/cli run build`.
- Prior verification — Date: 2026-06-27T17:35:00+0800
- Scope: updated the lifecycle and actor boundary after model-facing
  `create_skill` moved into the draft proposal pipeline.
- Read: `packages/host/src/tools.ts`, `packages/host/src/skill-evolution.ts`,
  `docs/_internal/project-map/modules/skills.md`,
  `docs/_internal/proposals/skill-runtime-v1-redesign.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-23T18:15:00+0800
- Read: `packages/core/src/path-display.ts`, `packages/host/src/skill-evolution.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/skill-doctor.ts`, `packages/skills/src/guard.ts`,
  `packages/skills/src/preprocess.ts` (`extractInlineShellCommands`),
  `packages/cli/src/cli.ts`, `scripts/regression-real-skill-capabilities.mjs`,
  `scripts/lib/real-model-config.mjs`.
  Update reflects run-scoped `update_skill` duplicate-draft idempotency and
  real Skill regression trace recovery, in addition to the earlier proposal
  guard/provenance contracts.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano npm run regression:real-skill-capabilities`;
  `npm run build`; `npm run check`.
