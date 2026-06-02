# Configuration

Use this reference for config paths, provider setup, model selection,
permissions, workspace selection, and tool loading settings.

## Files And Precedence

The config schema is `schemas/config.schema.json`.

Config is loaded in this order, with later sources overriding earlier sources:

1. `~/.config/sparkwright/config.json`
2. `<workspace>/.sparkwright/config.json`
3. `$SPARKWRIGHT_CONFIG`
4. CLI flags and environment variables

`providers` is merged by provider key. Most other fields are replaced by the
later source.

## Scaffold

```bash
npm exec sparkwright -- init
```

This scaffolds `~/.config/sparkwright/config.json`.

## Common Fields

- `model`: active model in `provider/model` form. The reserved
  `deterministic` provider is built in.
- `providers`: named OpenAI-compatible provider definitions.
- `permissionMode`: default run permission mode.
- `workspace`: default workspace root.
- `theme`, `mouse`, `keybindings`: TUI-only preferences.

## Provider Example

```json
{
  "model": "openai/example-model",
  "providers": {
    "openai": {
      "npm": "@ai-sdk/openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "replace-me"
    }
  }
}
```

`OPENAI_API_KEY` overrides provider `apiKey`. `OPENAI_BASE_URL` overrides
provider `baseURL`. Proxy variables `HTTPS_PROXY`, `https_proxy`,
`HTTP_PROXY`, and `http_proxy` are passed to the OpenAI-compatible provider
path by the CLI.

Store files containing provider keys privately. Keys are plaintext in config.

## Cost Metadata

Per-model cost metadata is optional and used for usage/cost reporting:

```json
{
  "providers": {
    "openai": {
      "apiKey": "replace-me",
      "models": {
        "example-model": {
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

Models not listed still run if the provider accepts them.

## Permission Modes

- `plan`: prefer read-only planning.
- `default`: normal approval behavior for risky actions.
- `accept_edits`: accept workspace edits while preserving other policy gates.
- `dont_ask`: avoid interactive approval prompts where the host permits it.
- `bypass_permissions`: trusted-host escape hatch.

Deny rules should remain authoritative. Skills, MCP servers, and agent profiles
do not grant authority by themselves.

## Tools Config

The CLI can update tool loading settings:

```bash
npm exec sparkwright -- tools list --format text
npm exec sparkwright -- tools enable <pattern...>
npm exec sparkwright -- tools disable <pattern...>
npm exec sparkwright -- tools defer <pattern...>
```

Use `defer` for tools that should be discovered lazily through `tool_search`
instead of being loaded into the initial prompt.

## Agent-Written Config Changes

When an agent proposes config changes, route them through governed workspace
write behavior:

- provider key or endpoint changes require explicit approval
- permission mode changes require explicit approval
- workspace root changes require explicit approval
- tool enable/disable/defer changes should be visible in trace
- generated config diffs should be stored as artifacts where possible
