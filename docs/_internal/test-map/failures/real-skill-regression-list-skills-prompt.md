# Real Skill Regression List Skills Prompt

- Status: `fixed`
- Dominant cause: `test_bug`
- Owner layer: real regression harness
- First observed: 2026-07-03 real `openai/gpt-5.4-mini` Skill QA
- Coverage: [../coverage/skills.md](../coverage/skills.md)

## Symptom

`REAL_SKILL_UPDATE_PROPOSAL` could fail even when the product behavior was
healthy: the model used `tool_search -> update_skill`, created one draft
proposal, left the source Skill unchanged, produced no shell calls, and made no
direct workspace writes.

## Root Cause

The regression prompt said to find `list_skills/update_skill` "as needed", but
the assertion required both `list_skills` and `update_skill`. A real model could
reasonably skip `list_skills` while still satisfying the product invariant.

## Fix

The regression prompt now explicitly requires `list_skills` exactly once before
`update_skill` exactly once. This keeps the test strict while aligning the
prompt with the assertion.

## Verification

`SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities`
passed. Update trace:
`/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-skill-caps-cOF4Jy/real-update/.sparkwright/sessions/session_mr4txmdajlou2piq/trace.jsonl`;
tools were `tool_search,list_skills,update_skill`.
