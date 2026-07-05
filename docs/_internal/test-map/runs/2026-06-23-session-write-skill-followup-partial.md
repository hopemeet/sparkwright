# 2026-06-23 Session Write Skill Follow-Up Partial

## Summary

- Scenario: Follow-up QA for session resume/compaction, write approvals, TUI
  approval denial, real Skill capability regression, config/schema, and cron.
- Coverage: session compaction/resume, workspace write approvals, TUI approval
  UX, Skill create/update/evolution, config/schema/XDG isolation, and cron
  state/run behavior.
- Result: `partial`
- Reusable lesson: Session/write/TUI paths were healthy; real Skill update
  proposal drafting can loop through many successful proposal mutations without
  reaching a final answer, so real Skill canaries need trace recovery and a
  tighter stop condition.

## Test Setup

- Task direction: Continue testing weak areas after the first broad QA pass.
- Prompt shape: `strong` for real CLI/TUI/session canaries; `scripted` for
  deterministic direct-core write approvals; real Skill regression used its
  built-in prompts.
- Prompt: Session prompts preserved `SESSION_QA_SENTINEL`; write prompts
  covered denied and approved writes; TUI prompt forced a denied `write_file`;
  Skill prompts covered `create_skill` and `update_skill`.
- Model class: deterministic direct-core plus real provider/model
  `openai/gpt-5.4-nano`.
- Capabilities: session resume/compact, read/write file tools, TUI approvals,
  Skill tools, shell disabled in Skill fixtures.
- Permission/approval posture: write tests used temporary workspaces; TUI
  denial used manual `n`; deterministic approval used denied stdin and `--yes`;
  real Skill regression used `--write --yes`.
- Workspace/config isolation: all write and Skill tests used `/tmp` or macOS
  temp roots; repo checkout remained clean.
- Trace level: `debug` for real/session/TUI canaries.
- Environment notes: `perl` path extraction failed once due local `C.UTF-8`
  locale support; reruns used explicit known trace/session paths.

## Commands Or Harness

```bash
npm --workspace @sparkwright/core test -- test/session-compact.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "compact|session"
node packages/cli/dist/index.js run "<session sentinel prompt>" --workspace "$tmp" --model openai/gpt-5.4-nano --trace-level debug
node packages/cli/dist/index.js session resume "$session" "<resume prompt>" --workspace "$tmp" --model openai/gpt-5.4-nano --trace-level debug
node packages/cli/dist/index.js session compact "$session" --workspace "$tmp" --format text
node packages/cli/dist/index.js session inspect "$session" --workspace "$tmp" --compaction --format text
SPARKWRIGHT_ENABLE_DIRECT_CORE=1 node packages/cli/dist/index.js run --direct-core "deny temp write" --workspace "$tmp" --target README.md --write --model deterministic --trace-level debug
SPARKWRIGHT_ENABLE_DIRECT_CORE=1 node packages/cli/dist/index.js run --direct-core "approve temp write" --workspace "$tmp" --target README.md --write --yes --model deterministic --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py ...
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
npm --workspace @sparkwright/host test -- test/config.test.ts
npm run schema:check
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t cron
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t config
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "cron|durable"
node packages/cli/dist/index.js cron create --root-dir "$root" --job-workspace "$workspace" --schedule "every 1h" --prompt "read README.md" --name qa
node packages/cli/dist/index.js cron run qa --root-dir "$root" --workspace "$workspace" --model openai/gpt-5.4-nano
npm run release:check
```

## Stable Evidence

- Session resume before compaction returned `resume-ok SESSION_QA_SENTINEL`.
- `session compact` wrote
  `/tmp/sparkwright-session-qa.xbiHdu/.sparkwright/sessions/session_mqq0a3giofpmwdkd/compact.json`
  with 2 compacted runs, `freedChars=9377`, and inspect consistency `ok`.
- Post-compact prompt evidence contained the compact summary and
  `SESSION_QA_SENTINEL`; model output varied, but trace verify and session check
  stayed `ok`.
- Direct-core write denial had 1 denied managed write, no file mutation, and
  trace verify `ok`.
- Direct-core write approval applied 1 managed write to `README.md` and trace
  verify was `ok`.
- TUI approval denial rendered the diff, accepted `n`, emitted
  `approval.resolved` denied and `workspace.write.denied`, left `tui-deny.txt`
  absent, and passed trace verify/session check.
- Real Skill shell-bypass guard denied shell-managed package mutation.
- Real `create_skill` created
  `.sparkwright/skills/release-reviewer/SKILL.md` without shell and with one
  managed workspace write.
- Config/schema gates passed: host config tests, CLI schema drift/XDG tests,
  generated schema validation, CLI config subset, and CLI capabilities inspect.
- Cron state commands passed in an isolated XDG root:
  create/list/status/pause/resume/update/remove wrote only
  `state/sparkwright/cron/jobs.json`.
- Cron job workspace stayed authoritative during deterministic `cron run`: a
  job workspace README sentinel was read even when the CLI `--workspace` pointed
  elsewhere.
- Real `openai/gpt-5.4-nano` read-only `cron run` returned
  `cron-real-ok CRON_REAL_SENTINEL`, emitted a complete trace, updated
  `lastTracePath`, wrote a local output file, and left README unchanged.
- `npm run release:check` passed after the focused runs, including full build,
  dist freshness, typecheck, lint, format, schema, lock/import/boundary checks,
  reserved-field strict check, all workspace tests, deterministic repo-pilot
  smoke, `regression:matrix`, source install smoke, and release install smoke.

## Non-Invariants Observed

- A conflicting prompt that asked to answer "exactly" one string and also
  include a sentinel caused the model to omit the sentinel; a later non-conflict
  prompt still answered `missing` even though the prompt contained the sentinel.
  This is model comprehension variance, not missing context injection.
- Real `create_skill` tried invalid `root` arguments before/after the successful
  create. The run completed, but session check reported an unresolved tool
  failure warning.
- The real Skill regression script timed out during update proposal drafting
  and then failed to parse a trace path from stdout; the preserved temp root
  still contained the trace.
- Release/source install smokes leave ignored `.sparkwright` session artifacts
  under the repo and example fixture; tracked worktree stayed clean.

## Failures

- Failure pattern: `prompt-induced-tool-loop`
- Failure pattern: `real-regression-grouped-config`
- Cause buckets: `model_variance`, `test_bug`
- Count update: incremented `prompt-induced-tool-loop` recorded count from 1 to
  2; recorded `real-regression-grouped-config` count 1 as a real regression
  harness `test_bug`.

## Coverage Update

- Page: `coverage/skills.md`
- Page: `coverage/cron.md`
- Page: `coverage/config-schema.md`
- Change: Added Skills and Cron coverage pages, refreshed Config Schema
  evidence, and recorded real-model create/update and real regression harness
  weak spots. Session/write/TUI approval confidence improved; Skill real-model
  update remains partial.

## Follow-Up

- Tighten the real Skill update prompt or harness stop condition so a single
  successful proposal ends the run.
- Have the regression harness recover trace paths from the preserved session
  root when stdout lacks `Trace written to ...`.
- Consider whether `update_skill` should supersede or de-duplicate repeated
  draft proposals for the same skill during one run.
- Update `scripts/regression-real-model.mjs` to recognize grouped
  `identity.providers` configs or share CLI model resolution.
- Add a real-provider `cron tick` canary before treating cron as release-level
  verified.
