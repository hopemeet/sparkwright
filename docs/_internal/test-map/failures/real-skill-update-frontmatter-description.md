# Real Skill Update Body Missing Frontmatter Description

## Record

- Pattern ID: `real-skill-update-frontmatter-description`
- Status: `fixed`
- First seen: 2026-07-07
- Last seen: 2026-07-07
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

`regression:real-skill-capabilities` with real `openai/gpt-5.4-mini` failed the
`REAL_SKILL_UPDATE_PROPOSAL` case even though the model used the intended tools:
`tool_search,list_skills,update_skill`. The `update_skill` tool failed with
`TOOL_EXECUTION_FAILED` because the model-authored `body` contained SKILL.md
frontmatter with `name` but no `description`.

## Root Cause

`create_skill` normalized authored bodies by wrapping plain instruction text and
filling a missing frontmatter `description` from the tool description. The
`update_skill` path sent authored body content directly into proposal creation,
so a common real-model body shape that omitted frontmatter `description` reached
Skill manifest validation and failed before producing a draft.

## Fix

Fixed 2026-07-07 by sharing the Skill body frontmatter normalization path
between `create_skill` and `update_skill`, while keeping frontmatter `name`
mismatch fail-closed. The `update_skill` tool description now also tells the
model that missing frontmatter `description` is filled from the tool
`description`.

## Diagnostic Move

Inspect the failing `update_skill` request and terminal tool event:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.failed --jsonl
```

If `update_skill.arguments.body` has frontmatter `name` but no `description`,
and the failure message says the Skill manifest description is required,
classify it as this tool-normalization issue rather than provider connectivity
or trace/session corruption.

## Prevention

- Keep real Skill regression prompts strict about `list_skills` and
  `update_skill`, but do not require the model to remember manifest
  frontmatter details that the managed tool can safely normalize.
- Preserve fail-closed validation for mismatched frontmatter names.
- Rerun `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run
regression:real-skill-capabilities` after changing Skill tool descriptions,
  proposal validation, or manifest normalization.

## Related

- Scenarios: real Skill capability regression
- Coverage: [../coverage/skills.md](../coverage/skills.md)
- Run notes:
  [../runs/2026-07-07-real-mini-broad-trace-qa.md](../runs/2026-07-07-real-mini-broad-trace-qa.md)
