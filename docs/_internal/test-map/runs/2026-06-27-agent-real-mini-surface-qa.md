# 2026-06-27 Agent Real Mini Surface QA

## Summary

- Scenario: Retest recently updated agent behavior with real
  `openai/gpt-5.4-mini` across model-created agents, CLI-created agents,
  project markdown agents, normal delegate calls, `delegate_parallel`, dynamic
  `spawn_agent`, TUI capability visibility, and direct `delegates run`
  diagnostics.
- Coverage: focused deterministic agent gates, real `create_agent`, real
  configured delegate use, user-created config profile, markdown inline
  delegate profile, routing hints, parallel delegate fan-out, dynamic spawn,
  TUI `/capabilities`, trace verify, and session check.
- Result: `partial`
- Reusable lesson: Runtime trace/session contracts held across the tested
  surfaces, but a real mini model may still ignore a strongly worded
  "use `delegate_parallel` exactly once" prompt by first calling the individual
  delegate tools and only then calling `delegate_parallel`.

## Test Setup

- Task direction: Agent feature regression after a large update, including
  user-created agents and multiple use/trigger paths, not only model-triggered
  delegation.
- Prompt shape: `strong` for real-model CLI runs; command-driven for
  `agents create`, `agents validate`, capability inspection, TUI
  `/capabilities`, and direct `delegates run` diagnostics.
- Prompt: Required exact tool use for `create_agent`, delegate calls,
  `delegate_parallel`, and dynamic `spawn_agent`; prohibited shell, direct file
  edits, and unrelated agent tools.
- Model class: real provider/model `openai/gpt-5.4-mini`.
- Capabilities: `tool_search`, `create_agent`, `delegate_*`,
  `delegate_parallel`, `spawn_agent`, read-only workspace tools, user/project
  agent roots, and TUI capability panel.
- Permission/approval posture: writable model-created profile run used
  `--write --yes`; read-only delegate and spawn runs used `--yes` only when
  delegate approval was expected; all workspaces were temporary fixtures.
- Workspace/config isolation: temporary workspaces under `/var/folders/.../T/`;
  no product source files were used as write targets.
- Trace level: `debug`.
- Environment notes: user config provided OpenAI credentials and configured
  `openai/gpt-5.4-mini`; provider pricing was unavailable with
  `missing_pricing`.

## Commands Or Harness

```bash
npm run check:dist-fresh
npm --workspace @sparkwright/agent-runtime run typecheck
npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts test/tools.test.ts test/protocol.test.ts -t "agent|delegate|routing|delegate_parallel|create_agent|capabilit"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "agents|delegate_parallel|delegate|capabilities inspect"
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-agents
node packages/cli/dist/index.js agents create cli_reviewer --prompt "<read README risk>" --use workspace.read --allow read_file --delegate delegate_cli_reviewer --workspace "$fixture"
node packages/cli/dist/index.js agents validate --workspace "$fixture"
node packages/cli/dist/index.js capabilities inspect --workspace "$fixture" --model openai/gpt-5.4-mini --format text
node packages/cli/dist/index.js run "<call delegate_cli_reviewer and delegate_markdown_risk>" --workspace "$fixture" --model openai/gpt-5.4-mini --yes --trace-level debug
node packages/cli/dist/index.js run "<call delegate_parallel>" --workspace "$fixture" --model openai/gpt-5.4-mini --yes --trace-level debug
node packages/cli/dist/index.js run "<call spawn_agent>" --workspace "$fixture" --model openai/gpt-5.4-mini --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cmd 'node packages/cli/dist/index.js tui --workspace "$fixture" --model openai/gpt-5.4-mini --trace-level debug' --script '<open /capabilities and scroll>'
node packages/cli/dist/index.js delegates run delegate_cli_reviewer "<goal>" --workspace "$fixture" --yes --trace-level debug --format text
```

## Stable Evidence

- Deterministic gates passed: `dist` fresh, agent-runtime typecheck, host
  agent/delegate/protocol subset 48 tests, CLI agents/delegate/capabilities
  subset 10 tests.
- Model-created agent regression passed:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-real-agents-mZWFj1/workspace/.sparkwright/sessions/session_mqvvtm9bzn3yfrwq/trace.jsonl`
  had `tool_search -> create_agent`, one workspace write, one
  `capability.mutation.completed`, no tool failures, trace verify ok, and
  session check ok.
- Model-created delegate follow-up passed:
  `session_mqvvtt0xoxpef1an` had one `delegate_mini_reviewer` call,
  `subagent.completed` with parent `agentId: "main"` and child/profile
  `mini_reviewer`, no workspace writes, trace verify ok, and session check ok.
- User-created profile fixture:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-agent-surfaces-4vbNux/workspace`.
  `agents validate` reported config profile `cli_reviewer`, project markdown
  profile `markdown-risk`, no collisions, and no errors. `capabilities inspect`
  reported two agents, two delegate tools, and `delegate_parallel`.
- Real mini call of CLI-created plus markdown delegates passed:
  `session_mqvvv8cr5m6bo9ep` completed with two `subagent.completed` events,
  routing marked `delegate_markdown_risk` relevant from keyword hints, no
  tool failures, no workspace writes, trace verify ok, and session check ok.
- Real mini dynamic spawn passed:
  `session_mqvvw9h5vetngmkq` had one `spawn_agent`, one dynamic child
  `dynamic_risk-reader`, no approvals or workspace writes, trace verify ok,
  and session check ok.
- TUI `/capabilities` showed `openai/gpt-5.4-mini`, `2 agents`,
  `2 delegates`, and the tool list included `delegate_cli_reviewer`,
  `delegate_markdown_risk`, `delegate_parallel`, and `spawn_agent`.
- Direct `delegates run delegate_cli_reviewer` failed with a clear boundary
  diagnostic: internal profiles should use normal run-loop delegation, while
  direct `delegates run` supports ACP and external-command delegates.

## Non-Invariants Observed

- The `delegate_parallel` run (`session_mqvvvq55tlybva4a`) eventually exercised
  `delegate_parallel` successfully and produced two child sub-agent completions
  with `entrypoint: "delegate_parallel"`, but the model first called
  `delegate_cli_reviewer` and `delegate_markdown_risk` individually despite the
  prompt saying to call `delegate_parallel` exactly once.
- Real-model parent traces include child `read_file` requests in the same raw
  event stream, so assertions should separate parent-facing tool choices from
  child tool activity.

## Failures

- Failure pattern: none added.
- Cause bucket: `model_variance`
- Count update: no failure-pattern count changed; keep as a prompt/model
  sensitivity note for `delegate_parallel`.

## Coverage Update

- Page: `coverage/agents.md`
- Change: Added 2026-06-27 real-mini evidence for markdown profiles, user
  CLI-created profiles, routing hints, `delegate_parallel`, dynamic spawn, and
  TUI capability visibility after the agent update.

## Follow-Up

- Consider a deterministic or scripted regression for `delegate_parallel`
  routing/tool-selection ergonomics if product wants "call parallel first" to be
  more robust under real mini models.
- ACP live transport remains outside this run and should still get a focused
  fixture when ACP delegate behavior changes.
