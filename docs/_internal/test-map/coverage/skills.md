# Skills Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-06-28
- Evidence source: 2026-06-23 focused host Skill evolution,
  capability-package mutation, inline-shell, TUI skill review, and
  `@sparkwright/skills` package tests passed. Real `openai/gpt-5.4-nano`
  Skill capability regression partially passed: shell-managed package bypass was
  denied, `update_skill` created one draft proposal without applying it, and
  `create_skill` created a `SKILL.md`; the create prompt still allowed a
  duplicate recovered `create_skill` call.

## Covered

- Skill loading/indexing package behavior.
- Skill evolution proposal snapshots and guard/doctor gates in focused tests.
- Shell cannot mutate managed skill packages directly.
- TUI skill review renders proposal metadata through display-path projection.
- Real model can use `create_skill` without shell and create a project
  `SKILL.md` in a temporary fixture.
- 2026-06-28 real `openai/gpt-5.4-mini` rerun showed the current
  `create_skill` surface is proposal-first: it completed with
  `action:"draft"`, wrote proposal files under
  `.sparkwright/skill-evolution/proposals/**`, and emitted
  `capability.mutation.completed` events. The existing real regression script
  is stale because it still expects a direct `.sparkwright/skills/<name>/SKILL.md`
  write and one `workspace.write.completed`.
- 2026-06-28 fix verification updated `regression:real-skill-capabilities` to
  assert proposal-first Skill creation. The real mini rerun passed with one
  proposal containing `SKILL.md`, six capability mutation events, and zero
  direct workspace writes.
- 2026-06-28 realistic real `openai/gpt-5.4-mini` Skill workflow with full
  default tools, `--write --yes-all --access-mode bypass`, explicit
  `skill_load`, file reads, and `update_skill` passed. The draft proposal kept
  provenance, history stayed empty, the source Skill hash matched the before
  snapshot, and `skills stats --skill repo-sentinel` used the projection
  cache/catalog while reporting `indexed=1`, `explicitLoad=1`, zero load
  failures, and `SKILL_EVOLUTION_ACTIVITY` for the proposal's run/session.
- 2026-07-03 current-source real `openai/gpt-5.4-mini`
  `regression:real-skill-capabilities` passed after Skill usage/evolution
  changes: static disabled-shell capability inspection kept
  `list_skills`/`create_skill`/`update_skill`, the scripted bash managed-package
  guard blocked direct `.sparkwright/skills` mutation, real create drafted one
  proposal with `SKILL.md`, and real update drafted one proposal while leaving
  the source Skill hash unchanged. See
  [../runs/2026-07-03-real-mini-background-skill-agent-qa.md](../runs/2026-07-03-real-mini-background-skill-agent-qa.md).
- 2026-07-03 follow-up fixed a real-regression harness mismatch: the update
  case asserted `list_skills` but the prompt only said to use it "as needed".
  The prompt now explicitly requires `list_skills` once before `update_skill`;
  the real mini rerun passed with tools `tool_search,list_skills,update_skill`.
  See
  [../failures/real-skill-regression-list-skills-prompt.md](../failures/real-skill-regression-list-skills-prompt.md).

## Weak Or Untested

- Real models can repeat a successful `create_skill` call. Runtime guardrails
  recover with `REPEATED_TOOL_CALL_SKIPPED`, but the real regression script
  currently treats any `tool.failed` event as a failed create case even when
  the final outcome is recovered and non-failing.
- Real `update_skill` proposal drafting remains prompt/model-sensitive, but
  the strengthened 2026-06-23 prompt verified the intended one-proposal path.
- The real Skill create regression needs updating to assert proposal creation
  rather than direct package application.
- Real Skill proposal canaries remain prompt/model-sensitive; exact extra reads
  and final prose are not invariants. Assert managed mutation events, proposal
  state, unchanged applied package for update proposals, and absence of shell
  bypass/direct workspace writes.
- Real regression script prompts must be at least as strict as their assertions
  when checking exact tool calls; otherwise healthy real runs can fail because
  "as needed" allowed the model to skip a mandatory harness tool.

## Focused Route

```bash
npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts test/capability-package-mutation.test.ts test/skill-inline-shell.test.ts
npm --workspace @sparkwright/tui test -- test/skill-review-dialog-render.test.tsx test/path-display.test.ts
npm --workspace @sparkwright/skills test
```

Use the real regression script as an opt-in canary:

```bash
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano npm run regression:real-skill-capabilities
```

The stale canary issue was fixed on 2026-06-28; see
[../runs/2026-06-28-access-mode-fix-verification.md](../runs/2026-06-28-access-mode-fix-verification.md).

## Scenario Links

- Add a dedicated real Skill capability scenario if this area becomes a
  recurring release gate.

## Sensitivity Links

- [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)
- [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)

## Stale Triggers

- `packages/host/src/skill-evolution.ts`
- `packages/host/src/tools.ts`
- `packages/skills/src/*`
- `packages/cli/src/cli.ts` Skill proposal/history commands
- Skill tool descriptions or deferred-tool routing changes

## Failure Links

- [../failures/prompt-induced-tool-loop.md](../failures/prompt-induced-tool-loop.md)
- [../failures/real-skill-regression-list-skills-prompt.md](../failures/real-skill-regression-list-skills-prompt.md)
