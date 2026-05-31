# Configuration

Sparkwright configuration is user-editable JSON shared by the CLI and TUI.
The schema is [schemas/config.schema.json](../schemas/config.schema.json).

## Load Order

Configuration is loaded in this order, with later sources overriding earlier
ones:

1. `~/.config/sparkwright/config.json`
2. `<workspace>/.sparkwright/config.json`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

The `providers` map is merged by provider key. Most other fields are replaced
wholesale by the later source.

## Minimal Config

```json
{
  "model": "deterministic/demo",
  "permissionMode": "default",
  "workspace": "."
}
```

The reserved `deterministic` provider is built in and does not need a
`providers` entry.

## OpenAI-Compatible Provider

```json
{
  "model": "openai/gpt-example",
  "providers": {
    "openai": {
      "npm": "@ai-sdk/openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "replace-me"
    }
  }
}
```

`OPENAI_API_KEY` overrides provider `apiKey` when set. `OPENAI_BASE_URL`
overrides provider `baseURL` when set.

Store config files containing API keys privately. The schema currently stores
provider keys as plaintext.

## Model Cost Metadata

Provider model entries can attach per-million-token pricing for usage reports:

```json
{
  "providers": {
    "openai": {
      "apiKey": "replace-me",
      "models": {
        "gpt-example": {
          "cost": {
            "input": 1.25,
            "output": 10,
            "cacheRead": 0.1,
            "cacheWrite": 1.25
          }
        }
      }
    }
  }
}
```

Models not listed in `models` can still run; they simply lack attached cost
metadata.

## TUI Preferences

```json
{
  "theme": "dark",
  "mouse": true,
  "keybindings": {
    "palette.open": "ctrl+k",
    "help.open": "?",
    "cancel.run": "esc",
    "quit.app": "ctrl+c"
  }
}
```

`theme`, `mouse`, and `keybindings` are TUI-only. Provider, model, permission,
and workspace settings apply to both CLI and TUI surfaces.

## Configuration And Agent Control

Treat configuration as a governed workspace resource. If an agent proposes to
modify configuration, hosts should route that change through the same workspace
write, policy, approval, artifact, and trace path used for source files.

Recommended rules:

- Provider keys and endpoint changes require explicit approval.
- Permission mode changes require explicit approval.
- Workspace root changes require explicit approval.
- TUI-only cosmetic changes may be lower risk.
- Agent-generated config diffs should be stored as artifacts.

This keeps configuration changes inspectable and recoverable instead of turning
settings into invisible prompt state.
