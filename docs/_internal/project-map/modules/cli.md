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
- workflow inspection/control commands: `workflow list`, `workflow inspect`,
  and `workflow resume`
- trace commands: `summary`, `events`, `timeline`, `report`, `verify`
- session commands: `summary`, `inspect`, `check`, `repair`, `compact`,
  `resume`
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
- Top-level `sparkwright --version` / `sparkwright -v` prints the CLI package
  version and exits before config loading, parsing a run goal, or starting a
  model run.
- `sparkwright session *` resolves a session id under the session root.
- `sparkwright session compact` calls the host session compaction path and
  prints `freedChars`, measurement regime/savings ratio, optional
  `skippedReason`, optional `warnings`, and the artifact path in JSON/text
  formats. `--llm` explicitly requests the Tier 3 path; provider/scripted model
  refs use the model-backed summarizer, while deterministic refs use the
  preview path and return a warning.
- `sparkwright session inspect --compaction` prints a compaction audit view
  from `compact.json` and session-local compaction events. JSON/text output
  includes status, artifact path, source/through run ids, counts, measurement
  and warning/fingerprint metadata, recent events, and event/artifact
  consistency, but not the compacted summary body.
- Nested command help such as `sparkwright capabilities inspect --help` prints
  the subcommand usage without executing the subcommand.
- `sparkwright workflow list` prints both durable workflow run snapshots from
  the session root and host-owned workflow assets. JSON output preserves the old
  top-level asset report fields and adds `workflowRuns` /
  `invalidWorkflowRunEntries`.
- `sparkwright workflow inspect` is an inspection-only view over host-owned
  workflow assets. It may display parse errors and layer shadows, but must not
  instantiate workflows or start run-loop state.
- `sparkwright workflow resume <workflowRunId>` adopts a non-terminal durable
  workflow run through host mode. It uses the stored pinned definition snapshot
  and does not expose `--force`. P3 Step 4a keeps the CLI surface unchanged
  while the host routes the request through the actor episode driver.
- `sparkwright run --workflow <name>` is the host-mode workflow instantiation
  surface. P1.5 removes the experimental environment gate; the flag remains
  unsupported on `--direct-core`. Ordinary runs omit the field and keep existing
  behavior.
- Run flags expose `--trace-level standard|debug`.
- Live run output formats `capability.index.failed` payload details when
  present, including warning severity, capability kind/code, profile id, and a
  bounded message/source. Agent profile collision warnings should therefore be
  visible in normal `sparkwright run` output, not only in trace inspection.
- Live run output formats `agent.routing.evaluated` as a compact sort summary
  (`mode`, delegate count, relevant/low counts); raw trace inspection remains
  the source for per-delegate matched keyword details.
- `sparkwright run` accepts repeatable `--image <path>` arguments, reads local
  images as base64 protocol `input.parts`, and passes them through host mode;
  direct-core diagnostics receive the same parts as context items. MIME
  detection, size limit, base64 part construction, and input metadata come from
  host client input helpers so CLI/TUI attachment summaries stay aligned.
- `run resume --from-trace` reconstructs only a partial checkpoint and still requires force when incomplete.
- `capabilities inspect` is the runtime tool inventory entry point, sourced
  from host `capability.inspect` / tool catalog snapshots. Delegate tool
  origins, including `in_process:<profileId>`, come from
  `agents.delegateTools`; CLI should not maintain a separate local in-process
  delegate inventory. Snapshot-less fallback uses the host-resolved delegate
  list so inline profile `delegateTool` hints and explicit delegate config stay
  aligned.
- `doctor paths` reports installation, install version/current target, CLI/TUI/ACP
  entrypoints, user config/capability roots, user state including host crash
  logs, and workspace state without starting a run.
