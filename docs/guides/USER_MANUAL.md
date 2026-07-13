# User Manual

This manual is the short path through SparkWright as a usable runtime. It links
to deeper design notes when you need implementation details.

## What You Are Running

SparkWright is an agent harness runtime. A run combines:

- a user goal
- bounded context
- model adapter output
- registered tools
- policy and approval checks
- workspace mutation primitives
- artifacts and JSONL trace

The model proposes actions. SparkWright owns the execution boundary.

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
  --trace-level standard \
  --model deterministic
```

This path selects the deterministic model explicitly, so it works as a repeatable
smoke test without an external provider.

The run reads from `examples/repo-pilot`, enables workspace writes, resolves
approval through `--yes` if the model asks to edit, and stores trace data under:

```txt
examples/repo-pilot/.sparkwright/sessions/<session-id>/
```

`--target README.md` limits where workspace writes may land. It does not narrow
workspace reads to that file; use confidential read policy/configuration when a
path must not be read.

Omit `--yes` to review the approval prompt yourself. Omit `--write` for a
read-only smoke test.

## CLI Modes

Read-only trace smoke test:

```bash
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --trace-level standard \
  --model deterministic
```

Approval-enabled run:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --trace-level debug \
  --model deterministic
```

Non-interactive approval for demos and CI smoke checks:

```bash
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --model deterministic
```

If `--write` is used without `--yes` in a non-interactive shell, any approval
request is denied and recorded as `workspace.write.denied` in the trace.

## Provider-Backed Run

Set an API key and select a provider/model:

```bash
OPENAI_API_KEY=... npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --model openai/<model-name> \
  --trace-level standard
```

Provider adapters sit at the edge. The run still uses SparkWright tools,
policy, approvals, artifacts, and trace.

## Interactive TUI

Launch the terminal UI with:

```bash
npm run tui
```

The root script rebuilds the workspace before launching. If you run compiled
files directly after editing source, rebuild first with `npm run build`.

In `/sessions`, select a session and press `i` to inspect diagnostics. When
available, the inspect view includes the same compaction audit surfaced by
`session inspect --compaction`, without printing compacted summary content.

## ACP Agent Server

Use ACP when an editor or local ACP client wants to launch SparkWright as a
coding agent subprocess:

```bash
sparkwright acp --workspace /path/to/project
```

The ACP server communicates over stdio. It maps ACP sessions and permission
requests onto the normal SparkWright host runtime, so policy, approval,
workspace mutation, artifacts, and trace remain governed by SparkWright.
ACP `session/new` may include `mcpServers`; SparkWright merges those
session-scoped MCP servers with configured MCP servers for that session.
Configured MCP servers default to lazy startup, so ordinary runs do not connect
until an MCP gateway tool is used. Session-scoped MCP servers supplied by ACP
are explicit for that session and may be prepared immediately so concrete MCP
tool names are discoverable; when schema loading is deferred, the model fetches
those concrete tools through `tool_search select:<tool-name>`. ACP `http`,
`sse`, and stdio MCP server descriptors are supported. MCP-over-ACP descriptors
are rejected until that transport is implemented.

## External ACP Delegates

