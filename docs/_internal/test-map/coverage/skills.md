# Skills Coverage

## Current Confidence

- Status: `Verified`
- Last reviewed: 2026-07-17
- Evidence source: 2026-06-23 focused host Skill evolution,
  capability-package mutation, inline-shell, TUI skill review, and
  `@sparkwright/skills` package tests passed. Real `openai/gpt-5.4-nano`
  Skill capability regression partially passed: shell-managed package bypass was
  denied, `update_skill` created one draft proposal without applying it, and
  `create_skill` created a `SKILL.md`; the create prompt still allowed a
  duplicate recovered `create_skill` call.

## Covered

- 2026-07-17 identity consolidation coverage proves runtime loading, indexed
  and resident trace metadata, capability inspection, doctor, lockfiles, stats,
  proposals, history, and restore share required policy-2 package identity.
  Focused tests also prove v1 package helpers are gone, arbitrary included root
  files affect runtime identity, old content/name-only trace rows no longer
  become stats buckets, and proposal records without artifact identity fail.

- 2026-07-12 hardening coverage rejects snapshot targets that are ancestors of
  their source, rejects duplicate registry path ownership, preserves concurrent
  reconciliation updates, imports canonical packages with origin records,
  validates exact Markdown Agent sources under collisions, exercises production
  Agent/Workflow stats commands, and persists suggestion dismiss cooldowns.
  Follow-up coverage verifies one terminal count per Workflow run, durable
  Workflow source layers, pending import-origin recovery, and Windows
  cross-volume snapshot disjointness.

- 2026-07-12 Phase 3B coverage proves new managed proposal/history/receipt
  records use v2 identity, ordinary root files survive proposal apply/history,
  and direct change to an included file marks the proposal stale without target
  overwrite. The later 2026-07-17 consolidation removed missing-policy and
  artifact fallback readers.

- 2026-07-12 Phase 3A package identity v2 substrate coverage proves complete
  canonical ordinary-file enumeration, fixed exclusions, NUL-framed stable
  hashing, same-set snapshotting, policy version attribution, and fail-closed
  file/path/size guardrails. Runtime loading joined that same v2 path in the
  2026-07-17 consolidation.

- 2026-07-12 TUI completion-card coverage proves a draft proposal is restored
  from persistent proposal storage after startup and card dismissal leaves the
  draft recoverable through `/skill-review`. The dedicated compatibility create
  path was removed on 2026-07-17; `/create skill` is now the sole TUI creation
  adapter and refreshes the affordance.

- 2026-07-12 Phase 2 create convergence routed model `create_skill`, CLI
  `skills create`, and the TUI creation adapters through host
  `SkillCommandService`. The TUI compatibility adapter was removed on
  2026-07-17; focused service, host tool, CLI and TUI tests continue to verify
  proposal-first behavior, shared review apply, session dedupe, and absence of
  direct current-Skill writes from ordinary create adapters.

- 2026-07-11 real `openai/gpt-5.6-terra` TUI evidence showed the pre-fix human
  apply handoff was broken: a user follow-up of `应用` entered a model run with
  no apply tool, causing repeated discovery/resource loads and leaving the
  proposal draft. The fix makes `/skill-review <proposal-id>` a valid focused
  TUI route, emits host-owned `humanAction` metadata, and renders a terminal-only
  confirmation band. Focused host/TUI tests passed and a PTY command opened the
  exact original proposal. See
  [../runs/2026-07-11-real-terra-skill-apply-handoff.md](../runs/2026-07-11-real-terra-skill-apply-handoff.md).
- 2026-07-12 P1 containment keeps proposal audit events but folds their default
  TUI rows into the terminal proposal result, and bounds repeated reference
  observations with loader-scoped, version-aware `already_loaded` results.
  Focused Skills and TUI render tests cover canonical-path repeats, no-content
  repeat results, unrelated mutation visibility, and proposal mutation counts.

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
- 2026-07-07 real `anthropic/claude-sonnet-4-6`
  `regression:real-skill-capabilities` passed: disabled-shell capability
  inspection preserved managed Skill tools, bash managed-package bypass was
  blocked, real `create_skill` drafted one proposal with no direct workspace
  writes, and real `update_skill` drafted one proposal after `list_skills`
  without applying it. See
  [../runs/2026-07-07-real-sonnet-skill-agent-qa.md](../runs/2026-07-07-real-sonnet-skill-agent-qa.md).
- 2026-07-07 real Sonnet legacy project Skill loading passed in a combined
  Skill + `spawn_agent` fixture: `tool_search` loaded `skill_load` /
  `spawn_agent`, `skill_load` loaded the Skill body and reference file, the
  child agent confirmed `LEGACY_SKILL_AGENT_SENTINEL`, and trace
  report/verify/session check all passed.
- 2026-07-07 post-fix Sonnet canary confirmed the deferred `task` wrapper can
  be loaded after `tool_search` without Anthropic schema rejection. Full
  combined Skill + background-agent-task prompts should remain in rotation, but
  the prior provider-schema blocker is fixed.
- 2026-07-07 real `openai/gpt-5.4-mini` broad QA reran
  `regression:real-skill-capabilities`. The first run found that
  `update_skill` failed when mini authored a full `SKILL.md` body whose
  frontmatter had `name` but omitted `description`; post-fix, update_skill
  fills the missing frontmatter description from the tool description, created
  one draft proposal, emitted capability mutation events, left the source Skill
  unchanged, and passed trace report/verify/session check. See
  [../runs/2026-07-07-real-mini-broad-trace-qa.md](../runs/2026-07-07-real-mini-broad-trace-qa.md)
  and
  [../failures/real-skill-update-frontmatter-description.md](../failures/real-skill-update-frontmatter-description.md).
- 2026-07-07 real `openai/gpt-5.4-mini` Agent + Skill multidirection QA loaded
  project Skills before dynamic `spawn_agent`, configured
  `delegate_agent(agentId)`, and awaited background-agent task routes. Body
  loads emitted `skill.loaded`; reference loads returned `status:"resource"`.
  Mini can still guess a shortened reference path such as `task.md`, but the
  `skill_load` failure listed the available `references/task.md` path and the
  model recovered. See
  [../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md](../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md).

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
- Combined Skill + background-agent task canaries using Anthropic are no longer
  blocked by the deferred `task` schema. They remain prompt-sensitive and
  should assert Skill load evidence, concrete task ids/results, and clean
  trace/session checks rather than exact final prose.
- Authored Skill body normalization now fills missing `description` for both
  `create_skill` and `update_skill`; frontmatter `name` mismatches should remain
  fail-closed and covered by focused tests rather than real-model route
  assertions.
- Skill reference resource assertions should use the exact path surfaced in
  `<skill_files>` / `resourceFiles`. A recovered wrong-path `skill_load`
  failure is prompt/model variance when the later exact resource load succeeds.

## Focused Route

```bash
npm --workspace @sparkwright/host test -- test/skill-evolution.test.ts test/capability-package-mutation.test.ts test/skill-inline-shell.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts test/skill-suggestions.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "skill stats|skill review digest|catalog|doctors skills"
npm --workspace @sparkwright/tui test -- test/skill-review-dialog-render.test.tsx test/path-display.test.ts
npm --workspace @sparkwright/skills test
npm --workspace @sparkwright/skills run typecheck
npm --workspace @sparkwright/skills run build
npm run check:package-boundaries
npm run check:internal-imports
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
- [../failures/anthropic-deferred-task-schema-oneof.md](../failures/anthropic-deferred-task-schema-oneof.md)
- [../failures/real-skill-update-frontmatter-description.md](../failures/real-skill-update-frontmatter-description.md)
