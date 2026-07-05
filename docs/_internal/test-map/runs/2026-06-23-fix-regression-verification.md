# 2026-06-23 Fix Regression Verification

## Direction

Verify the latest fixes for previously recorded shell terminality, cron
deterministic tick isolation, real regression config probing, and Skill proposal
looping. Continue failure hunting after the user reported fixes were applied.

## Environment

- Workspace:
  `/Applications/xgw/projects/AI-native/SparkWright`
- Date: 2026-06-23
- Build state: `npm run build` completed before runtime checks;
  `npm run check:dist-fresh` and final `npm run check` passed.
- Real model: `openai/gpt-5.4-nano` from local user config; secrets were only
  checked as present/redacted.
- Prompt shape: scripted for shell invalid args; deterministic for cron; strong
  real-model prompts for regression scripts.

## Results

### Fixed And Verified

- Shell invalid args terminality: passed. Scripted `shell` call with
  `timeoutMs: 0` now records `TOOL_ARGUMENTS_INVALID` as `tool.failed`, no
  `tool.started`, one terminal `run.completed`, and passing `trace verify`.
  The CLI exits non-zero because the unresolved tool failure is intentional.
- Cron deterministic two-job tick: passed. Both due deterministic jobs used
  fresh model state and both traces requested `read_file`.
- Skill update proposal loop: passed in the real Skill regression. The real
  model created one draft proposal for `repo-reviewer`, did not apply it, and
  did not time out.

### Still Failing Or Watch

- `npm run regression:real-model` still skips without a workaround. Root cause:
  `scripts/regression-real-model.mjs` ignores `{ isolateConfig: false }` and
  hides user config behind an empty temporary `XDG_CONFIG_HOME`.
- With `SPARKWRIGHT_CONFIG="$HOME/.config/sparkwright/config.yaml"` as a
  workaround, `regression:real-model` ran 5/6 cases. `REAL_WRITE_DENIED` failed
  because the prompt requires nonexistent `append_file`; the model repeatedly
  searched for that schema and never attempted a write.
- `regression:real-skill-capabilities` passed allowlist, shell guard, and
  update proposal cases, but `REAL_SKILL_CREATE` failed the script assertion
  after the skill was created successfully because the model repeated the same
  `create_skill` call and runtime guardrails recovered with
  `REPEATED_TOOL_CALL_SKIPPED`.

## Evidence

- Shell trace:
  `/tmp/sparkwright-shell-invalid-fixed.bMoxpz/.sparkwright/sessions/session_mqqfcjmiw6qq3h6o/trace.jsonl`
- Cron traces:
  `/tmp/sparkwright-cron-tick-fixed.wh5C2N/ws/.sparkwright/sessions/cron-ac44e7c5e389/trace.jsonl`,
  `/tmp/sparkwright-cron-tick-fixed.wh5C2N/ws/.sparkwright/sessions/cron-93734c2452db/trace.jsonl`
- Real model temp root:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-regression-D9pItr`
- Real model failed write-denial trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-regression-D9pItr/workspace/.sparkwright/sessions/session_mqqfgrrf4u42gwij/trace.jsonl`
- Real Skill temp root:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-BJVhcR`
- Real Skill create trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-BJVhcR/real-create/.sparkwright/sessions/session_mqqfii2agybvg252/trace.jsonl`
- Real Skill update trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-BJVhcR/real-update/.sparkwright/sessions/session_mqqfix2eskq8daum/trace.jsonl`

## Commands

```bash
node --check scripts/lib/real-model-config.mjs
npm --workspace @sparkwright/core test -- test/run.test.ts test/trace.test.ts
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace|config|capabilities inspect|skill"
npm run check:dist-fresh
npm run check
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano npm run regression:real-model
SPARKWRIGHT_CONFIG="$HOME/.config/sparkwright/config.yaml" SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-model
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
```

## Follow-Up

- Fix `scripts/regression-real-model.mjs` to honor `options.isolateConfig === false`.
- Change `REAL_WRITE_DENIED` to use a real write-capable tool or a scripted
  deterministic write-denial case.
- Either strengthen the real Skill create prompt to "call `create_skill` once
  and stop" or treat recovered `REPEATED_TOOL_CALL_SKIPPED` as a warning when
  the skill was created and the final outcome is non-failing.