Use an ACP delegate when a SparkWright run should call another local
ACP-compatible coding agent for a bounded sub-task. Add an agent profile with
`metadata.acp`, then expose it through `capabilities.agents.delegateTools`:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_reviewer",
          "name": "External Reviewer",
          "metadata": {
            "acp": {
              "transport": "stdio",
              "command": "codex",
              "args": ["acp"],
              "cwd": ".",
              "workspaceAccess": "read_write",
              "timeoutMs": 120000
            }
          }
        }
      ],
      "delegateTools": [
        {
          "profileId": "external_reviewer",
          "toolName": "delegate_external_reviewer",
          "description": "Delegate review work to an external ACP agent."
        }
      ]
    }
  }
}
```

`command` and `args` can point at any installed ACP-compatible subprocess. The
delegate tool is risky and approval-gated by default; the external agent does
not receive SparkWright file-system or terminal capabilities unless a host
explicitly adds them through a governed bridge. Omit `workspaceAccess` to avoid
passing the project cwd; set `"workspaceAccess": "read_write"` only when the
external agent should receive direct workspace access. ACP delegates default to
`envMode: "explicit"`, which passes only a minimal process environment
(`PATH`/Windows process basics) plus configured `env`. Set
`envMode: "inherit"` only when the child must see the parent environment.

## External Command Delegates

Use an external command delegate when a local coding assistant is available as
a normal CLI rather than an ACP server:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_cli_reviewer",
          "name": "External CLI Reviewer",
          "metadata": {
            "externalCommand": {
              "command": "agent-cli",
              "args": ["run", "{{goal}}"],
              "envMode": "inherit",
              "input": "none",
              "workspaceAccess": "read_write",
              "timeoutMs": 120000,
              "maxStdoutBytes": 64000,
              "maxStderrBytes": 64000,
              "successExitCodes": [0]
            }
          }
        }
      ],
      "delegateTools": [
        {
          "profileId": "external_cli_reviewer",
          "toolName": "delegate_external_cli_reviewer"
        }
      ]
    }
  }
}
```

The command is launched with `spawn`, not through a shell. Supported argument
placeholders are `{{goal}}`, `{{metadataJson}}`, and `{{workspaceRoot}}`.
Set `input` to `argument` to append the goal as the final argument, `stdin` to
write the goal to standard input, or `none` when the configured args already
contain all needed context. Non-zero exits fail the delegate unless listed in
`successExitCodes`. `envMode` defaults to `inherit`; use `explicit` to pass
only the configured `env` map. Under `inherit`, a sandboxed delegate
(`workspaceAccess: "none"`, the default) does **not** receive credential-looking
parent env vars (names matching `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`,
known provider prefixes, etc.) — it still gets `PATH`/`HOME` so the command can
run, and you can re-supply a specific value through the `env` map. A delegate
granted `workspaceAccess: "read_write"` (which already requires parent `--write`)
inherits the full environment. `maxStdoutBytes` and `maxStderrBytes` set
independent capture limits, while `maxOutputBytes` remains a shared fallback.
`{{workspaceRoot}}` and `cwd` require `"workspaceAccess": "read_write"`;
otherwise the process runs from an isolated temporary cwd and receives only the
configured arguments/stdin. The temporary cwd remains writable for normal agent
scratch files, but SparkWright forces the process sandbox to fail closed and
protect the project workspace from writes. On macOS this is an explicit
workspace deny-write guard, not a full filesystem allowlist.

To debug a configured delegate without asking the main model to choose the
tool, run it directly:

```bash
sparkwright delegates run delegate_external_cli_reviewer \
  --workspace /path/to/project \
  --goal "Inspect README.md and return one concise suggestion." \
  --session-id delegate-debug \
  --trace-level debug \
  --yes \
  --format text
```

The direct command supports ACP and external-command delegates. It does not run
internal SparkWright child-agent profiles; use the normal run loop for those.
Direct delegate runs write a session trace under
`.sparkwright/sessions/<session-id>/trace.jsonl`.

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
npm exec sparkwright -- trace report examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl --format text
```

Use session commands for integrity checks and continuation:

```bash
npm exec sparkwright -- session check <session-id> --workspace examples/repo-pilot --format text
npm exec sparkwright -- session inspect <session-id> --workspace examples/repo-pilot --compaction --format text
npm exec sparkwright -- session repair <session-id> --workspace examples/repo-pilot --dry-run
npm exec sparkwright -- session resume <session-id> "continue the investigation" --workspace examples/repo-pilot
```

Normal resume uses the saved `checkpoint.json` for the prior run. When a
checkpoint is missing, `--from-trace` is a best-effort recovery path: it
reconstructs counters from `run.json` and `trace.jsonl`, but cannot restore the
full in-memory context, pending summaries, or in-flight tool/model work. Because
the reconstruction is partial, it requires explicit `--force`:

```bash
npm exec sparkwright -- run resume <run-id> --workspace examples/repo-pilot \
  --session <session-id> --from-trace --force
```

Trace levels are:

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
