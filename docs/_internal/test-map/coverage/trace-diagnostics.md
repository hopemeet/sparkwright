# Trace Diagnostics Coverage

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-07-07
- Evidence source: 2026-06-22 core trace tests and CLI trace fixture tests
  passed; a deterministic CLI debug trace was also checked with summary,
  timeline, report, verify, and session check. Live real-model subagent canaries
  remain model/environment-sensitive. 2026-06-23 shell invalid-args scripted
  reproducer was rerun after fixes and now records a structured
  `TOOL_ARGUMENTS_INVALID` tool failure, a single terminal event, passing
  `trace verify`, and a failing `trace report` for unresolved tool failures.

## Covered

- 2026-07-15 independent follow-up reduced `run.started.payload.toolPlan` to a
  post-admission episode visibility snapshot. It records exposed/deferred/
  Workflow-omitted status, prompt-required promotion, and missing required
  names, but no static approval, execution, or dynamic-availability conclusion.
  Real fresh, Todo
  continuation, session resume, Profile, Workflow, deferred discovery, and TUI
  traces all passed verify/session check. See
  [../runs/2026-07-15-tool-decision-architecture-audit.md](../runs/2026-07-15-tool-decision-architecture-audit.md)
  and
  [../failures/tool-decision-pipeline-divergence.md](../failures/tool-decision-pipeline-divergence.md).
- The follow-up also proved and fixed two residual product bugs: retained
  Profile search closures could reveal denied deferred descriptors, and
  Workflow `RunEnd` could terminalize a Todo-resumable budget stop before the
  episode supervisor. See
  [../failures/profile-scoped-discovery-leaks-denied-tools.md](../failures/profile-scoped-discovery-leaks-denied-tools.md)
  and
  [../failures/workflow-resumable-runend-terminal-race.md](../failures/workflow-resumable-runend-terminal-race.md).

- 2026-07-15 expanded real coding QA exposed a Todo-supervisor tool-surface
  mismatch: the synthetic continuation required `todo_write` while its schema
  remained deferred, allowing a model to emulate it with ordinary `write` and
  create `TODO.md`. The Host now eagerly loads only an already-admitted
  `todo_write` for continuation episodes. Real Sonnet reconciled in one direct
  call with no extra file, third run, or budget failure. See
  [../failures/todo-continuation-deferred-tool-mismatch.md](../failures/todo-continuation-deferred-tool-mismatch.md).
- The same real trace exposed a false unsupported final claim for
  ``npm test` → `node --test``. Core now recognizes only same-line arrow
  expansions from successful npm/pnpm/yarn script commands and retains strict
  detection for unrelated claims. See
  [../failures/package-script-expansion-unsupported-claim.md](../failures/package-script-expansion-unsupported-claim.md).

- Raw trace events are the canonical source for summary, timeline, report, and
  verify views.
- Trace reports sort findings by severity and code.
- Reports surface repeated delegates, unresolved tool calls, failed terminal
  events, and shell/write/safety signals.
- Session/trace consistency checks identify delegated sub-agents without
  terminal results.
- CLI fixtures cover text and JSON output for trace diagnostics.
- 2026-06-29 real mini tool-surface QA confirmed trace summary/report/verify can
  diagnose repeated read loops and cleanly verify terminal TUI max-step failures,
  but exposed a report verdict issue for recovered verification failures.
- 2026-06-29 focused core tests fixed the recovered-verification report issue:
  generic `COMMAND_FAILURES` is no longer emitted when all shell failures are
  recovered verification failures with a later successful verification command.
- 2026-06-29 real mini pagination rerun verified that sequential read windows
  can find a target line/value and that trace report now treats advancing
  `startLine/endLine` windows as progress rather than duplicate low progress.
- 2026-06-29 real mini recovered-verification run confirmed summary reports
  `verification.unresolved=0` and report omits `COMMAND_FAILURES` after a
  later successful `npm test`.
- 2026-06-29 mixed shell failure QA confirmed report keeps unrelated command
  failures while no longer classifying `node -e` probes as unresolved
  verification. Debug traces with full shell command args now recompute command
  outcome classification instead of trusting stale persisted snapshots.
- 2026-07-01 real nano observation-metadata QA confirmed
  `WORKSPACE_READ_NOISE` evidence can attribute high-volume grep scan reads
  separately from one explicit `read` call using existing tool spans.
- 2026-07-02 real mini background-task QA confirmed `trace verify` can pass for
  a structurally valid multi-run background-agent trace while `trace report` and
  CLI exit fail on unrecovered empty-id `task` argument failures that preceded
  later successful concrete task monitoring.
- 2026-07-02 fix verification confirmed that the same historical trace now
  reports 2 recovered and 0 unresolved task placeholder failures, while a new
  real mini background-task rerun produced 0 tool failures and `trace report`
  verdict `ok`.
