# ACP MCP Untrusted Project Sandbox Grant

## Record

- Pattern ID: `acp-mcp-untrusted-project-sandbox-grant`
- Status: `fixed`
- First seen: 2026-08-30
- Last seen: 2026-08-30
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     0 |
| `test_bug`              |     1 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

An ACP round-trip MCP fixture passes on macOS but capability inspection omits
the injected MCP tool on Linux when bubblewrap is installed. The MCP server
status is failed before tool listing completes.

## Root Cause

The fixture placed an external `node_modules` read grant in workspace project
config. Capability inspection correctly treats an untrusted project's config
as restricted and removes sandbox fields that widen access. macOS's deny-list
guard could still read the dependency tree, while Linux's bind allowlist could
not, exposing the invalid fixture assumption.

## Diagnostic Move

When a process-backed fixture fails only on Linux, inspect its effective MCP
sandbox status and the trust layer that supplied every positive filesystem
grant. Do not assume a project config grant survives restricted loading merely
because the same fixture passes under the macOS backend.

## Prevention

- Put fixture-only positive sandbox grants in an isolated trusted user config.
- Keep project config untrusted when the behavior under test does not include a
  trust grant.
- Exercise process-backed MCP fixtures in both Linux and macOS CI jobs.
- Do not disable or weaken the production sandbox to make a fixture portable.

## Current Evidence

The session-scoped ACP MCP focused test passes 1/1 with `CI=true` after moving
the SDK read grant to its isolated XDG user config. Cross-platform confidence
remains owned by the Node 22/24 Linux and macOS release-check matrix.

## Related

- Coverage: [../coverage/shell.md](../coverage/shell.md)
- Route: [../routes/release-gates.md](../routes/release-gates.md)
