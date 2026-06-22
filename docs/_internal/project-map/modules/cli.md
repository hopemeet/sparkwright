# CLI

## Purpose

`@sparkwright/cli` is the command-line product surface. It starts host or direct-core runs, exposes trace/session diagnostics, manages capabilities, and provides local maintainer workflows.

See also [../maps/trace/summary-timeline-verify.md](../maps/trace/summary-timeline-verify.md) and [../maps/session/resume-replay.md](../maps/session/resume-replay.md).

## Main Files

- `packages/cli/src/cli.ts`
- `packages/cli/src/event-format.ts`
- `packages/cli/src/run-outcome.ts`
- `packages/cli/src/runners/direct-core-runner.ts`
- `packages/cli/src/runners/host-runner.ts`
- `packages/cli/src/cli-approval.ts`
- `packages/cli/test/cli.test.ts`
- `packages/cli/test/fixtures/trace-diagnostics/*`
- `scripts/copy-cli-schemas.mjs`

## Owns / Does Not Own

Owns:

- command parsing and text/JSON formatting
- CLI approval defaults and non-interactive behavior
- trace commands: `summary`, `events`, `timeline`, `report`, `verify`
- session commands: `summary`, `check`, `repair`, `compact`, `resume`
- local capability management commands
- user-facing diagnostics such as `doctor paths`

Does not own:

- core event semantics
- host protocol contracts
- TUI transcript export
- provider internals

## Contracts

- `sparkwright trace *` reads a `trace.jsonl` path.
- Top-level help must list every trace diagnostic subcommand, including
  `trace report`; subcommand usage remains owned by command-specific handlers.
- `sparkwright session *` resolves a session id under the session root.
- `sparkwright session compact` calls the host session compaction path and
  prints `freedChars`, measurement regime/savings ratio, optional
  `skippedReason`, optional `warnings`, and the artifact path in JSON/text
  formats. `--llm` explicitly requests the Tier 3 path; provider/scripted model
  refs use the model-backed summarizer, while deterministic refs use the
  preview path and return a warning.
- Nested command help such as `sparkwright capabilities inspect --help` prints
  the subcommand usage without executing the subcommand.
- Run flags expose `--trace-level standard|debug`.
- `sparkwright run` accepts repeatable `--image <path>` arguments, reads local
  images as base64 protocol `input.parts`, and passes them through host mode;
  direct-core diagnostics receive the same parts as context items.
- `run resume --from-trace` reconstructs only a partial checkpoint and still requires force when incomplete.
- `capabilities inspect` is the runtime tool inventory entry point, sourced
  from host `capability.inspect` / tool catalog snapshots. Delegate tool
  origins, including `in_process:<profileId>`, come from
  `agents.delegateTools`; CLI should not maintain a separate local in-process
  delegate inventory.
- `doctor paths` reports installation, install version/current target, CLI/TUI/ACP
  entrypoints, user config/capability roots, user state including host crash
  logs, and workspace state without starting a run.
- `sparkwright init` and `sparkwright init --project` create YAML starter
  configs by default when no same-layer config exists; they refuse to overwrite
  existing `config.json`, `config.yaml`, or `config.yml`. First interactive
  runs with no loaded config auto-scaffold the user YAML once and stop before
  model execution, using the same non-overwriting template as `init`. YAML
  starters include a `yaml-language-server` schema directive pointing at the
  local schema file shipped under the installed CLI's `dist/schemas`.
- `sparkwright config validate` combines host loader/semantic diagnostics with
  JSON Schema validation of each loaded config file. The CLI package build
  copies root `schemas/*.schema.json` into `dist/schemas` so installed CLIs can
  validate without a checkout of the source tree. The root config schema is
  generated from the host Zod schema before schema checks.
- `tools allow`, `tools disable`, and `tools defer` write local tool config;
  they preserve an existing JSON/YAML file in the selected user/project layer.
  There is no `tools list` command. `allow` appends to `tools.allowed`;
  disabled entries still win over selector/allowed entries. There is no
  `tools use` write command; users edit `tools.use` directly and inspect the
  effective inventory with `capabilities inspect`.
- `agents create` can write `use` selectors as well as concrete
  `allowedTools`; it preserves an existing YAML project config and otherwise
  creates the default project JSON file for direct create flows.
- `approvals.cronMode` supplies the default `permissionMode` for cron commands;
  CLI flags still override it.
- direct-core and cron run paths call `createConfiguredCliTools`, which now flattens the host `createCliDiagnosticToolCatalog` profile; do not add ad hoc CLI-only tools there. The deterministic direct-core write fallback uses `write_file` when the target file does not exist.
- Run completion summaries separate controlled workspace writes, capability
  mutations, tool-reported capability changes, and sub-agent write rollups.
  They also separate untracked write-capable external command processes from
  managed workspace writes and append a static disclosure when host metadata
  says configured MCP servers have explicit workspace cwd; these are boundary
  or configuration posture signals, not filesystem side-effect detection.
- `capabilities inspect` prints delegate conditional approval facts from host
  snapshots (`approvalRequiredUnderCurrentRun`, `approvalReasons`,
  `approvalRunOptions`) instead of treating the legacy `requiresApproval` echo
  as an unconditional runtime prediction.
- Live run/resume output is a human diagnostic stream, not the raw trace. By
  default it aggregates high-volume event types listed by protocol
  `isLiveDebugNoiseEventType()` into `live.debug.suppressed` summary lines
  while still recording those events in `trace.jsonl` and exposing them through
  `sparkwright trace events`. `--verbose` prints those live debug events
  individually.
- `check:dist-fresh` relies on root `npm run build` and each workspace build
  script writing a root `.sparkwright-build-stamp.json` after successful
  builds. Stamps stay outside `dist/` so npm package files do not include them,
  while targeted `npm run build --workspace ...` still avoids false stale
  reports when TypeScript emits no changed output.
- Text output is a human diagnostic surface; JSON output should remain machine-parseable.
- Fixture snapshots under `packages/cli/test/fixtures/trace-diagnostics/`
  lock byte-for-byte CLI text/JSON output for `trace summary`, `timeline`,
  `report`, and `verify` over a stable trace.

## Consumers

- Local developers.
- Maintainer scripts and golden path docs.
- Tests that validate command behavior and output.

## Change Checklist

- Update `README.md` and user guides when commands or flags change.
- Keep text and JSON formats aligned for trace/session diagnostics.
- If install/path behavior changes, run `npm run source:install-smoke`; it
  installs to a temporary root, checks installed CLI/TUI/ACP entrypoints,
  validates `doctor paths`, runs a deterministic installed CLI smoke, and
  verifies uninstall leaves XDG/project state untouched.
- Check direct-core, cron, and host-run paths if changing run flags or tool exposure.
- Check approval behavior in interactive and non-interactive modes.
- Check host tool catalog parity when changing capability/tool inspection output.

## Known Debts

- `packages/cli/src/cli.ts` is broad; feature changes often share one large file.
- Some diagnostics are formatted in CLI even though the source contracts live in core.
- The direct-core deterministic model is a diagnostics harness; it should keep exercising real catalog tools (`read_file`, `read_anchored_text`, `write_file`, `edit_anchored_text`/`apply_patch`) rather than reintroducing test-only write tools.

## Last Verified

- Status: Verified
- Date: 2026-06-22
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/cli/test/fixtures/trace-diagnostics/*`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts`.
