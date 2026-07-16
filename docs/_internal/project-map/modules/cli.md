# CLI

## Purpose

`@sparkwright/cli` is the command-line product surface. It starts host or direct-core runs, exposes trace/session diagnostics, manages capabilities, and provides local maintainer workflows.

See also [../maps/trace/summary-timeline-verify.md](../maps/trace/summary-timeline-verify.md) and [../maps/session/resume-replay.md](../maps/session/resume-replay.md).

## Last Verified

- Status: Verified
- Date: 2026-07-16T13:21:00+0800
- Scope: CLI constructs one `InteractionChannel` from access mode and IO; direct-core, delegate, Cron, and Host-client approval paths no longer expose a resolver API.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Date: 2026-07-16T11:52:29+0800
- Scope: Host-mode terminal failure handling consumes only the canonical
  `failure` envelope from protocol 2.0; no `run.failed.error` code/message
  fallback remains. Capability/tool identity remains canonical-only.

## Main Files

- `packages/cli/src/cli.ts`
- `packages/cli/src/commands/contracts.ts` — shared parsed-command and result contracts
- `packages/cli/src/commands/trace-session.ts` — trace, session, and run-resume diagnostics/lifecycle handlers
- `packages/cli/src/commands/capabilities.ts` — capability inspection and configured delegate diagnostics
- `packages/cli/src/commands/config-doctor.ts` — config read/validate/explain/example and doctor path diagnostics
- `packages/cli/src/commands/config-paths.ts` — stable config/task path resolution leaf
- `packages/cli/src/parser/numbers.ts` — shared pure integer flag parsing
- `packages/cli/src/parser/values.ts` — shared pure record/list/word parsing
- `packages/cli/src/event-format.ts`
- `packages/cli/src/run-outcome.ts`
- `packages/cli/src/runners/direct-core-runner.ts`
- `packages/cli/src/runners/host-runner.ts`
- `packages/cli/src/cli-approval.ts`
- `packages/cli/test/cli.test.ts`
- `packages/cli/test/support/cli-harness.ts`
- `packages/cli/test/fixtures/trace-diagnostics/*`
- `scripts/copy-cli-schemas.mjs`

## Owns / Does Not Own

Owns:

- command parsing and text/JSON formatting
- CLI approval defaults and non-interactive behavior
- workflow inspection/control commands: `workflow list`, `workflow start`,
  `workflow inspect`, and `workflow resume`
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

- `skills create` prepares a project Skill proposal through host
  `SkillCommandService`; it no longer writes `SKILL.md` directly or accepts
  `--force`. `skills proposals apply` is the explicit human review decision and
  calls the same service's effect-bound approve/apply path.

- `sparkwright trace *` reads a `trace.jsonl` path.
- Top-level help must list every trace diagnostic subcommand, including
  `trace report`; subcommand usage remains owned by command-specific handlers.
- Top-level `sparkwright --version` / `sparkwright -v` prints the CLI package
  version and exits before config loading, parsing a run goal, or starting a
  model run.
- A first token outside the known command set is the default `run` goal, not an
  unknown-command error. Recognized flags are consumed wherever they occur;
  repeated scalar flags use the last value, unknown flags remain goal text,
  and `--` is currently ordinary goal text rather than an option terminator.
- CLI tests that mutate the real `process.env` live in one sequential suite and
  use `test/support/cli-harness.ts` for explicit env restoration, LIFO cleanup,
  temporary workspace/XDG roots, output capture, HTTP servers, MCP fixtures,
  and trace/checkpoint helpers.
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
- Nested command help such as `sparkwright capabilities inspect --help` or
  `sparkwright workflow shadow --help` prints usage without executing the
  subcommand, loading config, or creating session traces.
- `sparkwright workflow list` prints both durable workflow run snapshots from
  the session root and host-owned workflow assets. JSON output preserves the old
  top-level asset report fields and adds `workflowRuns` /
  `invalidWorkflowRunEntries`.
