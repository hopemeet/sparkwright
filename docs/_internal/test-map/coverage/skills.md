# Skills Coverage

## Current Confidence

- Status: `Verified`
- Last reviewed: 2026-08-02
- Evidence: focused Skills/Host/CLI/TUI/Core coverage plus repository test
  typecheck and generated schema checks passed during removal of the retired
  self-evolution surface.

## Covered

- Layered discovery precedence and strict canonical manifest parsing.
- Required package identity v2 across loading, trace metadata, reports, doctor,
  lockfiles, Stats, and TUI joins.
- On-demand body/resource loading, structured failures, retry behavior, and
  loader-scoped successful-load deduplication.
- Opt-in host-owned inline shell preprocessing with no-write, fail-closed
  sandbox behavior.
- Deterministic project creation validates before publishing, accepts only the
  project root, never overwrites, and creates no evolution state.
- Model tool inventory retains `list_skills` and excludes `create_skill` and
  `update_skill`.
- CLI exposes `skills list|create|validate|stats|doctor`; removed subcommands no
  longer parse or appear in help.
- TUI `/skills` joins only the current exact package identity and has no draft
  state. `/create skill` shares deterministic creation. Proposal/review/learn
  commands, UI layers, and human-action state are absent.
- Stats reads session and child-agent traces, reports structured load and
  associated run/tool evidence, and does not claim causality.
- Session projections and the targeted catalog remain rebuildable caches for
  repeated/overlapping bounded windows. Sessions outside the current `--last`
  selection do not contribute. Schema/algorithm/fingerprint mismatch triggers
  recomputation.
- Pre-existing `.sparkwright/skill-evolution` data is ignored and preserved by
  project creation and Stats.
- Config rejects the removed `capabilities.skills.evolution` field; generated
  schemas omit it.
- Shell mutation auditing still protects controlled capability paths, with
  guidance pointing to controlled workspace writes or CLI commands.

Historical real-model and TUI evolution evidence remains in dated
[`runs/`](../runs/) and [`failures/`](../failures/) notes, but those runs do not
describe the current product surface.

## Weak Or Untested

- Long-horizon Stats retention/compaction policy beyond rebuildable session
  projections is not yet implemented.
- Concurrent duplicate CLI/TUI creation is covered at the exclusive-directory
  boundary, but has not been stress-tested across many processes.
- Editing an existing Skill is deliberately delegated to ordinary workspace
  write and source-control workflows; SparkWright no longer tests its own
  proposal/history/rollback semantics.

## Focused Route

```bash
npm --workspace @sparkwright/skills test
npm --workspace @sparkwright/skills run typecheck
npm --workspace @sparkwright/host test -- test/project-skill-create.test.ts test/config.test.ts test/skill-usage.test.ts test/tools.test.ts test/protocol.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts test/run-outcome.test.ts -t "init --project|workspace skills|skill stats|skill stats catalog|CLI run outcome"
npm --workspace @sparkwright/tui test -- test/create-capability.test.ts test/event-store-active-phase.test.ts test/skills-browser.test.ts test/skills-panel-render.test.tsx test/capabilities-panel-render.test.tsx test/event-stream-render.test.ts test/format-event.test.ts test/tool-request-preview.test.ts
npm run typecheck:test
npm run schema:check
npm run check:package-boundaries
npm run check:internal-imports
```

The compatibility-named regression is deterministic and no longer needs a real
model:

```bash
npm run regression:real-skill-capabilities
```

## Scenario Links

- Add a real Skill loading/resource scenario if provider-sensitive loading
  becomes a recurring release risk.

## Sensitivity Links

- [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)
- [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)

## Stale Triggers

- `packages/skills/src/*`
- `packages/host/src/project-skill-create.ts`
- `packages/host/src/skill-stats.ts`
- `packages/host/src/tools.ts`
- `packages/cli/src/cli.ts` Skill commands
- `packages/tui/src/lib/create-capability.ts`
- `packages/tui/src/lib/skills-browser.ts`
- Skill config/schema, tool descriptions, or deferred loading changes

## Failure Links

- [../failures/prompt-induced-tool-loop.md](../failures/prompt-induced-tool-loop.md)
- [../failures/anthropic-deferred-task-schema-oneof.md](../failures/anthropic-deferred-task-schema-oneof.md)