- `sparkwright init` and `sparkwright init --project` create YAML starter
  configs by default when no same-layer config exists; they refuse to overwrite
  existing `config.json`, `config.yaml`, or `config.yml`. First interactive
  runs with no loaded config auto-scaffold the user YAML once and stop before
  model execution, using the same non-overwriting template as `init`. The user
  starter's `run` block defaults to `accessMode: ask`, `traceLevel: standard`,
  and `budget.maxModelCalls: 80` / `budget.maxCostUsd: 2.0`. YAML starters
  include a `yaml-language-server` schema directive pointing at the local schema
  file shipped under the installed CLI's `dist/schemas`.
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
- `agents validate` reports config profile/delegate shape errors and also
  inspects layered markdown-authored agents for same-layer id collisions. Same
  layer collisions are validation errors and make the command exit non-zero;
  cross-layer shadows remain diagnostics in text/JSON output.
- `approvals.cronMode` supplies the default `permissionMode` for cron commands;
  CLI flags still override it.
- `--access-mode` is the CLI-facing run autonomy flag for interactive runs and
  is clamped to any project `run.accessMode` ceiling before host/direct-core
  execution. New host-client payloads send `accessMode` rather than relying on
  low-level `permissionMode`.
- CLI run/config plumbing carries config-derived `backgroundTasks` to host
  `run.start` / `run.resume` requests and surfaces `backgroundTasks` /
  `backgroundTasksCeiling` in config inspection. There is not currently a
  separate CLI flag; host owns validation, clamping, and execution behavior.
- CLI cron state commands route create/update/list/status/pause/resume/remove
  through `@sparkwright/cron` `CronCommandService`; `CronStore` is not the
  product-surface contract. `cron create` keeps the created job JSON on stdout
  and writes a stderr notice when unique-name storage creates a suffixed name
  such as `name 2`.
- direct-core and cron run paths call `createConfiguredCliTools`, which now flattens the host `createCliDiagnosticToolCatalog` profile; do not add ad hoc CLI-only tools there. The deterministic direct-core write fallback uses `write_file` when the target file does not exist.
- `cron tick` passes a model factory into `@sparkwright/cron` so every due job
  receives a fresh adapter; this is required for stateful diagnostic adapters
  such as `deterministic`. Manual `cron run <ref>` remains single-job/single
  adapter.
- `cron run <ref>` returns exit 1 when the cron runner result is `ok: false`,
  including cron-local unattended denial/outcome failures that may differ from
  the generic interactive run completed-state policy.
- `cron tick` returns exit 1 when the scheduler aggregate reports any failed
  due job (`failed > 0`); lock-only skips remain non-failing.
- Real-model regression scripts share `scripts/lib/real-model-config.mjs` for
  model availability and isolated config copying. The helper asks
  `sparkwright config inspect --format json` for effective config facts and
  supports grouped `identity.providers`, YAML sources, and source-file copying.
  Setup-time config inspection must run outside the script's isolated XDG
  fixture; actual regression cases run against the copied isolated config.
  Real-model prompt canaries should target current catalog tools such as
  `write_file`, not retired harness-only tool names.
- Run completion summaries separate controlled workspace writes, capability
  mutations, tool-reported capability changes, and sub-agent write rollups.
  They also separate untracked write-capable process boundaries from
  managed workspace writes and append a static disclosure when host metadata
  says configured MCP servers have explicit workspace cwd; these are boundary
  or configuration posture signals, not filesystem side-effect detection.
- `capabilities inspect` prints delegate risk and conditional approval facts from
  host snapshots (`risk`, `approvalRequiredUnderCurrentRun`, `approvalReasons`,
  `approvalRunOptions`) instead of treating delegates or the legacy
  `requiresApproval` echo as unconditional runtime approval predictions.
- `capabilities inspect` treats `agents.delegateTools` as the delegation index,
  not proof that every entry is a direct model-facing `delegate_*` tool. Runtime
  snapshots list actual tools (`delegate_agent` by default plus pinned/all direct
  aliases); the snapshot-less fallback applies the same
  `exposure`/`pinnedDelegates`/`exposeAsDelegate` direct-exposure filter for the
  tool inventory while still reporting all delegate descriptors in the agents
  section.
- `capabilities inspect` prints delegate `model=` when the profile pins a
  model, `triggers=` when routing hints are configured but not evaluated, and
  `routing=<relevance>` / matched keywords when the host snapshot contains an
  evaluated routing summary.