- `sparkwright workflow start <name> <goal...>` is a runbook-style alias for
  `sparkwright run <goal...> --workflow <name>`. It routes through the same
  host run lifecycle and `run.start { workflow, goal }` request path; it does
  not add background/daemon semantics.
- Fresh CLI workflow starts allocate an independent `session_workflow_*` job
  session. An explicitly supplied `--session-id` is sent as
  `controlSessionId` attribution and is not reused as workflow storage; the CLI
  reports the authoritative job session returned by Host. Resume continues to
  use the session persisted on the workflow record.
- After a workflow run returns, CLI waiting detection matches only the current
  host `runId` or an explicit resumed `workflowRunId`. Asset name is not a
  fallback because an unrelated stale waiting run of the same workflow asset
  must not determine the reported resume id or exit state.
- `sparkwright workflow inspect` is an inspection-only view over host-owned
  workflow assets. It may display parse errors and layer shadows, but must not
  instantiate workflows or start run-loop state.
- `sparkwright workflow resume <workflowRunId>` adopts a non-terminal durable
  workflow run through host mode. It uses the stored pinned definition snapshot
  and does not expose `--force`. P3 Step 4a keeps the CLI surface unchanged
  while the host routes the request through the actor episode driver.
- `sparkwright workflow distill <sessionId>` is a read-only draft generator.
  It reads an existing session trace through host helpers and prints a
  review-first workflow markdown draft (or JSON report); it does not write
  workflow assets, create proposals, or mutate traces.
- `sparkwright workflow shadow <workflowName> <sessionId>` is a read-only
  offline coverage report. It compares a host-owned workflow asset against an
  existing session trace through host helpers and prints text/JSON matched,
  missing, and unobserved coverage checks. It does not start a run, write
  workflow records, mutate traces, or change `workflow list|inspect|resume`.
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
  delegate inventory. A Host snapshot is required for effective tool,
  delegate, and sandbox facts; Host inspection failure is reported instead of
  synthesizing a snapshot-less effective catalog. CLI still owns additive
  config diagnostics, layered asset reports, and opt-in MCP resolution detail.
- CLI JSON preserves both views: `agents.profiles` is the layered/config report,
  and `runtime.agents.profiles` comes from host `CapabilitySnapshot` and must
  include inline-config profiles even when they are primary/non-delegate
  diagnostics rather than callable delegate tools.
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
- `--access-mode` is the only CLI-facing run autonomy flag and
  is clamped to any project `run.accessMode` ceiling before host/direct-core
  execution. Host-client payloads send only `accessMode`.
- CLI run/config plumbing carries config-derived `backgroundTasks` to host
  `run.start` / `run.resume` requests and surfaces `backgroundTasks` /
  `backgroundTasksCeiling` in config inspection. There is not currently a
  separate CLI flag; host owns validation, clamping, and execution behavior.
- `capabilities inspect` projects effective shell foreground timeout and
  promotion availability from the runtime snapshot when available. Its text and
  top-level JSON shell summary must not override a foreground-only runtime with
  a configured/default `promotionAvailable:true` fallback.
- CLI run/config plumbing also carries config-derived `confidentialDefaults`
  into host requests and direct-core diagnostics. The CLI config template keeps
  it under `policy`; `confidentialDefaults:false` is an explicit opt-out from
  built-in read-confidentiality defaults, not a write-scope or `--target`
  control.
- CLI cron state commands route create/update/list/status/pause/resume/remove
  through `@sparkwright/cron` `CronCommandService`; `CronStore` is not the
  product-surface contract. `cron create` keeps the created job JSON on stdout
  and writes a stderr notice when unique-name storage creates a suffixed name
  such as `name 2`.
