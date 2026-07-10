# Focused Gates

Focused gates are the small, high-signal checks to run before considering a
local change healthy. They are intentionally cheaper than `npm run check`.

## Gate Selection

1. Run the package-local tests for the directly changed package.
2. Rebuild any package whose `exports` point to `dist` before downstream
   package tests import it.
3. Run one downstream consumer test when the changed contract crosses a package
   boundary.
4. Run schema generation/checks when generated schemas or protocol shapes
   changed.
5. Run scenario-specific tests when prompt/model/capability sensitivity matters.

## Common Focused Gates

### Shell Contract Gate

```bash
npm --workspace @sparkwright/shell-tool test
npm --workspace @sparkwright/shell-tool run build
npm --workspace @sparkwright/host test -- test/tools.test.ts
```

Add:

```bash
npm --workspace @sparkwright/host test -- test/config.test.ts
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
```

when shell config changes.

### Trace Report Gate

```bash
npm --workspace @sparkwright/core test -- test/trace.test.ts
```

Add CLI trace fixtures if report/timeline/summary output changes.

### Capability Inspect Gate

```bash
npm --workspace @sparkwright/protocol run build
npm --workspace @sparkwright/host run build
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
```

### CLI Outcome Gate

```bash
npm --workspace @sparkwright/cli test -- test/run-outcome.test.ts
npm --workspace @sparkwright/cli test -- test/run-outcome-consistency.test.ts
```

### TUI Rendering Gate

```bash
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts
npm --workspace @sparkwright/tui test -- test/status-bar-render.test.tsx
```

## When Focused Gates Are Not Enough

Broaden beyond focused gates when:

- public protocol or config schema changed
- package exports or generated `dist` changed
- run loop, approval, or workspace write semantics changed
- multiple packages consume a new field
- a test failure was caused by `model_variance`, `prompt_underspecified`, or
  environment sensitivity and the focused gate did not exercise the intended
  scenario