- `capabilities inspect` also reports delegate tool-name collisions that the
  CLI can derive statically, including the reserved built-in
  `delegate_parallel` name when `enableParallelDelegates` is on and a directly
  exposed delegate already owns that name.
- `capabilities inspect` also prints the runtime model pricing status from
  `CapabilitySnapshot.model.pricing`; missing pricing is shown as
  `pricing=unavailable:missing_pricing` before a run produces usage trace
  diagnostics.
- `capabilities inspect` prints shell foreground timeout and promotion
  availability as a distinct line from shell sandbox status.
- `capabilities inspect --model provider/model` uses that model as the active
  runtime model for the host snapshot and model-pricing line instead of only
  showing the merged config default.
- `capabilities inspect` prints `workflow rules` from host
  `CapabilitySnapshot.rules.workflow`, including source, lifecycle, active
  status, blocking potential, matcher/action summaries, and hints. CLI does not
  reconstruct workflow hooks or verification rules locally.
- When unresolved verification failures make a completed run exit non-zero, CLI
  summaries say `Run completed with verification failures; exiting 1` so the
  terminal line matches the exit code.
- Documented-command invariant failures are reported from the shared
  completed-run outcome's `documentedCommandFailures` bucket; CLI prints a
  dedicated `Run completed with documented-command verification failures`
  stderr line instead of running any separate post-check.
- Host/direct-core run status labels and exit codes are derived from the
  shared run-outcome projection; CLI must not run a separate live
  documented-command post-check that can diverge from projection verifier facts.
- Live run/resume output is a human diagnostic stream, not the raw trace. By
  default it aggregates high-volume event types listed by protocol
  `isLiveDebugNoiseEventType()` into `live.debug.suppressed` summary lines
  while still recording those events in `trace.jsonl` and exposing them through
  `sparkwright trace events`. `--verbose` prints those live debug events
  individually. `run.budget.exceeded` is not in this noise list, so forced
  continuation exhaustion remains visible in live output.
- Host-mode terminal failure summaries use protocol `getRunFailure()` /
  `runFailureMessage()` so `run.completed{state:"failed"}` and `run.failed`
  share the same failure-message extraction instead of maintaining separate CLI
  payload cascades.
- `session resume` is a new run in the existing session context. It does not
  implicitly inherit an earlier CLI/TUI model override; users can pass
  `--model provider/model` explicitly.
- `delegates run` is the direct entrypoint for ACP and external-command
  delegate tools. Configured in-process/internal delegate profiles run through
  normal run-loop delegation.
- Direct `delegates run --format json` and the persisted session trace must use
  the same parent-visible `subagent.*` metadata shape: `sessionId`, parent
  `agentId`, and `childAgentId`/`agentProfileId` for the delegate identity.
- `check:dist-fresh` relies on root `npm run build` and each workspace build
  script writing a root `.sparkwright-build-stamp.json` after successful
  builds. Stamps stay outside `dist/` so npm package files do not include them,
  while targeted `npm run build --workspace ...` still avoids false stale
  reports when TypeScript emits no changed output.
- Text output is a human diagnostic surface; JSON output should remain machine-parseable.
- `sparkwright trace timeline --format text` prefixes phase rows with a short
  run id only for multi-run traces, keeping single-run output compact. JSON
  timeline output keeps the full phase `runId`.
- Fixture snapshots under `packages/cli/test/fixtures/trace-diagnostics/`
  lock byte-for-byte CLI text/JSON output for `trace summary`, `timeline`,
  `report`, and `verify` over a stable trace.
