# User Manual

This manual is the short path through Sparkwright as a usable runtime. It links
to deeper design notes when you need implementation details.

## What You Are Running

Sparkwright is an agent harness runtime. A run combines:

- a user goal
- bounded context
- model adapter output
- registered tools
- policy and approval checks
- workspace mutation primitives
- artifacts and JSONL trace

The model proposes actions. Sparkwright owns the execution boundary.

## First Run

From the repository root:

```bash
npm install
npm run build --workspaces
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

This path uses the deterministic model by default, so it works as a repeatable
smoke test without an external provider.

The run reads from `examples/repo-pilot`, requests a workspace write, resolves
approval through `--yes`, writes a diff artifact, and stores trace data under:

```txt
examples/repo-pilot/.sparkwright/sessions/<session-id>/
```

Omit `--yes` to review the approval prompt yourself. Omit `--write` for a
read-only smoke test.

## CLI Modes

Read-only trace smoke test:

```bash
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --trace-level minimal
```

Interactive approval:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --trace-level debug
```

Non-interactive approval for demos and CI smoke checks:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes
```

If `--write` is used without `--yes` in a non-interactive shell, the CLI denies
the approval request and records `workspace.write.denied` in the trace.

## Provider-Backed Run

Set an API key and select a provider/model:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --model openai/<model-name> \
  --trace-level standard
```

Provider adapters sit at the edge. The run still uses Sparkwright tools,
policy, approvals, artifacts, and trace.

## Interactive TUI

Launch the terminal UI with:

```bash
npm run tui
```

The root script rebuilds the workspace before launching. If you run compiled
files directly after editing source, rebuild first with `npm run build`.

## Permission Modes

Permission modes shape how runs handle risky actions:

- `plan`: prefer planning and read-only behavior.
- `default`: require approval for risky actions.
- `accept_edits`: accept workspace edits while keeping other gates.
- `dont_ask`: avoid interactive approval prompts where the host allows it.
- `bypass_permissions`: host-controlled escape hatch for trusted contexts.

Hosts should choose conservative defaults. Skills, MCP servers, and agent
profiles never grant authority by themselves; they only make capabilities
available to normal policy and approval paths.

## Trace And Sessions

Use trace commands to inspect what happened:

```bash
npm exec sparkwright -- trace summary examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
npm exec sparkwright -- trace events examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --type tool.failed --limit 20 --jsonl
npm exec sparkwright -- trace timeline examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
```

Use session commands for integrity checks and continuation:

```bash
npm exec sparkwright -- session check <session-id> --workspace examples/repo-pilot --format text
npm exec sparkwright -- session repair <session-id> --workspace examples/repo-pilot --dry-run
npm exec sparkwright -- session resume <session-id> "continue the investigation" --workspace examples/repo-pilot
```

Trace levels are:

- `minimal`: lifecycle and terminal facts.
- `standard`: useful debugging detail for normal runs.
- `debug`: deeper event payloads for development.

For maintainers checking expected event sequences and output files, see
[CLI Golden Path](../maintainer/CLI_GOLDEN_PATH.md).

## Common Next Steps

- Configure providers and local preferences: [Configuration](./CONFIGURATION.md).
- Add a custom action: [Custom Tool Example](./CUSTOM_TOOL_EXAMPLE.md).
- Add prompt/context packages: [Skills](../reference/SKILLS.md).
- Compose Skills, MCP, and agent policy: [Capability Design Guide](./CAPABILITY_DESIGN_GUIDE.md).
- Run long commands safely: [Automation And Background Tasks](./AUTOMATION_AND_BACKGROUND_TASKS.md).
- Debug failures: [Troubleshooting](./TROUBLESHOOTING.md).