- direct-core and cron run paths call `createConfiguredCliTools`, which now flattens the host `createCliDiagnosticToolCatalog` profile; do not add ad hoc CLI-only tools there. The deterministic direct-core write fallback uses `write` when the target file does not exist.
- Direct-core remains an opt-in internal diagnostic path, but its fresh run and
  run-resume mutation/read/permission policy comes from Host
  `createHostRunPolicy`. Untargeted writes therefore use the Host default
  four-file budget and deletion semantics; explicit `--target` and configured
  write guardrails clamp both paths identically. Other Host-only capability
  assembly is intentionally not implied by this policy parity.
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
  `write`, not retired harness-only tool names.
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
  share the same canonical envelope extraction instead of maintaining separate
  CLI payload cascades.
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
- The direct-core deterministic model is a diagnostics harness; it should keep exercising real catalog tools (`read`, `read_anchored_text`, `write`, `edit_anchored_text`/`edit`) rather than reintroducing test-only write tools.

## Last Verified

- Status: Verified
- Date: 2026-07-15T07:35:27+0800
- Scope: moved config path/validate/inspect/explain/example and doctor paths
  into one domain module with a shared path-resolution leaf. Config precedence,
  schema diagnostics, redaction, output, help, and init template behavior are unchanged.
- Read: CLI facade, config-doctor/config-paths, config schema, and CLI tests.
- Tests: config/doctor focused and full CLI golden, schema/entry/outcome,
  typecheck/build, repo-pilot, import/boundary, and map drift.

- Status: Verified
- Date: 2026-07-15
- Scope: moved capability inspect, MCP status projection, delegate diagnostics,
  and their text/JSON formatters into one domain module. The module receives the
  existing HostService explicitly; CLI parsing/help/output and service singleton
  count are unchanged.
- Read: CLI facade, capability command module, parser value leaf, Host
  capability/delegate APIs, and CLI golden tests.
- Tests: capability/delegate focused and full CLI golden, config/entry/outcome,
  build/typecheck, repo-pilot, import/boundary, and map drift.

- Status: Verified
- Date: 2026-07-15
- Scope: moved trace/session/run-resume handlers and their text/JSON formatting
  into one domain module. `cli.ts` remains the composition facade,
  `cliHostService` is still created once and passed explicitly, and parseArgs,
  help, stdout/stderr, exit codes, direct-core, and lazy entry loading are unchanged.
- Read: CLI facade, command contracts, trace-session module, number parser,
  host/direct-core runners, and CLI golden tests.
- Tests: focused and full CLI golden, config/entry/outcome suites,
  typecheck/build, repo-pilot, import/boundary gates, and map drift.

- Status: Verified
- Date: 2026-07-15
- Scope: froze existing command/parser behavior and extracted shared CLI test
  support without changing production CLI behavior or output.
- Read: CLI bootstrap/parser/help, test setup/helpers, direct-core/Host paths,
  and root governance scripts.
- Tests: CLI 155/155; config/schema/entry/outcome 29/29; CLI and test
  typechecks; deterministic repo-pilot; import/boundary/drift checks.

- Status: Verified
- Date: 2026-07-14
- Scope: CLI Host-backed entrypoints now use the shared HostService assembly;
  CLI command and output contracts remain unchanged.

- Status: Verified
- Date: 2026-07-13T22:42:00+0800
- Scope: direct-core start/resume now share Host run-policy defaults and clamps;
  the internal opt-in gate, catalog profile, model, storage, and resume carrier
  remain CLI-owned diagnostics.
- Read: CLI parser/start/session-resume/run-resume/direct runner, Host policy
  factory, and focused tests.
- Tests: CLI 152/152 and typecheck; Host policy/security-plan/tools/protocol
  155/155; affected builds passed.

- Status: Verified
- Date: 2026-07-13
- Scope: made Host `CapabilitySnapshot` mandatory for CLI effective tool,
  delegate, and sandbox inspection and deleted the local fallback catalog.
- Read: `packages/cli/src/cli.ts`, Host runtime/tool catalog/security plan, and
  protocol snapshot types.
- Tests: CLI typecheck passed; capability-inspect tests 13/13 passed after Host
  build.

- Status: Verified
- Date: 2026-07-12T20:00:00+0800
- Scope: added Agent/Workflow stats, Skill origin import, and suggestion-dismiss
  command routing while preserving config-backed Agent remove compatibility;
  Workflow completed/failed values now represent runs rather than observations.