- `trace summary` text/JSON reports `subagents` / `subagentIds` separately from
  `agents` / `agentIds` so direct delegate diagnostics can show child identity
  without overloading persisted actor attribution.

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
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a CLI smoke: `sparkwright workflow
  resume` still goes through host mode and now verifies the actor episode
  driver metadata on the completed workflow record. `run resume` host path was
  also checked.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/host/src/runtime.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "workflow|run resume through the host"`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 CLI surface: `workflow list` now includes
  durable workflow runs without breaking the old JSON asset-report top-level
  shape, and `workflow resume <workflowRunId>` routes through host workflow
  resume using pinned workflow records with no `--force` option.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/host/src/client-run.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "workflow"`; `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 CLI surface: capability inspect prints
  verification rules as run-level invariants, completed-run status/exit code
  still derives from shared run outcome, and documented-command invariant
  failures are summarized from `documentedCommandFailures` rather than a local
  post-check.
- Read: `packages/cli/src/run-outcome.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/test/run-outcome.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/cli test --
  test/run-outcome.test.ts test/cli.test.ts -t
  "documented-command|verification profile|shows workflow and event
  rules|configured verification profile results"`; `npm --workspace
  @sparkwright/cli run build`; `npm run check`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T18:16:44+0800
- Scope: P1.5 closure after read-only review: CLI host/direct-core runners no
  longer run the old documented-command post-run scanner; completed-run status
  labels follow `runOutcomeFailing`, and starter/config examples no longer emit
  the removed `verification.stopGate` field.
- Read: `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/src/run-outcome.ts`,
  `packages/cli/src/cli.ts`,
  `packages/cli/src/documented-command-check.ts`,
  `packages/cli/test/run-outcome.test.ts`,
  `packages/cli/test/run-outcome-consistency.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/cli/test/config-schema.test.ts`,
  `packages/cli/test/documented-command-check.test.ts`.
- Tests: `npm --workspace @sparkwright/cli test --
  test/run-outcome.test.ts test/run-outcome-consistency.test.ts`; `npm
  --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "workflow|verification profile|Verification:|documented-command|experimental
  gate|--workflow|completed_with_issues"`; `npm --workspace @sparkwright/cli
  test -- test/documented-command-check.test.ts test/config-schema.test.ts`;
  `npm run typecheck:test`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 CLI surface: `sparkwright run --workflow`
  parses to host `run.start.workflow` without an experimental environment gate,
  still rejects direct-core mode, and CLI exit summaries read verification
  profile results from terminal FactLedger snapshots.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/src/run-outcome.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/cli/test/run-outcome.test.ts`.
- Tests: `npm --workspace @sparkwright/cli test --
  test/run-outcome.test.ts test/run-outcome-consistency.test.ts
  test/cli.test.ts -t "workflow|verification profile|Verification:|experimental
  gate|--workflow"`; `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 live event filtering: CLI continues to
  suppress `run.budget.checked` as debug noise but prints
  `run.budget.exceeded` normally.
- Read: `packages/cli/src/event-format.ts`,
  `packages/cli/test/event-format.test.ts`,
  `packages/protocol/src/index.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: `sparkwright workflow list` / `workflow inspect` were added as
  inspection-only commands over the host workflow asset snapshot, and
  `capabilities inspect` now renders workflow assets without changing run
  behavior.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/workflows.ts`, `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "workflow assets|lists and inspects workflow assets|capability inspect"`;
  `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: CLI host-run plumbing passes config-derived `backgroundTasks` through
  run start/resume payloads and config inspection reports the effective
  background task policy/ceiling; command syntax and trace/session behavior did
  not otherwise change.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/host/src/client-run.ts`,
  `packages/host/src/run-access.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`; host focused
  `backgroundTasks` tests; `npm run schema:check`.

- Status: Verified
- Date: 2026-06-29T22:55:26+0800
- Scope: `cron tick` now exits non-zero when any attempted due job fails, using
  the scheduler's explicit `failed` aggregate count.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/cron/src/scheduler.ts`, `packages/cron/test/schedule.test.ts`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "cron tick has a failed job"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`;
  `npm --workspace @sparkwright/cron run build`.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: nested `run resume --help` exits through CLI help before config
  loading, session allocation, host resume validation, or failure-trace
  creation.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "help|run resume"`; `npm --workspace @sparkwright/cli run typecheck`;
  `npm run build --workspace @sparkwright/cli`;
  `node packages/cli/dist/index.js run resume --help`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: CLI capability/config displays now use canonical tool names, derive
  diagnostic inventories from the host catalog, and keep discovery
  infrastructure distinct from public tool listings.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/cli/test/config-schema.test.ts`,
  `packages/host/src/tool-identities.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: CLI read-only access-mode runs now allow safe read tools without
  non-interactive approval denial using explicit read-only tool governance, and
  real Skill/agent regression scripts now assert proposal-first Skill creation
  plus default indexed delegation.
