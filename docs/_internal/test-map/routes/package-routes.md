# Package Routes

Use this page after project-map identifies the touched package/file. Routes are
focused defaults, not a substitute for judgment. Broaden when a change crosses
contracts, public schema, package exports, or generated `dist`.

## Core

### `packages/core/src/run.ts`

Run:

```bash
npm --workspace @sparkwright/core test -- test/run.test.ts
npm --workspace @sparkwright/core test -- test/runtime-guardrails.test.ts
```

Broaden to `test/trace.test.ts` when run terminal payloads, tool outcomes,
verification summaries, or trace snapshots change.

### `packages/core/src/trace-diagnostics.ts`

Run:

```bash
npm --workspace @sparkwright/core test -- test/trace.test.ts
```

Also run CLI trace fixture tests when text/JSON output changes:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
```

Sensitivity:

- Multi-agent traces use run-local `sequence`; cross-run ordering assertions
  should use trace append order or timeline projection rules.
- Standard trace level folds high-volume progress events.

## Shell Tool

### `packages/shell-tool/src/*`

Run:

```bash
npm --workspace @sparkwright/shell-tool test
```

If the public package export, output schema, timeout/promotion behavior, or cwd
semantics changed, rebuild before downstream tests:

```bash
npm --workspace @sparkwright/shell-tool run build
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Reason: downstream packages import `@sparkwright/shell-tool` through package
exports, which point at `dist`.

## Host

### `packages/host/src/config.ts` or `config-zod-schema.ts`

Run:

```bash
npm --workspace @sparkwright/host test -- test/config.test.ts
npm run schema:check
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
```

Use `npm run schema:generate` instead when the generated schema artifacts are
intended to change, then run `npm run schema:check`.

If `CapabilitySnapshot` or inspect output changed, also run:

```bash
npm --workspace @sparkwright/protocol run build
npm --workspace @sparkwright/host run build
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
```

### `packages/host/src/shell.ts`

Run:

```bash
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Also run shell-tool tests when behavior belongs to command parsing, path scope,
foreground timeout, promotion, or shell output schema.

### `packages/host/src/runtime.ts`

Run the focused suite matching the changed surface:

```bash
npm --workspace @sparkwright/host test -- test/protocol.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts
npm --workspace @sparkwright/host test -- test/config.test.ts
```

Broaden to CLI/TUI tests when capability snapshots, protocol responses, or
run summaries change.

## Server Runtime

### Durable workflow channels and adapters

Run:

```bash
npm --workspace @sparkwright/agent-runtime test -- test/workflow-channels.test.ts test/workflow-control.test.ts
npm --workspace @sparkwright/server-runtime test -- test/workflow-channel-coordinator.test.ts test/index.test.ts
npm --workspace @sparkwright/host test -- test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/sdk-core test -- test/client.test.ts
npm --workspace @sparkwright/im-gateway test
npm --workspace @sparkwright/tui test -- test/workflow-actions.test.ts test/sdk-cutover.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"
```

Use deterministic clocks and stable delivery/idempotency keys. Assert that
failed delivery remains retryable, terminal receipt suppresses redelivery, and
two bindings responding to one wait produce one canonical Package D winner.

### `packages/server-runtime/src/workflow-service.ts` or workflow detach/service

Run:

```bash
npm --workspace @sparkwright/server-runtime test
npm --workspace @sparkwright/host test -- test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"
```

Keep service instance/worker heartbeat tests deterministic. Detached success
must be asserted only after durable outcome publication; unavailable/stale
service must fail before creating workflow storage.

## CLI

### `packages/cli/src/run-outcome.ts`

Run:

```bash
npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts
npm --workspace @sparkwright/cli test -- test/run-outcome-consistency.test.ts
```

If terminal text changes, run the specific CLI test slice that renders it.

### `packages/cli/src/cli.ts`

Choose a focused slice first:

```bash
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "session"
```

Then broaden to the full CLI test file when command parsing or shared helpers
are touched.

## TUI

### `packages/tui/src/state/run-controller.ts`

For execution identity, approval routing/cleanup, or session mutation guards:

```bash
npm --workspace @sparkwright/tui test -- test/run-controller-approval.test.ts test/run-controller-session-mutation.test.ts test/sdk-cutover.test.ts
npm --workspace @sparkwright/tui run typecheck
```

Broaden to the full TUI suite when controller return values or session/workflow
actions change.

For independent workflow job session identity, also run:

```bash
npm --workspace @sparkwright/host test -- test/client-run.test.ts test/workflows.test.ts test/protocol.test.ts
npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"
```

### Rendering components

For `components/event-stream.tsx`, `components/status-bar.tsx`, or
presentation helpers:

```bash
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts
npm --workspace @sparkwright/tui test -- test/status-bar-render.test.tsx
```

For transcript changes:

```bash
npm --workspace @sparkwright/tui test -- test/transcript.test.ts
```

Rendering tests often use fake stdout. Assert visible invariants, not raw Ink
escape sequences.
