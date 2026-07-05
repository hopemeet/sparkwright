# 2026-06-27 Indexed Agent Real Mini QA

## Direction

Validate the new indexed/generic agent delegation surface with real
`openai/gpt-5.4-mini` after changing default exposure from direct `delegate_*`
tools to `delegate_agent` / `delegate_parallel`.

## Scenario

- Workspace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-indexed-agent-real-mini-M6K3PD`
- Prompt shape: strong. It explicitly asked the model to use
  `delegate_parallel` with `agentId` targets `cli_reviewer` and
  `markdown_risk`.
- Model: `openai/gpt-5.4-mini`, using configured OpenAI provider.
- Policy: read-only (`run.accessMode: read-only`, CLI `--access-mode read-only`).
- Tool surface: `read_file`, `list_agents`, `delegate_agent`,
  `delegate_parallel`.
- Direct named delegates were not exposed. `agents.delegateTools` still listed
  `delegate_cli_reviewer` and `delegate_markdown_risk` as index descriptors.

## Commands

```bash
node packages/cli/dist/index.js capabilities inspect --workspace "$fixture" --format json
node packages/cli/dist/index.js run "<strong delegate_parallel prompt>" --workspace "$fixture" --model openai/gpt-5.4-mini --access-mode read-only --yes --trace-level debug
node packages/cli/dist/index.js trace summary "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
node packages/cli/dist/index.js session check "$session" --workspace "$fixture" --format text
```

## Evidence

- Capability inspect exposed only `delegate_agent`, `delegate_parallel`,
  `list_agents`, and `read_file` as tools.
- First real run:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-indexed-agent-real-mini-M6K3PD/.sparkwright/sessions/session_mqw1fk4lq7nsd7a9/trace.jsonl`
  - No hidden `delegate_cli_reviewer` / `delegate_markdown_risk` tool calls
    appeared.
  - The model repeatedly supplied both `agentId` and legacy `toolName`, or
    supplied `toolName: ""`, causing 13 tool failures. Cause bucket:
    `product_bug` in overly strict generic target parsing.
- Fix verification run:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-indexed-agent-real-mini-M6K3PD/.sparkwright/sessions/session_mqw1jmuo6i2g548r/trace.jsonl`
  - Tool failures: 0.
  - `trace verify`: ok.
  - `session check`: ok.
  - Subagents: two total (`cli_reviewer`, `markdown_risk`), not duplicated.
  - `delegate_parallel` completed with both children `alreadyCompleted: true`,
    reusing ledger results from prior `delegate_agent` calls.

## Findings

- Product bug fixed: generic delegate target parsing must be lenient because
  real mini may include both new `agentId` and legacy `toolName`, or include an
  empty legacy `toolName`. Runtime now treats empty target strings as absent and
  lets `agentId` win.
- Residual model behavior: even under a strong prompt, mini may call
  `delegate_agent` before `delegate_parallel`. This is model/tool-choice
  sensitivity, not a duplicate-runtime bug; the shared ledger prevents duplicate
  child spawning once redundant routes happen.

## Follow-Up Risk

- Consider tightening model-facing schema with `oneOf` once provider support is
  checked, but keep parser leniency regardless.
- Exact first-tool selection remains a weak real-model assertion. Stable
  assertions are tool surface, no direct named delegate calls, no arg failures,
  subagent count, ledger reuse, and trace/session consistency.
