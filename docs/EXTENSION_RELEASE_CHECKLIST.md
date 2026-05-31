# Extension Release Checklist

Use this checklist before promoting experimental extension packages or examples
into a release.

## Required

- Package has a README with API shape, boundaries, and a minimal example.
- Package maps external capabilities into core primitives instead of changing
  the run loop.
- Risky side effects execute only through `ToolDefinition` and the normal
  policy and approval path.
- Public config has a JSON Schema or documented validation contract.
- Example configs are validated by `npm run schema:check`.
- Extension metadata is traceable through run metadata, tool governance, or
  documented experimental events.
- Defaults are conservative: external tools are risky or approval-gated unless
  explicitly configured otherwise.
- Unit tests cover parser/config validation, policy gates, and failure cases.
- At least one runnable example demonstrates composition with core.

## Current Experimental Packages

### `@sparkwright/skills`

- Skill manifests must include `name` and `description`.
- Unknown frontmatter is allowed for portability.
- Skill scripts must not execute as a side effect of discovery.
- `skill.load` returns a tool observation; use selected resident context for
  instructions that must not be summarized away.

### `@sparkwright/mcp-adapter`

- MCP tools must normalize into `ToolDefinition`.
- MCP tools default to approval-gated risky tools.
- Tool origin must be available through `ToolGovernance.origin`.
- Callers should close prepared MCP clients after the run.

### `@sparkwright/agent-runtime`

- Agent profiles should be capability boundaries, not orchestrators.
- `allowedTools: []` means no tools are allowed.
- Parent denies and approval requirements must constrain child profiles.
- No fallback policy means the core default policy is used.

## Full Local Gate

Run:

```bash
npm run check
```

For release smoke:

```bash
npm run release:check
```

If release smoke requires provider credentials or external services, document
which part was skipped and why.