- Read: `packages/cli/test/cli.test.ts`,
  `packages/host/src/tools.ts`,
  `scripts/regression-real-skill-capabilities.mjs`,
  `scripts/regression-real-agents.mjs`,
  `packages/core/src/policy.ts`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm run build --workspace @sparkwright/core`;
  `npm run build --workspace @sparkwright/host`;
  `npm run build --workspace @sparkwright/cli`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run regression:real-skill-capabilities`;
  `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini npm run regression:real-agents`;
  real mini CLI read-only trace `session_mqxrirn46qlht3xf` verified with 0
  approvals and 0 writes.

- Status: Verified
- Date: 2026-06-27T20:24:22+0800
- Scope: `capabilities inspect` text output now prints host-provided workflow
  rule descriptors from `CapabilitySnapshot.rules.workflow`.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/active-rules.ts`, `packages/host/src/runtime.ts`,
  `packages/protocol/src/index.ts`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow
  rules in capability inspect"`; `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run schema:check`.
- Prior verification — Date: 2026-06-27T14:22:00+0800
- Scope: `capabilities inspect` now reports indexed delegation correctly:
  `delegate_agent` appears as the default callable surface, direct
  `delegate_*` inventory follows exposure/pin filters, and
  `delegate_parallel` reserved-name collisions only apply to directly exposed
  aliases.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/delegate-capability.ts`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "agents|capabilities inspect|delegate|config"`;
  `npm --workspace @sparkwright/cli run build`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`;
  `npm run schema:check`.
- Prior verification (delegate collisions) — Date: 2026-06-27T12:31:56+0800
- Scope: `capabilities inspect` reports delegate tool-name collisions,
  including the opt-in `delegate_parallel` reserved-name collision, and direct
  `delegates run` fails clearly when the requested tool name collided.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/host/src/delegate-capability.ts`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegate_parallel reserved-name|surfaces in-process delegate tools|fails direct delegate runs"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate tool-name collisions|delegate_parallel|reserved by an existing delegate|reserved name"`.
- Prior verification (delegate routing inspect) — Date: 2026-06-27T11:29:02+0800
- Read: `packages/cli/src/cli.ts`, `packages/cli/src/event-format.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/cli/test/event-format.test.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/index.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "surfaces in-process delegate tools"`.
- Prior verification (agent validation/collision diagnostics) — Date: 2026-06-27T10:55:00+0800
- Read: `packages/cli/src/cli.ts`, `packages/cli/src/event-format.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/cli/test/event-format.test.ts`,
  `packages/host/src/agent-report.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/index.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "markdown agent id collisions|creates, lists, and validates workspace agents|reports agent validation errors"`;
  `npx prettier --check packages/cli/src/cli.ts packages/cli/test/cli.test.ts`;
  `git diff --check`.
- Prior verification (delegate inspect fallback) — Date: 2026-06-27T01:25:26+0800
- Read: `packages/cli/src/cli.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/index.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
- Prior verification (image input) — Date: 2026-06-27T01:06:46+0800
- Read: `packages/cli/src/cli.ts`, `packages/host/src/client-input.ts`,
  `packages/host/src/index.ts`, `packages/host/test/client-run.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "image attachments"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npx prettier --check packages/host/src/client-input.ts packages/host/src/index.ts packages/host/test/client-run.test.ts packages/cli/src/cli.ts packages/tui/src/state/run-controller.ts packages/tui/test/sdk-cutover.test.ts`.
- Prior verification (access mode/default config) — Date: 2026-06-27T00:57:47+0800
- Read: `packages/cli/src/cli.ts`, `packages/cli/src/runners/host-runner.ts`,
  `packages/host/src/client-run.ts`, `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "init scaffolds|first interactive"`;
  `npm run build`; `npm run check:dist-fresh`; `git diff --check`.
