# Skill Evolution

## Purpose

Skill evolution is the governed change pipeline for project skills: the model
_proposes_ a create/update, a human _applies_ it, and every applied change is
snapshotted to history so it can be inspected and reverted. It is deliberately
separate from skill loading ([skills.md](skills.md)): loading reads skills into
a run; evolution mutates the skills themselves.

See [../../modules/skills.md](../../modules/skills.md).

## Main Files

- `packages/host/src/skill-evolution.ts` (proposal/history/restore lifecycle)
- `packages/host/src/skill-command-service.ts` (ordinary create/approve/apply command boundary)
- `packages/host/src/skill-review-digest.ts` (`skills review` host digest)
- `packages/host/src/skill-usage.ts` (advisory patch observations)
- `packages/host/src/tools.ts` (`create_skill`, `update_skill` model tools)
- `packages/skills/src/index.ts` (package hashing, `applyEdit`/`content` seams)
- `packages/skills/src/guard.ts` (`inspectSkill` trust × severity; wired at draft + apply)
- `packages/host/src/skill-doctor.ts` (`runSkillDoctor` structural validation)
- `packages/cli/src/cli.ts` (`skills proposals|history|restore`)
- `packages/tui/src/app.tsx` (`/skill-learn` automatic notice/draft/apply trigger)
- `packages/tui/src/lib/skill-evolution.ts`, `packages/tui/src/lib/skill-learn.ts`
- `packages/host/test/skill-evolution.test.ts`, `packages/cli/test/cli.test.ts`

## Storage Layout

```txt
.sparkwright/skill-evolution/
  proposals/<proposal-id>/
    before/<skill>/...   after/<skill>/...   patch.diff   metadata.json   proposal.md
  history/<skill>/<version-id>/
    before/<skill>/...   after/<skill>/...   patch.diff   metadata.json
```

Both `before/` and `after/` are full immutable skill-package snapshots with
`sha256` package hashes in metadata.

Managed proposals, revisions, apply/recovery, history, restore, and mutation
receipts use package identity v2 and require
`packageHashPolicyVersion: 2`. Proposal and history readers reject missing or
non-v2 policies. Proposal `artifactId`, `effectHash`, `preparedState`, and
`revision` are required; history records carry the same artifact id. Project
updates reuse an active registry id or prior canonical history id, otherwise
allocate one new id. Evolution hashing has no v1 or artifact fallback path.

## Lifecycle

```txt
ORIGIN                          GATE (human only)            EFFECT
 model: create_skill            CLI/TUI:                     mutate .sparkwright/skills
 model: update_skill          ─► apply [--force] / reject /   + history snapshot (before+after)
   (draft, optional body)      │  supersede / prune /         + guard re-inspect (force on danger)
 human: TUI /create skill     └► restore (--to before|after) + runSkillDoctor re-validate
 human: TUI /skill-learn

draft inspected by guard.inspectSkill (agent-created) -> metadata.guardFindings
draft during a run records metadata.provenance { runId, sessionId, rationale }
proposal states: draft -> applied | rejected | superseded | stale | failed
history kinds:   create | update | restore
```

## Contracts

- **Create entrypoint convergence:** model `create_skill`, CLI `skills create`,
  and TUI `/create skill` all call `SkillCommandService.prepareCreate`.
  CLI/TUI review apply calls
  `approveAndApply`; the in-run model fast path uses `prepareApproval` plus
  `approvePrepared` after the run approval resolves. Advanced proposal-create
  commands remain low-level authoring surfaces, not a fifth ordinary UX.

- **Configured roots are override sources, not mutation targets:** a Skill
  selected from `capabilities.skills.roots` has layer `configured`, is strongest
  during loading, and produces a project fork/shadow proposal during evolution.
  Doctor reports that current boundary with configured-root findings; no
  `legacy` layer or diagnostic code remains.

- **TUI persistent inbox:** proposal files remain the source of truth. TUI
  reads the newest draft after startup and after either creation surface, then
  presents a dismissible completion card linked to `/skill-review`; dismissing
  the card never closes or mutates the draft.
