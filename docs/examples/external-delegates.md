# External Delegate Examples

These examples show project-local configuration for delegating a bounded task to
a local subprocess. The executable names are placeholders; replace them with
commands installed on the host machine.

## External Command

Use `metadata.externalCommand` when the delegate is exposed as a normal CLI:

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
              "args": ["run", "--workspace", "{{workspaceRoot}}", "{{goal}}"],
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
          "toolName": "delegate_external_cli_reviewer",
          "requiresApproval": true
        }
      ]
    }
  }
}
```

`args` keep argv semantics; shell expansion is not part of the configuration
surface. Supported template values are `{{goal}}`, `{{metadataJson}}`, and
`{{workspaceRoot}}`. `{{workspaceRoot}}` and `cwd` require
`"workspaceAccess": "read_write"`; without it, SparkWright runs the subprocess
from an isolated writable temporary cwd and fails closed unless the platform
sandbox can protect the project workspace from writes. This does not turn the
macOS deny-list backend into a general filesystem allowlist. External-command
delegates use the same `shell.sandbox` launch substrate as the built-in shell
tool and workflow-hook commands.

Use `envMode: "explicit"` when the child process should receive only the
configured environment:

```json
{
  "metadata": {
    "externalCommand": {
      "command": "/usr/local/bin/agent-cli",
      "args": ["run", "{{goal}}"],
      "env": {
        "AGENT_HOME": "/tmp/agent-home"
      },
      "envMode": "explicit",
      "input": "none"
    }
  }
}
```

## Direct Debug Run

Run a configured delegate directly without asking the main model to choose the
tool:

```bash
sparkwright delegates run delegate_external_cli_reviewer \
  --workspace /path/to/project \
  --goal "Inspect README.md and return one concise suggestion." \
  --session-id delegate-debug \
  --trace-level debug \
  --access-mode bypass \
  --format text
```

The command still goes through the delegate approval gate. It writes a trace to
`.sparkwright/sessions/<session-id>/trace.jsonl`.

Delegates with `workspaceAccess: "read_write"` also require the parent run (or
direct debug command) to use a write-capable access mode. For trusted direct
debugging, pass `--access-mode bypass`.

## ACP Stdio

Use `metadata.acp` when the delegate speaks ACP over stdio:

```json
{
  "capabilities": {
    "agents": {
      "profiles": [
        {
          "id": "external_acp_reviewer",
          "name": "External ACP Reviewer",
          "metadata": {
            "acp": {
              "transport": "stdio",
              "command": "agent-cli",
              "args": ["acp"],
              "workspaceAccess": "read_write",
              "timeoutMs": 120000
            }
          }
        }
      ],
      "delegateTools": [
        {
          "profileId": "external_acp_reviewer",
          "toolName": "delegate_external_acp_reviewer",
          "requiresApproval": true
        }
      ]
    }
  }
}
```

ACP delegates default to `envMode: "explicit"`: the child receives only a
minimal process environment plus configured `env`. Add `envMode: "inherit"` to
the `metadata.acp` block only when the ACP worker must see the parent
environment.
