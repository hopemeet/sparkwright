# Real Regression Grouped Config

## Record

- Pattern ID: `real-regression-grouped-config`
- Status: `active`
- First seen: 2026-06-23
- Last seen: 2026-06-23
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     0 |
| `test_bug`              |     2 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

`npm run regression:real-model` skips `openai/gpt-5.4-nano` even though the
normal CLI can resolve that model from the user's config and reports
`config.providers.openai.models` in redacted `config inspect` output.

## Root Cause

The first failure was an older harness lookup that did not recognize grouped
`identity.providers` config.

After adding a shared helper, the 2026-06-23 rerun still skipped because
`scripts/regression-real-model.mjs` ignores the helper's
`{ isolateConfig: false }` option. Its `runCommand` always overrides
`XDG_CONFIG_HOME` with the empty isolated config directory before availability
checking, so `config inspect` cannot see the user config.

## Diagnostic Move

Compare the harness config lookup with CLI model resolution:

```bash
SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano npm run regression:real-model
node packages/cli/dist/index.js config inspect --workspace . --format json
node packages/cli/dist/index.js capabilities inspect --model openai/gpt-5.4-nano --format json
```

If the first command skips and the second resolves the model, classify as
`test_bug`.

As a temporary diagnostic only, setting `SPARKWRIGHT_CONFIG` to the real config
file lets the script get past availability checking:

```bash
SPARKWRIGHT_CONFIG="$HOME/.config/sparkwright/config.yaml" \
  SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-nano \
  SPARKWRIGHT_KEEP_REAL_REGRESSION=1 \
  npm run regression:real-model
```

## Prevention

- Share model/config resolution code between real regression scripts and CLI
  execution, or add explicit support for `identity.providers`.
- Keep real regression scripts on the same config-schema route as
  `capabilities inspect`.
- Honor `options.isolateConfig === false` in
  `scripts/regression-real-model.mjs` the same way
  `scripts/regression-real-skill-capabilities.mjs` already does.

## Related

- Coverage: [../coverage/config-schema.md](../coverage/config-schema.md)
- Run notes:
  [../runs/2026-06-23-broad-real-cli-tui-partial.md](../runs/2026-06-23-broad-real-cli-tui-partial.md)
