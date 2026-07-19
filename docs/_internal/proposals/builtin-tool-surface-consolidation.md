# Built-in Tool Surface Consolidation

Status: Implemented
Date: 2026-07-16

## Decision

SparkWright exposes one model-facing name for each public built-in tool:

| name    | purpose                        |
| ------- | ------------------------------ |
| `read`  | read workspace text            |
| `write` | create or replace a file       |
| `edit`  | apply a unified-diff edit      |
| `bash`  | run commands, scripts, and git |
| `glob`  | match paths                    |
| `grep`  | search content                 |

These names are the registered `ToolDefinition.name` values, not wrappers over
another callable surface. Removed names are rejected as unknown tools. Core,
Host, configuration, hooks, policy, approval, trace producers, capability
inspection, prompts, and tests all use the same names.

`shell` remains an internal catalog source, execution runtime kind, and approval
resource category where that word describes the capability rather than a tool
identity. It is not a model-callable name or a `tools.use` selector. The
selector for that catalog source is `bash`.

## Ownership

- `packages/host/src/tool-identities.ts` owns stable public identity and exposure
  metadata.
- `packages/host/src/tool-selectors.ts` owns selector compilation. It accepts
  `workspace.read`, `workspace.write`, `bash`, `planning`, `skills`, `agents`,
  `tasks`, `cron`, `mcp`, and `mcp:<server>`.
- `packages/core/src/tools.ts` registers exact callable names. It does not own an
  alias registry or canonicalization pass.
- `packages/host/src/tool-catalog.ts` owns catalog source classification and is
  flattened only after filtering and capability projection.

## Exposure

The stable public set is `read`, `write`, `edit`, `bash`, `glob`, and `grep`.
Advanced tools remain discoverable through the existing deferred-loading and
`tool_search` mechanism. `skill_load` and `tool_search` are discovery
infrastructure rather than public business tools.

`defaultExposureTier` is stable product metadata. `effectiveLoading` describes
only one run's eager/deferred state. Changing `tools.defer` does not change a
tool's stable tier.

The anchored verified-edit pair, `read_anchored_text` and
`edit_anchored_text`, remains a related advanced pair. Plain `read` stays a
text reader and `edit` stays the patch protocol; the pair is not silently
substituted for either public tool.

## Configuration contract

- `tools.use` contains selectors.
- `tools.allowed`, `tools.disabled`, and `tools.defer` contain exact concrete
  tool names.
- Unknown selectors and removed tool names fail closed; they are not normalized.
- `tool_search` is derived infrastructure and has no selector. It is appended
  when the filtered catalog still contains deferred tools and can be disabled
  only by its exact name.

## Capability inspection

Inspection reports catalog source, governance, `canonicalName`, exposure tier,
related/required tools, and effective loading. Because callable aliases no
longer exist, inspection does not emit an alias list.

## Deferred work

Network tools and a model-facing user-question tool require separate security
and interaction designs. They are not part of the built-in naming decision.
The existing deferred discovery mechanism should be reused if those tools are
added; no second visibility taxonomy should be introduced.

## References

- [`agent-access-config-redesign.md`](agent-access-config-redesign.md)
- [`skill-runtime-v1-redesign.md`](skill-runtime-v1-redesign.md)
- [`../project-map/maps/runtime/tool-orchestration.md`](../project-map/maps/runtime/tool-orchestration.md)
