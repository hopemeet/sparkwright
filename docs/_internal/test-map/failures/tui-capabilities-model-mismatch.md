# TUI Capabilities Model Mismatch

## Record

- Pattern ID: `tui-capabilities-model-mismatch`
- Status: `retired`
- First seen: 2026-06-22
- Last seen: 2026-06-22
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

The TUI header shows the active `--model` override, but `/capabilities` reports
the configured default model.

## Root Cause

Likely a presentation/source mismatch: the pinned status/header uses the
runtime-selected model, while the capabilities panel reads the merged config
snapshot before CLI/TUI model override is applied.

## Diagnostic Move

Launch TUI with a non-default `--model`, open `/capabilities`, and compare the
header model with the panel's `Model:` line.

## Prevention

- Make the capabilities panel model source match the active runtime model.
- Add a TUI render or PTY test that uses a model override and asserts the panel
  and status/header agree.

## Resolution

- Fixed 2026-06-23: host `capability.inspect` accepts an active model payload,
  server validation preserves it, and TUI `RunController.inspectCapabilities()`
  sends the request-sourced active model so the host snapshot matches the TUI
  header/status model.
- Regressions:
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts test/protocol.test.ts -t "capability inspect|capability inspection|host client run request"`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts -t "capabilities with the explicit model selection"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capability inspect"`.

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