- 2026-07-02 real mini background-agent + bash QA confirmed `trace verify` can
  pass on a structurally valid background-agent trace while `trace report`
  can identify a repeated bash denial. Follow-up source inspection classified
  the pre-fix behavior as a core runtime/outcome issue: the repeated-tool guard
  lost expected-denial semantics when converting a prior `TOOL_DENIED` into
  `REPEATED_TOOL_CALL_SKIPPED`.
- 2026-07-02 fix verification confirmed repeated expected denials now remain
  non-failing expected-denial derivatives: the historical real mini trace
  reports 0 errors, 2 expected denials, 0 unresolved tool failures, and
  `trace verify` status `ok`. A separate promoted-shell fixture trace passed
  verify/session checks and reported `UNTRACKED_WRITE_CAPABLE_BOUNDARY` as
  `passed_with_issues`, matching the shell safety contract.
- 2026-07-03 real mini background-agent QA confirmed trace verify/session check
  pass for a current-source awaited background `agent` task trace with
  `subagent.completed`, `run.notification.injected`, durable task output, and
  zero tool failures. It also exposed and fixed a report-noise pattern:
  `LOW_NET_PROGRESS` fired on successful read-only background-agent workflows
  because parent and child model/tool counts were aggregated before
  thresholding while no workspace files were written. The post-fix real trace
  report is `ok`. See
  [../failures/trace-background-agent-low-progress.md](../failures/trace-background-agent-low-progress.md).
- 2026-07-03 follow-up real mini parent/child read QA exposed and fixed the
  same aggregate-scope issue for `REPEATED_TOOL_REQUESTS`: a valid parent read
  + child independent read + parent follow-up read was misreported as repeated
  identical requests when grouped across the whole trace. Repeated-tool-request
  findings are now run-scoped and include run/agent evidence for multi-run
  reports. The real trace
  `/tmp/sparkwright-real-mini-spawn-read-repeat.FKfRMP/.sparkwright/sessions/session_mr4teseeiusb206j/trace.jsonl`
  now reports `ok`. See
  [../failures/trace-cross-run-repeated-tool-requests.md](../failures/trace-cross-run-repeated-tool-requests.md).
- 2026-07-07 current-source real mini workflow canary confirmed workflow
  trace observation now normalizes real-shaped terminal events: a trace with
  `run.completed` and no `payload.state` reported `terminal: completed` in
  both `workflow shadow` and `workflow distill`, with trace report/verify and
  session check `ok`. See
  [../runs/2026-07-07-real-mini-broad-trace-qa.md](../runs/2026-07-07-real-mini-broad-trace-qa.md)
  and
  [../failures/workflow-distill-shadow-terminal-state.md](../failures/workflow-distill-shadow-terminal-state.md).
- 2026-07-07 real mini Agent + Skill multidirection QA confirmed current-source
  multi-run traces stay clean for successful Skill-loaded dynamic
  `spawn_agent` and configured indexed `delegate_agent` routes, while trace
  report still surfaces problematic variants: `LOW_NET_PROGRESS` on repeated
  equivalent awaited `task_create(kind:"agent")` and `SUBAGENT_INCOMPLETE` when
  a dynamic child hits `step_limit`. See
  [../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md](../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md).
- 2026-07-07 follow-up root-cause inspection found the repeated
  `task_create(kind:"agent")` trace was not just model variance: task feedback
  was too low-signal. The fix adds model-visible next-action guidance to
  detached task results and result summaries to terminal notification body
  text. See
  [../failures/task-create-agent-low-signal-result-feedback.md](../failures/task-create-agent-low-signal-result-feedback.md).
- 2026-07-07 fix verification added medium-severity
  `REPEATED_TASK_CREATE_LIFECYCLE` for same-run equivalent `task_create` after
  a prior same-payload task completed with reusable task evidence. Focused core
  coverage asserts the finding ignores failed prior tasks and keys equivalence
  on `kind` plus stable payload fingerprint rather than scheduling fields.

- A 2026-07-15 macOS temp-fixture run passed `/tmp/<workspace>` back to `glob`
  while the runtime held the equivalent canonical `/private/tmp/<workspace>`
  root. Discovery normalization compared them lexically, emitted
  `TOOL_ARGUMENTS_INVALID` / `WORKSPACE_PATH_ESCAPE_ATTEMPT`, and kept the
  otherwise successful verified code repair in `completed_with_issues`.
  Discovery normalization now canonicalizes the deepest existing ancestor and
  reattaches missing/glob suffixes before containment, with the walker retaining
  final realpath enforcement. A portable symlink-alias regression covers the
  same identity mismatch. Keep a `/tmp` alias fixture in rotation; see
  [../runs/2026-07-15-real-model-broad-code-qa.md](../runs/2026-07-15-real-model-broad-code-qa.md).
  Post-fix real mini session `session_mrlgnkbp0mufyzhu` used the original
  `/tmp/sparkwright-code-qa-20260715` absolute path and glob against the
  canonical `/private/tmp` root, then read `src/cart.js`; trace report/verify
  and session check were clean with zero failures.

## Weak Or Untested

- Real-model traces can include valid route variance; reports should classify
  invariant violations, not preferred prose or step count.