- Read: CLI handlers/usage and focused CLI tests.
- Tests: focused CLI reconciliation/stats suites and CLI typecheck passed.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Skill reconciliation CLI routing; no CLI run/session/trace contract changed.
- Tests: focused CLI reconciliation/review tests and the 2026-07-15 release gate passed.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked Workflow CLI resume against executable snapshots; CLI syntax is unchanged.
- Tests: not run for broader CLI behavior; Phase 4 Workflow release gate passed.

- Status: Verified
- Date: 2026-07-12T08:25:00+0800
- Scope: converged CLI Skill create/apply with model and TUI managed-change
  semantics.
- Read: `packages/cli/src/cli.ts`, host Skill command service, CLI tests.
- Tests: focused CLI create/proposal suites and CLI typecheck.

- Status: Verified
- Date: 2026-07-11T15:30:00+0800
- Scope: Package G `workflow stop` creates a CLI-authenticated cancel-only
  binding, accepts one durable command, and dispatches the stored envelope.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/runtime.ts`.
- Tests: CLI workflow slice 16 tests plus typecheck/build.

- Status: Verified
- Date: 2026-07-11T14:30:00+0800
- Scope: Package F `workflow service run|status|drain` and honest
  `workflow start --detach` durable-accept boundary.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/server-runtime/src/workflow-service.ts`,
  `packages/host/src/runtime.ts`.
- Tests: CLI workflow slice 15 tests and CLI typecheck/build; cross-package
  focused evidence is recorded in the workflow durable-jobs test map.

- Status: Read-only
- Date: 2026-07-11T14:00:00+0800
- Scope: Package F design adds an honest detach surface only after durable
  service handoff acceptance; current per-run stdio Host remains foreground and
  disconnect-owned until implementation.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/host-runner.ts`, `packages/host/src/server.ts`.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Package B CLI workflow start session isolation and explicit control
  session attribution.
- Read: `packages/cli/src/cli.ts`, `packages/cli/src/runners/host-runner.ts`,
  workflow CLI tests.
- Tests: CLI workflow slice (13 tests), CLI typecheck and build.

- Status: Verified
- Date: 2026-07-11T02:10:00+0800
- Scope: P4 closure: capability inspection now reports the effective runtime
  shell promotion policy, including foreground-only clamps.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/runtime.ts`.
- Tests: focused CLI capability test and typecheck; rebuilt CLI; Terra fixture
  capability text/JSON showed `backgroundTasks=foreground-only` and
  `promotionAvailable=false`.

- Status: Verified
- Date: 2026-07-11T01:04:00+0800
- Scope: workflow waiting lookup now requires current run/workflow identity and
  ignores stale waiting records that merely share the asset name.
- Read: `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: focused workflow start/resume CLI tests, CLI typecheck; full
  `npm run release:check` on the same source tree.

- Status: Verified
- Date: 2026-07-09T21:22:00+0800
- Scope: Workflow Job Session Stage C makes host-mode CLI workflow runs that
  reach durable `status:"waiting"` print the waiting reason plus
  `sparkwright workflow resume <id>` and exit with the dedicated waiting code
  42, projected from `workflow.list` snapshots after the terminal host run.
- Read: `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/src/cli.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"starts workflow runs through the workflow start alias"`; `npm --workspace
@sparkwright/cli run typecheck`; manual CLI waiting probe.

- Status: Verified
- Date: 2026-07-09T21:18:00+0800
- Scope: Workflow Job Session Stage B added `sparkwright workflow start
<name> <goal...>` as a CLI alias for the existing host `run --workflow` path.
  No `workflow stop`, background/daemon flag, or new host payload path was
  added.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"workflow start alias|starts workflow runs through the workflow start
alias"`; `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow nested help for `workflow
list|inspect|resume|distill|shadow --help` now exits through the early help
  path before config parsing, workflow lookup, host setup, or session trace
  creation.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/workflow-distill.ts`,
  `packages/host/src/workflow-shadow.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"workflow nested help|nested command help"`; manual
  `node packages/cli/dist/index.js workflow
list|inspect|resume|distill|shadow --help`; `npm --workspace
@sparkwright/cli run build`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② CLI propagation for read-confidentiality defaults: host runs,
  run resume, workflow resume, direct-core resume, config inspection, and the
  starter template carry `confidentialDefaults` consistently.
