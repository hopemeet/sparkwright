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
- `packages/host/src/tools.ts` (`create_skill`, `update_skill` model tools)
- `packages/skills/src/index.ts` (package hashing, `applyEdit`/`content` seams)
- `packages/skills/src/guard.ts` (`inspectSkill` trust × severity; wired at draft + apply + `create_skill`)
- `packages/host/src/skill-doctor.ts` (`runSkillDoctor` structural validation)
- `packages/cli/src/cli.ts` (`skills proposals|history|restore`)
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

## Lifecycle

```txt
ORIGIN                          GATE (human only)            EFFECT
 model: update_skill            CLI/TUI:                     mutate .sparkwright/skills
   (draft, optional body) ────► apply [--force] / reject /   + history snapshot (before+after)
 model: create_skill (write) │  supersede / prune /          + guard re-inspect (force on danger)
 human: TUI /skill-learn     └► restore (--to before|after)  + runSkillDoctor re-validate

draft inspected by guard.inspectSkill (agent-created) -> metadata.guardFindings
draft during a run records metadata.provenance { runId, sessionId, rationale }
proposal states: draft -> applied | rejected | superseded | stale | failed
history kinds:   create | update | restore
```

## Contracts

- **Actor boundary:** the model can only _propose_. `update_skill` drafts a
  proposal; `create_skill` writes a SKILL.md under approval (and now runs the
  guard, refusing dangerous content without `force`). `applySkillProposal`,
  reject, supersede, prune, and restore are **never exposed as model tools** —
  they run from CLI/TUI only.
- **Failed drafts self-clean:** `createSkillCreateProposal` /
  `createSkillUpdateProposal` wrap their package writes; if a post-snapshot step
  throws (unparseable body, name mismatch, guard parse), the partial proposal
  directory is removed via `rollbackPartialProposal`.
- **Proposal content:** `createSkillUpdateProposal` accepts an `applyEdit`
  transform and `createSkillCreateProposal` accepts `content`. The `update_skill`
  tool exposes a `body` param (full revised SKILL.md) that is plumbed into
  `applyEdit`; when omitted the after body is a `## Proposed Evolution` stub
  derived from `description`.
- **Guard at draft + apply:** proposed content is inspected by
  `guard.inspectSkill` as `agent-created` (ignoring any trust the body
  self-declares). Draft records findings in `metadata.guardFindings`; apply
  re-inspects and refuses when a `dangerous` finding is present unless
  `force` is set. Doctor (structural) and guard (trust/secret-exfil) are
  distinct checks and both run. Guard also flags executable inline shell:
  `inline_shell_present` (caution) plus `inline_shell_mutation` /
  `inline_shell_network` (dangerous), sharing `extractInlineShellCommands`
  with the executor so detection cannot drift from what actually runs.
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
- **Provenance:** when a proposal is drafted by `update_skill` during a run, the
  host captures `provenance: { runId, sessionId, rationale }` into proposal
  metadata so a reviewer can pull the motivating trace. `runMetadata.sessionId`
  (set in host `startRun`) is the source for the session id; TUI `/skill-learn`
  also passes the active session as provenance. Reverse-lookup: `skills proposals
list --run <id>` / `--session <id>` filters by provenance (`--session` is the
  global flag, read from `parsed.sessionId`). CLI-authored proposals have none.
- **Mutations are trace-visible:** every atomic write emits
  `capability.mutation.completed`; proposals/history themselves are file
  artifacts, not a separate trace event family.
- **Display vs execution paths:** proposal metadata keeps absolute
  `targetPath`/`sourcePath` for apply/restore, while generated `proposal.md`
  renders Source/Target through the shared display-path projection so CLI/TUI
  review text does not leak host absolute paths.

## Consumers

- CLI `skills proposals`, `skills history`, `skills restore`.
- TUI `/skill-create`, `/skill-update`, `/skill-review`, `/skill-learn`.
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

- **`create_skill` still writes directly** (not via the proposal pipeline), but
  it now runs `inspectProposedSkillContent` before writing and refuses a
  `dangerous` finding unless `force=true` — so it no longer bypasses the _guard_,
  only the proposal/history flow. A full reroute to a draft proposal was
  deliberately not done (it would drop create's immediate-write, idempotent-skip,
  and `force`-overwrite behavior).
- **Provenance reverse-lookup is filter-based:** `skills proposals list --run
<id>` / `--session <id>` filters the proposal store by `metadata.provenance`;
  there is no persisted run→proposals index (a scan, not an index).

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/core/src/path-display.ts`, `packages/host/src/skill-evolution.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/skill-doctor.ts`, `packages/skills/src/guard.ts`,
  `packages/skills/src/preprocess.ts` (`extractInlineShellCommands`),
  `packages/cli/src/cli.ts`, `packages/tui/src/lib/skill-learn.ts`,
  `packages/tui/src/app.tsx`, `packages/tui/src/components/skill-review-dialog.tsx`.
  Update reflects display-path projection for proposal markdown and TUI review
  metadata, in addition to the earlier inline-shell guard rules
  (`inline_shell_present` / `inline_shell_mutation` / `inline_shell_network`),
  partial-proposal cleanup, `create_skill` guard gate, and provenance
  reverse-lookup.
- Tests: `npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/path-display.test.ts test/capabilities-panel-render.test.tsx test/skill-review-dialog-render.test.tsx`.
