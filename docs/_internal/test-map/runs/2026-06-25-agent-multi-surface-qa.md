# 2026-06-25 Agent Multi-Surface QA

## Summary

- Scenario: Test agent functionality through user-created profiles, model-created
  profiles, run-loop delegates, dynamic `spawn_agent`, direct external
  `delegates run`, and TUI capability inspection.
- Coverage: CLI `agents create/list/validate`, host capability snapshots, TUI
  `/capabilities`, real-model `create_agent`, real-model delegate invocation,
  real-model dynamic spawn, direct external-command delegate execution, trace
  summary/report/verify, and session check.
- Result: `partial`
- Reusable lesson: Core agent contracts held, but direct external delegate
  diagnostics can disagree between `delegates run --format json` and persisted
  trace metadata. Real model agent creation and delegate use can also recover
  from repeated tool calls after functionally succeeding, so cost/retry
  assertions must remain separate from runtime invariants.

## Test Setup

- Task direction: Test agent features beyond model-triggered delegation,
  including user-created agents and multiple trigger/use paths.
- Prompt shape: `strong` for real-model runs; command-driven for CLI/TUI/direct
  delegate scenarios.
- Prompt: Created reviewer-style child agents for README risk review; dynamic
  spawn prompt constrained the first tool batch to one `spawn_agent`; model
  creation prompt required `tool_search`/`create_agent` and forbade shell.
- Model class: real provider/model `openai/gpt-5.4-nano`.
- Capabilities: `list_agents`, `create_agent`, `spawn_agent`, configured
  in-process delegate tools, external-command delegate tools, `tool_search`,
  read-only workspace tools, and TUI capability panel.
- Permission/approval posture: temporary workspaces under `/tmp`; model-created
  agent used `--write --yes`; delegate invocation used `--yes` without
  `--write` for read-only delegates; direct external delegate used `--yes`.
- Workspace/config isolation: all writable tests used `/tmp` fixtures with
  project-local `.sparkwright/config.json`.
- Trace level: `debug`.
- Environment notes: provider credentials were available from redacted user
  config; default model was `openai/gpt-5.4-nano`. Main repo worktree was clean
  before the run except the branch being ahead of `origin/main`.

## Commands Or Harness

```bash
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/external-command-agent.test.ts test/acp-child-agent.test.ts test/agent-profiles.test.ts test/tools.test.ts
npm --workspace @sparkwright/core test -- test/trace.test.ts -t "subagent|delegate"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "agents|delegate|capabilities inspect"
node packages/cli/dist/index.js agents create qa_reviewer --prompt "<review prompt>" --use workspace.read --allow read_file --delegate delegate_qa_reviewer --workspace "$tmp"
node packages/cli/dist/index.js run "<call delegate_qa_reviewer>" --workspace "$tmp" --model openai/gpt-5.4-nano --yes --trace-level debug
node packages/cli/dist/index.js delegates run delegate_external_reviewer --goal "<goal>" --workspace "$tmp" --yes --trace-level debug --format json
node packages/cli/dist/index.js run "<create model_reviewer with create_agent>" --workspace "$tmp" --model openai/gpt-5.4-nano --write --yes --trace-level debug
node packages/cli/dist/index.js run "<call delegate_model_reviewer>" --workspace "$tmp" --model openai/gpt-5.4-nano --yes --trace-level debug
node packages/cli/dist/index.js run "<dynamic spawn_agent canary>" --workspace "$tmp" --model openai/gpt-5.4-nano --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cmd 'node packages/cli/dist/index.js tui --workspace "$tmp" --model openai/gpt-5.4-nano --trace-level debug' --script '<open /capabilities and dump>'
```

## Stable Evidence

- Focused deterministic gates passed: host agent/delegate/tool files
  89 tests, core subagent/delegate trace subset 3 tests, CLI
  agents/delegate/capabilities subset 7 tests.
- User CLI-created in-process delegate fixture:
  `/tmp/sparkwright-agent-user.mV5df5`. `agents validate` reported one profile
  and one delegate tool; `capabilities inspect` reported `agents: 1 effective`
  and `1 delegate tools`; TUI `/capabilities` displayed `1 agents, 1 delegates`
  and listed `delegate_qa_reviewer`.
- Real-model call of user-created delegate:
  `/tmp/sparkwright-agent-user.mV5df5/.sparkwright/sessions/session_mqt1h1b5u6u20e8d/trace.jsonl`.
  The run completed read-only with one delegate call, `subagent.completed`,
  `trace verify ok`, and `session check ok`.
- Direct external delegate fixture:
  `/tmp/sparkwright-agent-external.vT2pbH`. The direct `delegates run` path
  executed under sandbox, emitted approval and `subagent.*` lifecycle events,
  produced no workspace writes, and passed trace verify/session check.
- Model-created agent fixture:
  `/tmp/sparkwright-agent-model-create.B6D9S3`. The real model used
  `tool_search` and `create_agent`, producing `.sparkwright/config.json` with
  `model_reviewer` and `delegate_model_reviewer`. Later run
  `session_mqt1l1m27q3aabii` called that delegate and passed trace verify and
  session check.
- Dynamic spawn fixture:
  `/tmp/sparkwright-agent-spawn.aARoCU/.sparkwright/sessions/session_mqt1lodqifekr7f2/trace.jsonl`.
  The real model called `spawn_agent` once, the child read `README.md`, no
  approvals or writes occurred, `trace report` verdict was `ok`, and trace
  verify/session check passed.

## Non-Invariants Observed

- Real-model in-process delegate children sometimes repeated an identical
  `read_file`; runtime recovered with `REPEATED_TOOL_CALL_SKIPPED` and no
  unresolved failures.
- Real-model `create_agent` succeeded, then repeated `create_agent` with a
  different description and failed as expected, then used `force:true` and wrote
  the same final profile shape again. The final config was valid, but the run
  incurred two workspace writes and two capability mutations.
- Follow-up comparison showed the duplicate `create_agent` behavior is not a
  hard model-capability limit: both `openai/gpt-5.4-mini` and
  `openai/gpt-5.4-nano` completed cleanly with one `create_agent`, one
  workspace write, and no tool failures when the prompt explicitly said to call
  `create_agent` exactly once and stop after the first successful result.
- Cost was unavailable because configured pricing for `openai/gpt-5.4-nano` was
  missing.

## Failures

- Failure pattern: `delegates-run-event-metadata-divergence`
- Cause bucket: `product_bug`
- Count update: Added new active pattern with count 1.

## Coverage Update

- Page: `coverage/agents.md`
- Change: Added 2026-06-25 evidence for user-created agents, model-created
  agents, TUI capability visibility, dynamic spawn, and the direct delegate
  metadata divergence weak spot.

## Follow-Up

- Fix or explicitly document the public attribution contract for direct
  `delegates run` `subagent.*` events, then add a CLI regression comparing
  JSON stdout events with persisted `trace.jsonl`.
- Treat repeated post-success `create_agent` attempts as a tool-contract/prompt
  sensitivity risk rather than a product invariant failure. Prefer a broader
  capability-mutation design pass over a local one-off guard: make create/update
  semantics explicit, preserve idempotency for equivalent requested state, and
  require clear user intent before force-replacing an already-created profile.
