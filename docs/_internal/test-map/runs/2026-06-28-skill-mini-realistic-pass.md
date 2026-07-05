# 2026-06-28 Skill Mini Realistic Pass

## Summary

- Scenario: real `openai/gpt-5.4-mini` Skill capability QA covering proposal-first creation, self-evolution drafts, explicit Skill loading, and Skill stats.
- Coverage: [../coverage/skills.md](../coverage/skills.md)
- Result: `pass`
- Reusable lesson: with write permission, bypass access mode, and the full default tool catalog available, Skill self-evolution still stayed in the proposal pipeline and Skill stats linked trace evidence to proposal activity by package-hash identity.

## Test Setup

- Task direction: test project Skills with a mini model, including self-evolution and Skill statistics, close to real usage with broad permissions/tools.
- Prompt shape: `strong`
- Prompt: dedicated regression prompts for `create_skill`/`update_skill`, plus a realistic temp-project workflow that required `list_skills`, `skill_load`, file reads, and one `update_skill` draft.
- Model class: real provider/model `openai/gpt-5.4-mini`
- Capabilities: default CLI host catalog, including read tools, `skill_load`, `list_skills`, `create_skill`, `update_skill`, `tool_search`, shell, write tools, agents, cron, and task tools. The dedicated regression also disabled shell for the two real Skill mutation prompts to assert managed Skill tools survive shell removal.
- Permission/approval posture: regression real cases used `--write --yes`; realistic workflow used `--write --yes-all --access-mode bypass`.
- Workspace/config isolation: regression used `SPARKWRIGHT_KEEP_REAL_REGRESSION=1` and isolated XDG config under `/var/folders/.../sparkwright-real-skill-caps-ARmJBc`; realistic workflow used `/tmp/sparkwright-skill-realistic.dBXj5L`.
- Trace level: `debug`
- Environment notes: user config `~/.config/sparkwright/config.yaml` provided `openai/gpt-5.4-mini`; provider cost was unavailable because pricing was not reported.

## Commands Or Harness

```bash
npm run check:dist-fresh
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities
node packages/cli/dist/index.js run "<realistic repo-sentinel skill workflow>" --workspace /tmp/sparkwright-skill-realistic.dBXj5L --model openai/gpt-5.4-mini --write --yes-all --access-mode bypass --trace-level debug
node packages/cli/dist/index.js trace summary /tmp/sparkwright-skill-realistic.dBXj5L/.sparkwright/sessions/session_mqxunak2sax46gkt/trace.jsonl --format text
node packages/cli/dist/index.js trace verify /tmp/sparkwright-skill-realistic.dBXj5L/.sparkwright/sessions/session_mqxunak2sax46gkt/trace.jsonl --format text
node packages/cli/dist/index.js session check session_mqxunak2sax46gkt --workspace /tmp/sparkwright-skill-realistic.dBXj5L --format text
node packages/cli/dist/index.js skills stats --workspace /tmp/sparkwright-skill-realistic.dBXj5L --skill repo-sentinel --format json
```

## Stable Evidence

- `regression:real-skill-capabilities` passed all cases for `openai/gpt-5.4-mini`.
- `REAL_SKILL_CREATE`: requested `list_skills`, `tool_search`, and `create_skill`; produced proposal `skillprop_mqxul0aeobrbhe9b`, `SKILL.md` only under the proposal `after/` package, 6 `capability.mutation.completed` events, and 0 direct workspace writes.
- `REAL_SKILL_UPDATE_PROPOSAL`: requested `list_skills`, `tool_search`, and `update_skill`; produced proposal `skillprop_mqxul7jg2w4sz172`, 6 `capability.mutation.completed` events, 0 direct workspace writes, and left the original Skill hash unchanged.
- Realistic workflow trace `session_mqxunak2sax46gkt` had 7 tool calls: `list_skills` x2, `skill_load`, `read_file` x2, `tool_search`, and `update_skill`; no `tool.failed` events; no `workspace.write.completed` events; trace verify and session check both reported `status: ok`.
- Realistic workflow proposal `skillprop_mqxunhiv2m4u4jqz` stayed `draft`, carried provenance `{ runId: run_mqxunar6sxodd0a9, sessionId: session_mqxunak2sax46gkt }`, and history for `repo-sentinel` remained empty.
- Skill stats for `repo-sentinel` reported `indexed=1`, `explicitLoad=1`, `loadFailures.total=0`, projection cache/catalog hits on targeted query, and `SKILL_EVOLUTION_ACTIVITY` with one proposal tied to the same run/session.

## Non-Invariants Observed

- The model chose `read_file` rather than shell for repository reads even though shell was available. Tool route choice is not an invariant for real-model tests.
- Exact final prose and exact intermediate `tool_search` usage remain model-sensitive.
- Provider cost reporting stayed unavailable with `missing_pricing`; this is trace/pricing metadata, not a provider connectivity failure.

## Failures

- Failure pattern: none.
- Cause bucket: none.
- Count update: none.

## Coverage Update

- Page: [../coverage/skills.md](../coverage/skills.md)
- Change: added 2026-06-28 evidence for full-tool real mini Skill load + self-evolution + stats targeted-query coverage.

## Follow-Up

- Add a dedicated real Skill capability scenario if this becomes a recurring release gate.
