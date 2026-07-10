# Capability Sensitivity Matrix

Enabled capabilities change both what the model can do and what evidence should
exist. Scenario specs must record capability posture.

## Capability Dimensions

| Dimension                 | Why It Matters                                                  |
| ------------------------- | --------------------------------------------------------------- |
| `tools.use`               | selects high-level tool families before model descriptors exist |
| `tools.allowed`           | narrows to concrete names                                       |
| `tools.disabled`          | removes concrete names even if selected                         |
| `tools.defer`             | changes schema loading, not permission                          |
| `--write` / `shouldWrite` | gates workspace-write tools and delegates                       |
| `permissionMode`          | affects approval and policy behavior                            |
| shell approvals           | changes whether safe shell can run non-interactively            |
| skills                    | add context, tools, preprocessing, and failure modes            |
| MCP                       | adds external tools and startup/schema-loading state            |
| agents/delegates          | add child runs, depth, finality, and write rollups              |
| hooks/verification        | add deterministic checks and stop gates                         |

## Assertion Guidance

When a capability is disabled:

- assert absence from capability inventory or model tool descriptors
- assert denied/unavailable behavior when directly requested

When a capability is enabled but gated:

- assert descriptor shows potential capability
- assert current run policy still gates execution
- do not treat descriptor presence as unconditional permission

When a capability adds external process access:

- assert boundary markers or sandbox metadata
- do not count untracked write-capable boundaries as managed writes

## Common Pitfalls

- Testing a delegate write without `shouldWrite: true`.
- Assuming shell is harmless because the leading command is read-like.
- Adding MCP to a scenario without deciding startup mode and schema-load mode.
- Forgetting configured in-process delegates receive an effective child tool set
  derived from both profile and parent tool filters.
