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
- `packages/skills/src/manifest.ts`
- `packages/host/src/skill-report.ts`
- `packages/host/src/skill-evolution.ts`
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
- Host defaults to on-demand loading via `skill_load` unless config opts into selected skill residency.
- Skill index and resident Skill context must keep host absolute source paths
  out of model-visible content/source labels; diagnostics retain provenance in
  metadata and trace events.
- Inline shell preprocessing is opt-in. `@sparkwright/skills` only exposes the
  `preprocess.inlineShellRunner` injection point; host owns execution,
  sandboxing, and trace events. Failed inline shell expansion should insert a
  short marker into Skill content rather than raw stderr; host trace summaries
  carry the bounded diagnostic output.
- Project skills live under `.sparkwright/skills/` by default.
- Evolution is actor-split: the model only _proposes_ (`update_skill`/`create_skill`); apply, reject, supersede, prune, and restore are human-only CLI/TUI surfaces, never model tools. Applied changes snapshot to history; `skills restore --to before` is the revert edge. See [../maps/capabilities/skill-evolution.md](../maps/capabilities/skill-evolution.md).

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

- Skill self-evolution machinery is solid: immutable snapshots, hash/doctor-gated apply, `update_skill --body` for authored content, `guard.inspectSkill` at draft+apply, and history with `restore --to before` revert. Proposals drafted during a run record run/session provenance (reverse-lookup via `proposals list --run/--session`); failed drafts self-clean. Remaining gap: `create_skill` still writes directly (now guard-gated, but not via the proposal/history flow). See [../maps/capabilities/skill-evolution.md](../maps/capabilities/skill-evolution.md#known-debts).

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/skills/src/index.ts`, `packages/skills/src/preprocess.ts`, `packages/skills/src/guard.ts`, `packages/host/src/runtime.ts`, `packages/host/src/skill-inline-shell.ts`, `packages/host/src/skill-evolution.ts`, `packages/host/src/traced-process-runner.ts`, `docs/reference/SKILLS.md`, `docs/reference/TRACE_EXTENSION_EVENTS.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/index.test.ts`; `npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts`.
