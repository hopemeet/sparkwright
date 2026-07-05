# 2026-07-01 Real Model Observation Metadata QA

## Summary

- Direction: validate thin observation/result metadata, grep/list_dir factual
  outputs, and trace report scan-vs-explicit-read attribution with a real model
  plus an independent subagent.
- Model: `openai/gpt-5.4-nano` from local SparkWright config.
- Prompt shape: strong read-only CLI prompt requiring `grep` for
  `DCI_MARKER_REALMODEL`, then `read` on the matching file.
- Workspace: `/tmp/sparkwright-real-observation.lzEfXd`, 600 small corpus files
  plus `corpus/doc-0347.txt` containing
  `DCI_MARKER_REALMODEL owner=trace-attribution answer=walnut`.
- Policy: `--access-mode read-only`, `--trace-level debug`.
- Cause buckets used: first run found `product_bug`; fixed and rerun passed.

## Local Runs

### First Run

- Trace:
  `/tmp/sparkwright-real-observation.lzEfXd/.sparkwright/sessions/session_mr25e7zgdonjavye/trace.jsonl`
- Result: completed read-only with no trace/session structural failures, but
  grep returned no matches.
- Evidence: model requested
  `grep {"pattern":"DCI_MARKER_REALMODEL","include":[""]}`; grep output showed
  `filesScanned:0`, `effectiveInclude:[""]`, and no matches.
- Root cause: optional glob arrays accepted blank strings, so model-produced
  `include:[""]` became a match-nothing include filter instead of "no include
  constraint".
- Classification: `product_bug`.

### Fixed Rerun

- Trace:
  `/tmp/sparkwright-real-observation.lzEfXd/.sparkwright/sessions/session_mr25gbedprdr9uu0/trace.jsonl`
- Result: completed read-only and answered `walnut`.
- Stable evidence:
  - `trace verify`: ok.
  - `session check session_mr25gbedprdr9uu0`: ok.
  - No `workspace.write.completed`, `approval.requested`, or `tool.failed`
    events.
  - Tool calls: `grep:1`, `read:1`.
  - Grep output:
    `filesScanned:500`, `filesMatched:1`, `matchesReturned:1`,
    `truncationReason:"file_limit"`, `effectiveInclude:["**/*"]`.
  - Read output opened `corpus/doc-0347.txt` and contained `answer=walnut`.
  - Trace report emitted `WORKSPACE_READ_NOISE` with:
    `workspace reads by tool: grep:500, read:1`,
    `scan reads by tool: grep:500`, and
    `explicit file reads by tool: read:1`.

## Subagent Runs

- Agent: `Bernoulli` (`019f1dfd-7957-7d32-b9a8-3101e01189fc`).
- Strong contract trace:
  `/tmp/sparkwright-dci-sessions.xnhZxs/session_mr25dhs1lepfiql1/trace.jsonl`.
  The run used `tool_search`, `grep`, `glob`, `list_dir`, and `read`; trace
  verify/session check passed; grep/list_dir factual fields were present.
- High-scan attribution trace:
  `/tmp/sparkwright-dci-scan-sessions.ONBQL4/session_mr25epeqhag91ucd/trace.jsonl`.
  Trace verify/session check passed; report evidence split
  `grep:500` scan reads from `read:1` explicit file read.

## Commands

```bash
npm --workspace @sparkwright/host run build
npm --workspace @sparkwright/cli run build
npm --workspace @sparkwright/coding-tools test -- test/index.test.ts
npm --workspace @sparkwright/coding-tools run typecheck
npm --workspace @sparkwright/coding-tools run build
npm --workspace @sparkwright/host test -- test/tools.test.ts -t "capability|catalog|tools"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "trace"
npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx
```

## Stable Assertions

- Real-model tests can assert trace/session health, no writes/approvals, and
  presence/consistency of structured tool output fields.
- High-scan tests can assert trace report evidence for scan-vs-explicit-read
  attribution when `workspace.read` volume triggers `WORKSPACE_READ_NOISE`.
- Do not assert exact prose, exact tool order, token count, or whether the model
  adds harmless `glob`/`tool_search` calls.

## Follow-Up Risks

- `capabilities inspect --format json` summarizes tool exposure and does not
  currently expose `resultPresentation`; runtime descriptors still carry it.
- Observation formatting still needs a broader pass to consume
  `resultPresentation.preserveFields` consistently for read/search/discovery,
  shell, MCP, and tool_search outputs.
- Trace attribution improves diagnosis but does not reduce high-volume
  `workspace.read` event count.