- **Draft reconciliation and competing proposals:** successful apply closes all
  other draft proposals for the same project target as `superseded`, linked by
  `supersededBy`. Before TUI inbox/review recovery and ordinary create
  preparation, host reconciliation repairs durable drafts: a create whose
  current target matches managed applied history becomes `superseded`; an
  externally occupied create target or an update whose base disappeared or
  drifted becomes `stale`. Listing proposals remains read-only. Apply-time hash
  and base checks remain the safety gate; reconciliation controls whether a
  draft is presented as actionable. Secondary cleanup failure never rolls back
  an already successful apply and is retried by the next reconciliation pass.

- **Prepared create fast path:** a complete clean authored model create is
  persisted as `ready`/`waiting` with `artifactId` and `effectHash` before the
  run asks for `skill.apply`. Approval binds proposal id + revision + effect
  hash, persists `approval.json`, applies in the same tool episode, and writes
  `mutation-receipt.json` plus deterministic effect-keyed history. No resolver
  or a denial leaves the proposal waiting for later review.
- **Effect authorization:** the hash covers artifact kind/id, operation,
  project target, base/after package hashes, origin digest, and capability
  requirements; guard policy version/message text is excluded. Revision
  recomputes the effect hash and makes an old receipt unusable. Apply reruns the
  guard; dangerous fingerprints not present in the receipt return the proposal
  to waiting.
- **Crash reconciliation:** an approved/applying proposal whose target already
  equals the after-package hash completes doctor, deterministic history,
  mutation receipt, and applied state instead of becoming stale or duplicating
  history.

- **Actor boundary:** model-facing `create_skill` and `update_skill` draft
  proposals. `applySkillProposal`, reject, supersede, prune, and restore are
  **never exposed as model tools** — they run from CLI/TUI only. CLI
  `sparkwright skills create` now prepares through the same proposal service;
  it is no longer a direct-write exception.
- **Human-action handoff:** model-facing draft results carry one canonical
  `/skill-review <proposal-id>` command plus a host-computed `humanAction`
  projection (eligibility, validation, content mode, guard severity, and
  recommended action). TUI consumes that projection only after the run settles;
  it never recomputes risk and apply still runs through the human-only
  hash/guard/doctor/history gate. The model fallback explicitly directs later
  apply requests to the review command instead of searching for an apply tool.
- **Failed drafts self-clean:** `createSkillCreateProposal` /
  `createSkillUpdateProposal` wrap their package writes; if a post-snapshot step
  throws (unparseable body, name mismatch, guard parse), the partial proposal
  directory is removed via `rollbackPartialProposal`.
- **Proposal content:** `createSkillUpdateProposal` accepts an `applyEdit`
  transform and `createSkillCreateProposal` accepts `content`. The
  model-facing `create_skill` and `update_skill` tools both expose a `body`
  param. `create_skill.body` may be full `SKILL.md` content or only authored
  instructions; the host wraps instructions-only bodies with `name` and
  `description`. For both `create_skill.body` and `update_skill.body`, a full
  `SKILL.md` body with frontmatter missing `description` is normalized from the
  tool `description`, while mismatched frontmatter names still fail closed. When
  `create_skill.body` is omitted, the create proposal uses a generated template;
  when `update_skill.body` is omitted, the after body is a
  `## Proposed Evolution` intent stub derived from `description`. Proposal
  metadata records `contentMode: "authored" | "template" | "intent_stub"` so
  CLI/TUI review surfaces can label low-quality drafts.
- **Guard at draft + apply:** proposed content is inspected by
  `guard.inspectSkill` as `agent-created` (ignoring any trust the body
  self-declares). Draft records findings in `metadata.guardFindings`; apply
  re-inspects and refuses when a `dangerous` finding is present unless
  `force` is set. Doctor (structural) and guard (trust/secret-exfil) are
  distinct checks and both run. Guard also flags executable inline shell:
  `inline_shell_present` (caution) plus `inline_shell_mutation` /
  `inline_shell_network` (dangerous), sharing `extractInlineShellCommands`
  with the executor so detection cannot drift from what actually runs.
- **State transitions preserve review metadata:** applying, rejecting,
  superseding, or marking stale/failed rewrites `metadata.json` but must carry
  existing `guardFindings` and `provenance` forward so proposal filters and
  review displays keep their draft-time evidence.
