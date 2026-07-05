# 2026-06-25 Agent Attribution Fix

## Summary

- Scenario: Fix agent/delegate attribution issues found by multi-surface agent
  QA without treating them as only model weakness.
- Coverage: Dynamic `spawn_agent`, configured in-process delegates, ACP
  delegates, external-command delegates, direct CLI `delegates run`, trace
  summary output, TUI sub-agent labels, and model-facing `create_agent`
  idempotency plus explicit profile update/replace semantics.
- Result: `verified`
- Reusable lesson: Parent-visible `subagent.*` events need separate fields for
  persistence actor, session, and child/delegate identity. Relying on
  persistence-layer metadata rewriting creates split-brain diagnostics between
  stdout/live events and `trace.jsonl`.

## Test Setup

- Task direction: Repair agent functionality after exploratory QA found
  user-created/model-created agent paths and direct delegate diagnostics issues.
- Prompt shape: deterministic/source-level regression plus scripted real-model
  mini canary.
- Model class: deterministic/scripted tests and `openai/gpt-5.4-mini`.
- Capabilities: agents, delegate tools, external-command/ACP transports,
  trace diagnostics, CLI, and TUI event rendering.
- Permission/approval posture: unit/fixture workspaces under temporary dirs.
- Trace level: standard/debug fixture coverage depending on test.

## Stable Assertions

- Parent-visible sub-agent metadata uses `agentId` for the parent/trace actor,
  `sessionId` for session-scoped runs, `childAgentId` for the child/delegate
  identity, and `agentProfileId` for configured profiles.
- Direct `delegates run --format json` and the persisted `trace.jsonl` expose
  the same sub-agent lifecycle metadata shape.
- `trace summary` reports `subagentIds` separately from persisted `agentIds`.
- TUI sub-agent labels prefer `agentName`, then `childAgentId` /
  `agentProfileId`, before falling back to parent `agentId`.
- Equivalent `create_agent` requests are idempotent even when a legacy/direct
  caller passes `force:true`; the model-facing schema no longer advertises
  `force`.
- Different existing profiles are not silently overwritten by repeated
  `create_agent`. `action:"update"` patches explicitly supplied fields and
  delegate config; `action:"replace"` requires `replaceReason` and removes stale
  delegate tools for the replaced profile.

## Commands

```bash
npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/external-command-agent.test.ts test/acp-child-agent.test.ts test/tools.test.ts test/protocol.test.ts -t "agent|delegate|subagent|create_agent"
npm --workspace @sparkwright/core test -- test/trace.test.ts -t "subagent|delegate|summary|trace"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegates run|delegate|capabilities inspect|trace"
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts test/status-bar-render.test.tsx test/session-list-dialog-render.test.tsx test/format-event.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts
npm run typecheck
npm run typecheck:test
npm run format:check
npm run check:dist-fresh
npm run regression:real-agents
```

## Failures Reclassified

- `delegates-run-event-metadata-divergence`: changed from active to fixed.
- Cause bucket remains `product_bug`; the root cause was field-contract
  overloading plus a direct delegate parent run created before session identity
  was attached.

## Residual Risk

- Real-model delegation remains prompt/model-sensitive; keep exact prose, exact
  tool order, and retry count out of stable assertions.
- Real mini sometimes performs harmless parent-side reads around a delegate
  call. The reusable regression checks invariants instead of exact tool order.

## Follow-up Explicit Update/Replace

- Result: `verified`
- Deterministic gate:
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`
- Product behavior:
  - `create_agent action:"create"` remains idempotent for equivalent existing
    profiles and rejects different existing profiles with guidance to use
    `update` or `replace`.
  - `action:"update"` requires an existing profile, patches only supplied
    fields, updates delegate `maxSteps` when the profile `maxSteps` changes,
    and can remove the delegate via `removeDelegateTool:true`.
  - `action:"replace"` requires an existing profile, a replacement prompt, and
    non-empty `replaceReason`; it removes stale delegates for that profile and
    records `replace_agent_profile`.
  - Legacy/direct `force:true` on a different existing profile maps to the same
    replace mutation path for compatibility while clearing stale delegates.
  - Agent profile writes preserve sibling `capabilities.agents.maxDepth`
    instead of replacing the full agents object with only profiles/delegates.

## Follow-up Real Mini Smoke

- Model: `openai/gpt-5.4-mini`
- Workspace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-agent-smoke-WYUa0S`
- Create run trace:
  `.sparkwright/sessions/session_mqtjdzyyvgd2silm/trace.jsonl`
- Delegate run trace:
  `.sparkwright/sessions/session_mqtjes8rojh7xq6e/trace.jsonl`
- Result: `verified`

Stable evidence:

- The model created `mini_reviewer` and `delegate_mini_reviewer` through
  `tool_search` -> `create_agent`.
- Trace summary for the create run showed exactly one `create_agent`, one
  workspace write, one capability mutation, zero tool failures, and verify
  findings `[]`.
- The follow-up run called `delegate_mini_reviewer` once. The child called
  `read_file` once, produced `subagent.completed`, and made no workspace
  writes.
- Delegate trace summary separated parent and child identity:
  `agentIds: ["main", "mini_reviewer"]` and
  `subagentIds: ["mini_reviewer"]`.
- `subagent.completed.metadata` carried
  `sessionId: "session_mqtjes8rojh7xq6e"`, `agentId: "main"`,
  `childAgentId: "mini_reviewer"`, `agentProfileId: "mini_reviewer"`, and
  `entrypoint: "delegate"`.

Commands:

```bash
node packages/cli/dist/index.js run "<create mini_reviewer via create_agent exactly once>" --workspace "$tmp" --model openai/gpt-5.4-mini --write --yes --trace-level debug
node packages/cli/dist/index.js trace summary "$tmp/.sparkwright/sessions/session_mqtjdzyyvgd2silm/trace.jsonl"
node packages/cli/dist/index.js trace verify "$tmp/.sparkwright/sessions/session_mqtjdzyyvgd2silm/trace.jsonl"
node packages/cli/dist/index.js run "<call delegate_mini_reviewer exactly once>" --workspace "$tmp" --model openai/gpt-5.4-mini --yes --trace-level debug
node packages/cli/dist/index.js trace summary "$tmp/.sparkwright/sessions/session_mqtjes8rojh7xq6e/trace.jsonl"
node packages/cli/dist/index.js trace verify "$tmp/.sparkwright/sessions/session_mqtjes8rojh7xq6e/trace.jsonl"
node packages/cli/dist/index.js session check session_mqtjes8rojh7xq6e --workspace "$tmp"
```

## Reusable Real Mini Regression Script

- Script: `npm run regression:real-agents`
- Result: `verified`
- Default model: `openai/gpt-5.4-mini`
- Latest run workspace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-2yGXZE`
- Create run trace:
  `.sparkwright/sessions/session_mqtkzpxvqt0jw3ly/trace.jsonl`
- Delegate run trace:
  `.sparkwright/sessions/session_mqtkzxbf3z97wnje/trace.jsonl`

Stable evidence:

- Create case: `tools=tool_search,create_agent`, `writes=1`,
  `mutations=1`, no shell, no tool failures, trace verify clean. The script now
  asserts `tool_search` occurs before `create_agent`.
- Delegate case: real mini called `delegate_mini_reviewer`, did not call
  `create_agent`, made no workspace writes, trace verify and session check were
  clean.
- Attribution remained separated:
  `agentIds=main,mini_reviewer`, `subagentIds=mini_reviewer`,
  `childAgentId=mini_reviewer`.
