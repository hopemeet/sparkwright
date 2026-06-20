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
```

## Contracts

- Default host behavior exposes loader tool and does not auto-reside all selected skills.
- Project skill root defaults to `.sparkwright/skills`.
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
  double-count recovered companion failures.
- Skill index and resident Skill context must not expose host absolute
  `sourcePath`/`contentHash` values to provider prompts. Keep source provenance
  in metadata and trace events.
- Capability snapshots and CLI `capabilities inspect` expose a path-free
  `skills.inlineShell` policy summary (`enabled`, `writePolicy`,
  `sandboxMode`, `failClosed`, timeout/output caps).
- Skill create/update tools are managed capability mutations, not raw shell
  writes; successful managed mutations emit `capability.mutation.completed`.

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
- Date: 2026-06-20
- Read: `packages/skills/src/index.ts`, `packages/skills/src/preprocess.ts`, `packages/skills/src/guard.ts`, `packages/host/src/runtime.ts`, `packages/host/src/skill-inline-shell.ts`, `packages/host/src/traced-process-runner.ts`, `packages/host/src/skill-stats.ts`, `packages/core/src/context.ts`, `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/cli/src/run-outcome.ts`, `packages/protocol/src/index.ts`, `schemas/host-message.schema.json`, `docs/reference/SKILLS.md`, `docs/reference/TRACE_EXTENSION_EVENTS.md`, `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/skills test -- test/index.test.ts`; `npm --workspace @sparkwright/core test -- test/context.test.ts`; `npm --workspace @sparkwright/core test -- test/trace.test.ts test/run.test.ts`.