- **Apply is hash-gated and doctor-gated:** apply recomputes the after-package
  hash and marks the proposal `stale` if it drifted; after writing it runs
  `runSkillDoctor` and rolls back + marks `failed` on `blocked`.
- **History captures both sides:** each applied proposal writes a history entry
  holding the `before` and `after` packages plus the patch.
- **Restore direction:** `restoreSkillFromHistory` takes `side: "before" |
"after"` (default `after`). `after` re-applies the package a version produced;
  `before` is the revert/undo edge, restoring the package prior to that version.
  Restore defaults to dry-run; `apply: true` commits and writes a `restore`
  history entry. Restoring `before` of a version that created the skill from
  nothing is refused (no prior package).
- **Provenance:** when a proposal is drafted by `create_skill` or `update_skill`
  during a run, the host captures `provenance: { runId, sessionId, rationale }`
  into proposal metadata so a reviewer can pull the motivating trace.
  `runMetadata.sessionId` (set in host `startRun`) is the source for the
  session id; TUI `/skill-learn` also passes the active session as provenance.
  Reverse-lookup: `skills proposals list --run <id>` / `--session <id>` filters
  by provenance (`--session` is the global flag, read from `parsed.sessionId`).
  CLI-authored proposals have none.
- **TUI automatic learning target:** `/skill-learn` notice/draft/apply uses
  only conservative reuse-signal evidence plus the active session id. It does
  not infer a target Skill name from prompt text; named Skill updates are
  explicit `/skill-update` or caller-supplied `targetSkillName` paths.
- **Session-scoped draft idempotency and revision:** model-authored
  `create_skill` / `update_skill` calls reuse a draft for the same session,
  proposal kind, and skill target across todo-supervisor continuation runs;
  callers without session provenance fall back to run-scoped matching. Equal
  content returns the existing proposal unchanged, while changed content
  revises the same proposal id, increments its `revision`, records the replaced
  package hash, and refreshes the after package, patch, guard findings, and
  review metadata. Closed proposals are never revised. Human CLI-authored
  proposals have no run/session provenance and remain separate drafts.
- **Mutations are trace-visible:** every atomic write emits
  `capability.mutation.completed`; proposals/history themselves are file
  artifacts, not a separate trace event family. Draft proposal writes are
  capability mutations too, but they are not current Skill package changes until
  a human apply path runs. Successful apply/restore and direct project
  `skills create` also record advisory `patchCount` observations in
  `.sparkwright/skill-usage.json`; this sidecar is not part of the immutable
  proposal/history record.
- **Display vs execution paths:** proposal metadata keeps absolute
  `targetPath`/`sourcePath` for apply/restore, while generated `proposal.md`
  renders Source/Target through the shared display-path projection so CLI/TUI
  review text does not leak host absolute paths.
- **Review digest:** `skills review` calls the host `collectSkillReviewDigest`
  helper and combines draft proposals (with content-mode labels) plus actionable
  stats findings (`SKILL_LOAD_FAILURES`, `ASSOCIATED_TOOL_FAILURES`) into one
  human queue. It uses trace-based stats and proposal metadata; it does not
  depend on the usage sidecar.

## Consumers

- CLI `skills review`, `skills proposals`, `skills history`, `skills restore`.
- TUI `/create skill`, `/skill-update`, `/skill-review`, `/skill-learn`.
- Capability inspection (skill roots/errors), not the proposal store.

## Change Checklist

- Keep apply/revert/reject off the model toolset; they are human gates.
- Preserve immutable before/after snapshots and package-hash gating on apply.
- If restore direction or history shape changes, update CLI flags, the result
  type, and both host and CLI tests.
- Inspect agent-authored content as `agent-created`; do not let a skill body's
  self-declared trust weaken the guard.
- Keep doctor (structural) and guard (trust/secret-exfil/inline-shell) as
  distinct apply gates; surface guard findings on `proposals show` and apply
  output.
- If inline-shell guard detection changes, keep `extractInlineShellCommands`
  the single source shared between `guard.ts` and the preprocessor.

## Known Debts

- **Provenance reverse-lookup is filter-based:** `skills proposals list --run
<id>` / `--session <id>` filters the proposal store by `metadata.provenance`;
  there is no persisted run→proposals index (a scan, not an index).

## Last Verified

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
