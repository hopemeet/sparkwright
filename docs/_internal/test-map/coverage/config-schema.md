# Config Schema Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-06-29
- Evidence source: 2026-06-23 host config tests, CLI schema drift/XDG tests,
  generated schema validation, CLI config/capabilities subsets, and manual
  `capabilities inspect` with `openai/gpt-5.4-nano`, and 2026-06-29
  real-mini follow-up checks for tool filters, disabled discovery, and nested
  CLI help.

## Covered

- 2026-07-17 Agent exposure cleanup verifies the retired
  `exposeChildrenAsDelegates` key is rejected as unknown and absent from the
  generated schema; canonical exposure remains `exposure`, `pinnedDelegates`,
  and profile `exposeAsDelegate`.
- Host config loading merges project, user, and default config layers.
- Tool selection supports `use`, `allowed`, `disabled`, and `defer`.
- Shell foreground timeout and sandbox config flow into capability inspect.
- Agent profiles and delegate tools are represented in capability snapshots.
- Generated schemas are checked by repository scripts.
- CLI `capabilities inspect` resolves grouped `identity.providers` config for
  the real model path without leaking secret values.
- 2026-06-29 fixes verified that `tools.disabled: [tool_search]` no longer
  leaves prompt text instructing the model to call disabled discovery, and that
  `run resume --help` exits through help before config/session/trace setup.

## Weak Or Untested

- Developer user config can leak into real CLI tests unless XDG paths are
  isolated.
- Schema changes may pass host tests but fail packaged CLI validation when the
  generated artifacts are stale.
- Capability inspect output is both human-facing text and JSON; both formats
  need coverage when fields move.
- Provider/model config has secret-bearing fields. Tests should assert presence
  or redacted shape, never values.
- `scripts/regression-real-model.mjs` still skips configured real models
  because its command runner ignores `isolateConfig: false` during availability
  probing and points `XDG_CONFIG_HOME` at an empty isolated directory.
- Nested CLI help paths beyond `run resume --help` should still be covered when
  adding new subcommands; help must remain side-effect-free before config,
  session allocation, model setup, or trace creation.

## Focused Route

```bash
npm --workspace @sparkwright/host test -- test/config.test.ts
npm run schema:check
npm --workspace @sparkwright/cli test -- test/config-schema.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capabilities inspect"
```

Build affected packages before CLI/package-boundary checks when generated
schemas or exported `dist` files changed:

```bash
npm --workspace @sparkwright/host run build
npm --workspace @sparkwright/cli run build
```

## Scenario Links

- [../scenarios/capability-inspect-shell.yaml](../scenarios/capability-inspect-shell.yaml)

## Sensitivity Links

- [../matrices/environment-sensitivity.md](../matrices/environment-sensitivity.md)
- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)

## Stale Triggers

- `packages/host/src/config.ts`
- `packages/host/src/config-zod-schema.ts`
- `scripts/generate-config-schema.ts`
- `scripts/copy-cli-schemas.mjs`
- generated config schema files
- capability snapshot protocol changes

## Failure Links

- [../failures/shell-dist-skew.md](../failures/shell-dist-skew.md)
- [../failures/real-regression-grouped-config.md](../failures/real-regression-grouped-config.md)
- [../failures/capability-delta-disabled-tool-search.md](../failures/capability-delta-disabled-tool-search.md)
- [../failures/cli-run-resume-help-starts-run.md](../failures/cli-run-resume-help-starts-run.md)
