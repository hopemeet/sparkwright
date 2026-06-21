# Coding Tools

## Purpose

Coding tools are the model-facing file, search, edit, patch, shell, skill, task,
agent, MCP, and cron tools assembled for local repository automation.

See also [../maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md), [../maps/safety/workspace-writes.md](../maps/safety/workspace-writes.md), and [../maps/safety/shell.md](../maps/safety/shell.md).

## Main Files

- `packages/host/src/toolset.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/tool-selectors.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/coding-tools/src/*`
- `packages/core/src/tools.ts`
- `packages/core/src/workspace.ts`
- `packages/core/src/anchored-edit.ts`

## Owns / Does Not Own

Owns:

- concrete tool definitions exposed by host and CLI paths
- host catalog classification for model-facing coding/search/edit tools
- validation of tool arguments near tool boundaries
- mapping managed capability mutations to safe tool surfaces
- shell tool wrapping and promotion behavior in host

Does not own:

- core policy decisions
- approval UX
- run loop scheduling
- trace file format

## Contracts

- Workspace mutation must go through core policy, approval, event, and artifact paths.
- `write_file` is the whole-file create/replace surface for new files and
  nested paths; it uses the same workspace write path as anchored edits and
  patches and belongs to the `workspace.write` selector.
- Shell is classified by `@sparkwright/shell-tool` and gated by policy/approval.
- Managed capability files should use dedicated tools instead of raw shell writes.
- Tool results should be compact enough for model context and trace summaries.
- Project-context file-tool guidance tells the model to run relevant known
  verification after successful writes instead of re-reading just-written or
  unchanged files.
- Main, read-only child, and CLI diagnostic coding tool exposure should flow through the host tool catalog before reaching runtime, direct-core/cron runs, and capability snapshots.
- Top-level `tools.use` filters the catalog by source/capability selectors
  before model-facing descriptors are built; `tools.allowed` and
  `tools.disabled` then filter concrete tool names, and `tools.defer` only
  affects schema loading for the remaining tools.
- Coding-source tools must stay classified into exactly one workspace selector
  list (`workspace.read` or `workspace.write`) in `tool-selectors.ts`.

## Consumers

- Core tool orchestration.
- Host runtime tool catalog and assembly.
- CLI capability inspection, direct-core diagnostics, and cron runner setup.
- Trace summary/timeline diagnostics.

## Change Checklist

- Check policy metadata and side-effect declarations for new tools.
- Check trace payload size and result summarization.
- Check approval and workspace write events.
- Check CLI/TUI rendering for new tool event patterns.

## Known Debts

- Repeated tool calls and noisy reads are current trace pain points.
- Some tools live across multiple packages, so "tool behavior" is not one file; `tool-catalog.ts` is the routing point for host exposure, not the owner of each tool body.
- The retired direct-core `append_file` harness should stay retired; write
  smokes should use `write_file`, `edit_anchored_text`, or `apply_patch`.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/coding-tools/src/index.ts`, `packages/coding-tools/test/index.test.ts`, `packages/host/src/tool-catalog.ts`, `packages/host/src/tool-selectors.ts`, `packages/project-context/src/index.ts`, `packages/project-context/test/index.test.ts`, `packages/cli/src/runners/direct-core-runner.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/project-context test -- test/index.test.ts`; `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/event-format.test.ts`; `npm run build`; `npm run check:dist-fresh`.
