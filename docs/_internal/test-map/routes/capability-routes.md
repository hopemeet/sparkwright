# Capability Routes

Use this page when the change is best described by behavior rather than file
path. Combine with [package-routes.md](package-routes.md).

## Shell Execution

Covers command safety, cwd/path scope, foreground timeout, promotion, sandbox
metadata, and shell mutation audit.

Focused route:

```bash
npm --workspace @sparkwright/shell-tool test
npm --workspace @sparkwright/shell-tool run build
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Add config/schema checks when `shell.*` config changes:

```bash
npm --workspace @sparkwright/host test -- test/config.test.ts
npm run schema:generate
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
```

Scenario refs:

- [../scenarios/shell-foreground-timeout.yaml](../scenarios/shell-foreground-timeout.yaml)

Coverage ref:

- [../coverage/shell.md](../coverage/shell.md)

## Trace Diagnostics

Covers summary, timeline, report, verify, and session inspect diagnostics.

Focused route:

```bash
npm --workspace @sparkwright/core test -- test/trace.test.ts
```

Add CLI trace fixtures when text/JSON output changes:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
```

Scenario refs:

- [../scenarios/trace-subagent-write-verify.yaml](../scenarios/trace-subagent-write-verify.yaml)

Coverage ref:

- [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)

## Facade And Import Integrity

Covers runtime value cycles, implementation-to-facade reverse imports, and
workspace package discovery during mechanical module splits.

Focused route:

```bash
node scripts/check-import-graph.mjs
node scripts/check-package-boundaries.mjs
node scripts/check-internal-imports.mjs
```

Treat any runtime value SCC or new sibling implementation import of a listed
facade as a hard failure. Existing type-only SCCs are diagnostic debt, not
permission to add another cycle.

## Capability Inspect

Covers host `capability.inspect`, CLI `capabilities inspect`, capability
snapshot protocol shape, and capability panels.

Focused route:

```bash
npm --workspace @sparkwright/protocol run build
npm --workspace @sparkwright/host test -- test/run-security-plan.test.ts test/client-run.test.ts test/protocol.test.ts
npm --workspace @sparkwright/host test -- test/run-policy.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "direct-core|run resume defaults"
npm --workspace @sparkwright/host run build
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
```

Add TUI panel tests when visible panel rendering changes:

```bash
npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx
```

Scenario refs:

- [../scenarios/capability-inspect-shell.yaml](../scenarios/capability-inspect-shell.yaml)

Coverage refs:

- [../coverage/config-schema.md](../coverage/config-schema.md)
- [../coverage/shell.md](../coverage/shell.md)

## Agents And Delegates

Covers dynamic `spawn_agent`, configured in-process delegates, external
delegates, depth limits, finality, child tool catalogs, and write rollups.

Focused route:

```bash
npm --workspace @sparkwright/agent-runtime run build
npm --workspace @sparkwright/core test -- test/run.test.ts
npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts test/spawn-agent.test.ts test/agent-task-runner.test.ts test/acp-child-agent.test.ts test/external-command-agent.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "configured external command delegate directly"
npm --workspace @sparkwright/core test -- test/trace.test.ts
```

Build agent-runtime before Host when its AgentTool contract changes; Host tests
consume the workspace package's built output, and a stale dist can otherwise
look like a Host behavior failure.

Add CLI delegate tests when `delegates run` or capability descriptor output
changes.

Coverage ref:

- [../coverage/agents.md](../coverage/agents.md)

## TUI First Screen And Live Rendering

Covers committed scrollback header, pinned live status, event cards, and
presentation summaries.

Focused route:

```bash
npm --workspace @sparkwright/tui test -- test/status-bar-render.test.tsx test/event-stream-render.test.ts
```

Scenario refs:

- [../scenarios/tui-first-screen-header.yaml](../scenarios/tui-first-screen-header.yaml)

Coverage ref:

- [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
