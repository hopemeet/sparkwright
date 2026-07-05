# 2026-07-01 Real Nano DCI Grep Partial

## Summary

- Scenario: real-provider CLI read-only run testing direct corpus interaction
  with `grep`/`read`/`glob` instead of retrieval or `tool_search`.
- Coverage: coding/search tool surface, deferred discovery separation, trace
  diagnostics for repeated direct-corpus reads.
- Result: `partial`
- Reusable lesson: SparkWright can complete a grep-based corpus task without
  invoking `tool_search`, but a broad evidence-gathering prompt can still drive
  excessive direct reads and repeated grep/read cycles before final answer.

## Test Setup

- Task direction: evaluate whether SparkWright can use grep-style direct corpus
  interaction as the repository search path and keep `tool_search` scoped to
  deferred schema discovery.
- Prompt shape: `strong`
- Prompt: required read-only behavior, forbade `tool_search`, embeddings, and
  external retrieval, required at least one grep-style corpus search before
  final answer, and asked for concrete inspected source files plus pass/fail.
- Model class: real provider/model `openai/gpt-5.4-nano`.
- Capabilities: default CLI host catalog; `grep`, `glob`, `read`, `bash`,
  public coding tools, infrastructure `tool_search`, and deferred advanced
  tools were visible.
- Permission/approval posture: `--access-mode read-only`; no approvals expected.
- Workspace/config isolation: target workspace was the SparkWright repo;
  session root was `/tmp/sparkwright-dci-sessions`; existing repo worktree was
  dirty before the run.
- Trace level: debug.
- Environment notes: provider credentials came from user config, not environment
  variables; pricing was unavailable because the configured model has no local
  pricing entry.

## Commands Or Harness

```bash
node packages/cli/dist/index.js capabilities inspect --workspace . --format text
node packages/cli/dist/index.js run "<DCI grep prompt>" --workspace . --session-root /tmp/sparkwright-dci-sessions --access-mode read-only --model openai/gpt-5.4-nano --trace-level debug
node packages/cli/dist/index.js trace summary /tmp/sparkwright-dci-sessions/session_mr1m3xl6dk49i8yd/trace.jsonl --format text
node packages/cli/dist/index.js trace report /tmp/sparkwright-dci-sessions/session_mr1m3xl6dk49i8yd/trace.jsonl --format text
node packages/cli/dist/index.js trace verify /tmp/sparkwright-dci-sessions/session_mr1m3xl6dk49i8yd/trace.jsonl --format text
node packages/cli/dist/index.js session check session_mr1m3xl6dk49i8yd --workspace . --session-root /tmp/sparkwright-dci-sessions --format text
```

## Stable Evidence

- Trace: `/tmp/sparkwright-dci-sessions/session_mr1m3xl6dk49i8yd/trace.jsonl`.
- Final result completed with `reason: final_answer`, `stepsUsed: 34`, and
  `stepLimitReached: false`.
- `trace verify` and `session check` both reported `status: ok`.
- Tool calls were `grep:40`, `read:31`, and `glob:2`; no `tool_search` tool
  request occurred.
- Safety evidence: 0 approvals, 0 managed workspace writes, 0 shell mutations,
  0 capability mutations, and 0 confidential read denials.
- The final answer cited
  `docs/_internal/project-map/modules/coding-tools.md` and
  `docs/_internal/project-map/designs/config-redesign.md` and classified the
  grep-based corpus path as pass.
- One `grep` call against path `README*` failed with `ENOENT`; summary
  classified it as recovered and not failing.

## Non-Invariants Observed

- Exact source files read are model-sensitive. The run inspected more files than
  the final answer named, including host/core implementation files and multiple
  project-map docs.
- Exact tool count is not an invariant. This run used 73 tool calls and 267401
  tokens for a task that a narrower prompt could answer with far fewer calls.
- `trace report` returned `passed_with_issues` with medium findings for
  duplicate workspace reads, excessive model calls, low net progress, and
  workspace read noise.
- `grep` scan implementation emits one `workspace.read` per searched file; broad
  grep patterns can dominate trace volume even when the model is following the
  intended DCI route.

## Failures

- Failure pattern: `prompt-induced-tool-loop`
- Cause bucket: `prompt_underspecified`
- Count update: incremented the existing watch pattern for a broad grep-based
  evidence prompt that eventually completed but repeated direct corpus searches
  and reads before final answer.

## Coverage Update

- Page: none.
- Change: no coverage status changed. This run is evidence that the grep route
  works functionally, while trace/noise efficiency remains a watch item rather
  than a new product defect.

## Follow-Up

- For future DCI QA prompts, give an explicit stop condition such as "after
  finding one implementation file and one documentation file, stop and answer."
- Consider a diagnostic view that separates scan-level `grep` workspace reads
  from explicit model-requested file reads when reporting workspace read noise.
