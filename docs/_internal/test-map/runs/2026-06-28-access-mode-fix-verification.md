# 2026-06-28 Access Mode Fix Verification

## Summary

- Scenario: fix verification for read-only safe-read approval and stale real
  Skill/agent regression canaries.
- Coverage: core plan-mode policy, CLI/TUI read-only safe read behavior,
  real mini Skill proposal canary, real mini indexed agent delegation canary.
- Result: `pass`
- Reusable lesson: read-only autonomy should be enforced by write/risk
  denials plus explicit read-only tool governance, not by routing all safe tools
  through approval. Real canaries should assert the current capability
  descriptor contract.

## Test Setup

- Task direction: fix root causes from the 2026-06-28 real mini QA pass.
- Prompt shape: `scripted` for deterministic CLI/TUI regressions; `strong` for
  real mini canaries; PTY scripted input for final TUI visual verification.
- Model class: real provider/model `openai/gpt-5.4-mini`; scripted model for
  focused integration regressions.
- Capabilities: default repo read tools, Skill create/update, agent
  create/delegate.
- Permission/approval posture: `read-only`, `ask`, `accept-edits`, and real
  regression write-enabled canaries.
- Workspace/config isolation: real read-only repo runs; temp regression
  workspaces owned by scripts.
- Trace level: `debug` for real runs.
- Environment notes: core/host/cli/tui dist rebuilt before downstream tests to
  avoid stale package-export behavior.

## Commands Or Harness

```bash
npm --workspace @sparkwright/core test -- test/policy.test.ts test/access-mode.test.ts
npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts
npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts test/permission.test.ts
npm run build --workspace @sparkwright/core
npm run build --workspace @sparkwright/host
npm run build --workspace @sparkwright/cli
npm run build --workspace @sparkwright/tui
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "read-only access mode|access-mode overrides|accept_edits mode"
npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts -t "read-only TUI|approval before running write-capable shell|bypass mode"
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run regression:real-skill-capabilities
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run regression:real-agents
node packages/cli/dist/index.js run "<read-only repo prompt>" --workspace . --model openai/gpt-5.4-mini --access-mode read-only --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cmd "node packages/cli/dist/index.js tui --workspace . --model openai/gpt-5.4-mini --access-mode read-only --trace-level debug" ...
```

## Stable Evidence

- Core `policy.test.ts` now asserts `plan` mode allows explicit `risk:"safe"`
  tools only when governance side effects are read-only/no-op, and still
  requires approval for bare, metadata-incomplete, risky, and write-side-effect
  tools.
- Host `read_file` now carries coding-tool origin metadata plus
  `sideEffects: ["read"]`; it intentionally does not mark generic
  `idempotency:"idempotent"` so repeated-read loop guards retain their existing
  behavior.
- CLI scripted read-only regression completed `read_file` and `glob` with no
  `approval.requested`.
- TUI scripted read-only regression reached `done` before any approval prompt.
- Real CLI read-only trace:
  `.sparkwright/sessions/session_mqxrirn46qlht3xf/trace.jsonl`. Summary:
  2 `read_file`, 0 approvals, 0 writes.
- Real TUI read-only trace:
  `.sparkwright/sessions/session_tui_mqxrn5zz/trace.jsonl`. Summary:
  2 `read_file`, 0 approvals, 0 writes.
- `regression:real-skill-capabilities` passed with real mini. Skill create
  evidence: `create_skill` produced one proposal with `SKILL.md`, six
  `capability.mutation.completed`, and zero `workspace.write.completed`.
- `regression:real-agents` passed with real mini. Delegate evidence:
  `delegate_agent` targeted `mini_reviewer`; trace/session attribution included
  `agentIds=main,mini_reviewer` and `subagentIds=mini_reviewer`.

## Non-Invariants Observed

- Real mini may call `list_agents` or `tool_search` before `create_agent`; the
  agent canary asserts required ordering only where the tool contract needs it.
- TUI PTY screen dumps can include the Ctrl-C quit reminder after completion;
  trace/session diagnostics decide run health.

## Failures

- Failure pattern:
  [access-mode-read-only-safe-read-approval.md](../failures/access-mode-read-only-safe-read-approval.md)
- Cause bucket: `product_bug`
- Count update: unchanged count 2; status moved to `retired` after fix
  verification.
- Failure pattern:
  [real-regression-stale-capability-semantics.md](../failures/real-regression-stale-capability-semantics.md)
- Cause bucket: `test_bug`
- Count update: unchanged count 2; status moved to `retired` after script
  update and real mini rerun.

## Coverage Update

- Page: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Change: read-only safe-read approval prompt is fixed and verified by PTY.
- Page: [../coverage/skills.md](../coverage/skills.md)
- Change: real Skill create canary now asserts proposal-first behavior.
- Page: [../coverage/agents.md](../coverage/agents.md)
- Change: real agent canary now asserts indexed `delegate_agent(agentId)`.

## Follow-Up

- Run the broader package tests if adjacent approval or capability surfaces
  change again.