- Parent verification after child writes needs ordered evidence. A child final
  answer alone is not proof that the parent verified the result.
- High-volume traces can differ by trace level. `standard` trace output may be
  too compact for some diagnostic assertions.
- Trace diagnostic fixture updates can overfit one golden file and miss
  behavior-level expectations.
- Keep `trace verify` in the route when tool input normalization or internal
  errors are under test; report and verify now agree on the fixed shell
  invalid-args reproducer, but this class of failure is easy to regress.
- 2026-06-28 P0/P1 follow-up verified traces for MCP read-only approval denial,
  TUI shell denial, TUI workspace-write approval, TUI bypass shell mutation
  audit, and cron unattended denial. All selected traces passed `trace verify`.
- Recovered verification command failures are covered for the all-failures-
  recovered case; mixed cases with unrelated non-verification shell failures
  should continue to emit `COMMAND_FAILURES`.
- Standard traces are enough for report/verify health but not for exact prompt
  content-visibility assertions because prompt/tool payloads are summarized.
- Large-file read diagnostics should continue checking both tool payloads and
  prompt visibility; a correct `tool.completed` payload is not enough if
  context shaping hides the relevant content from the model.
- Task monitor placeholder recovery is covered for empty ids followed by later
  concrete same-action monitoring. Future diagnostics should still avoid
  recovering policy denials, `stop` calls, or failures without a later concrete
  successful task monitor call.
- Repeated-tool guard feedback should stay tool-aware. The 2026-07-02 fix
  covers same-target repeats after policy/approval denials; future diagnostics
  should still preserve normal recovered/unresolved behavior for repeated
  argument and runtime failures.
- Future aggregate-level stuck-pattern diagnostics should distinguish repeated
  parent `spawn_agent` / `task_create` loops with failed or incomplete children
  from normal independent child/sub-agent review. Cross-run repeated reads are
  not sufficient evidence by themselves; this is now covered for
  `REPEATED_TOOL_REQUESTS`.
- 2026-07-07 real mini follow-up showed an active trace evidence gap for the
  new `REPEATED_TASK_CREATE_LIFECYCLE` diagnostic: an intentional repeated
  awaited agent-task trace had concrete `taskId` values in `task_create`
  outputs and prompt-injected task summaries, but no raw `task.completed` event
  and no `taskId` on `subagent.completed`, so report only emitted the
  unresolved `TASK_CONCURRENCY_LIMIT`. See
  [../failures/agent-task-terminal-trace-missing-task-id.md](../failures/agent-task-terminal-trace-missing-task-id.md).
- Post-fix 2026-07-07 real mini verification confirmed terminal
  `agent_task` `subagent.completed` events now carry `taskId` in payload and
  metadata, allowing the same intentional repeated task canary to emit medium
  `REPEATED_TASK_CREATE_LIFECYCLE` with clean trace verify/session check.
## Focused Route

```bash
npm --workspace @sparkwright/core test -- test/trace.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
```

Use the release gate only when trace changes cross package boundaries:

```bash
npm run release:check
```

## Scenario Links

- [../scenarios/trace-subagent-write-verify.yaml](../scenarios/trace-subagent-write-verify.yaml)

## Sensitivity Links

- [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md)
- [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md)
- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)

## Stale Triggers

- `packages/core/src/trace.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/core/src/run-health.ts`
- `packages/cli/src/*trace*`
- trace fixture expected output changes

## Failure Links

- [../failures/trace-subagent-finality.md](../failures/trace-subagent-finality.md)
- [../failures/model-skips-verification.md](../failures/model-skips-verification.md)
- [../failures/shell-invalid-args-terminality.md](../failures/shell-invalid-args-terminality.md)
- [../failures/real-regression-write-denied-append-file.md](../failures/real-regression-write-denied-append-file.md)
- [../failures/prompt-induced-tool-loop.md](../failures/prompt-induced-tool-loop.md)
- [../failures/trace-recovered-verification-command-failure.md](../failures/trace-recovered-verification-command-failure.md)
- [../failures/paginated-read-context-window-hidden.md](../failures/paginated-read-context-window-hidden.md)
- [../failures/trace-sequential-pagination-low-progress.md](../failures/trace-sequential-pagination-low-progress.md)
- [../failures/trace-background-agent-low-progress.md](../failures/trace-background-agent-low-progress.md)
- [../failures/trace-cross-run-repeated-tool-requests.md](../failures/trace-cross-run-repeated-tool-requests.md)
- [../failures/node-e-probe-verification-misclassified.md](../failures/node-e-probe-verification-misclassified.md)
- [../failures/task-action-empty-id-recovery.md](../failures/task-action-empty-id-recovery.md)
- [../failures/repeated-expected-denial-outcome.md](../failures/repeated-expected-denial-outcome.md)
- [../failures/workflow-observation-blocked-tool-requests.md](../failures/workflow-observation-blocked-tool-requests.md)
- [../failures/workflow-distill-shadow-terminal-state.md](../failures/workflow-distill-shadow-terminal-state.md)