- Read: `packages/cli/src/cli.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"confidential"`; `npm --workspace @sparkwright/cli run typecheck`; `npm
--workspace @sparkwright/cli run build`.

- Status: Verified
- Date: 2026-07-06T19:48:49+0800
- Scope: C10 CLI capability inspection now verifies that runtime snapshots
  include inline-config profiles that are not delegate-derived; host remains
  the runtime snapshot source.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/runtime.ts`, `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"capabilities inspect|capability inspect|inline-config profiles"`.

- Status: Read-only
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 cron persistence migration changed `CronStore.save()` to use
  the shared atomic writer. CLI cron command parsing, text/JSON response
  shapes, `cron tick`, and `cron run <ref>` behavior are unchanged.
- Read: `packages/cron/src/store.ts`, `packages/cron/src/commands.ts`,
  `packages/cli/src/cli.ts`, `docs/_internal/project-map/maps/capabilities/cron.md`.
- Tests: cron storage/schedule-focused `npm --workspace @sparkwright/cron test
-- test/schedule.test.ts`; CLI-specific tests not rerun for this persistence
  implementation-only change.

- Status: Verified
- Date: 2026-07-05T22:37:13+0800
- Scope: workflow-runtime-v1 P9a CLI surface: `workflow list` and
  `workflow resume` consume host dual-store behavior for workspace-root fresh
  records plus legacy session-root records without adding flags or changing
  text/JSON response shapes.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/runtime.ts`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "lists
and inspects workflow assets|resumes workflow runs"`; `npm --workspace
@sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a CLI surface: `workflow shadow <workflowName>
<sessionId>` emits text/JSON offline coverage reports from an existing
  workflow asset and session trace without changing `workflow
list|inspect|resume|distill`, starting host runs, writing workflow state, or
  adding protocol surfaces.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"shadows a workflow asset|distills a session trace|lists and inspects
workflow assets"`; `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-05T22:04:23+0800
- Scope: workflow-runtime-v1 P7a CLI surface: `workflow distill <sessionId>`
  emits text/JSON workflow draft reports from an existing session trace without
  changing `workflow list|inspect|resume`, writing assets, or adding protocol
  surfaces.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/workflow-distill.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"distills a session trace|lists and inspects workflow assets"`; `npm
--workspace @sparkwright/cli run typecheck`.

- Status: Read-only
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review routed-page check: stricter
  parallel validation, delegate_parallel crash classification, and workflow
  lease event cleanup remain host/store behavior. CLI workflow commands,
  direct-core run setup, text/JSON formatting, and protocol usage are unchanged.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
diagnostics"`; `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts -t "lease"`.

- Status: Read-only
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 routed-page check: `parallel` / `join` add
  host-parsed workflow asset semantics and durable run state only. CLI workflow
  commands, direct-core runner setup, text/JSON formatting, and protocol usage
  are unchanged by the P5 fail-closed/join-source hardening.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
-t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

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

- Status: Verified
- Date: 2026-07-16T13:12:00+0800
- Scope: CLI run access accepts only `accessMode`; host/direct-core runners
  compile it to their internal execution fields. `capabilities inspect`
  passes the same access mode into the host runtime and prints the resulting
  `runtime access` line.
- Read: `packages/cli/src/cli.ts`, `packages/cli/src/run-access.ts`,
  `packages/cli/src/runners/host-runner.ts`,
  `packages/cli/src/runners/direct-core-runner.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/modules/cli.md`.
- Tests: `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli-approval.test.ts test/entry-parity.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "clamps CLI access-mode overrides|allows safe read tools without approval in read-only access mode|allows workspace writes without approval in accept_edits mode|run resume through the host preserves trace level and metadata|resumes workflow runs through the host actor episode driver"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capability inspect"`.
