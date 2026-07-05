# 2026-06-28 Governance P0/P1 QA

## Summary

- Scenario: follow-up QA after the read-only safe-read policy fix, focusing on
  tool governance, MCP, TUI approval states, cron unattended denials, delegates,
  and resume/session gates.
- Result: `pass`
- Cause buckets: no product bug found. One manual cron smoke first used invalid
  `--model scripted` for a cron command and was classified as `test_bug`; rerun
  with `deterministic/demo` reached runtime.

## Stable Evidence

- CLI read-only matrix in temporary workspaces:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sw-readonly-matrix-u4NrtO`.
  Safe `read_file`/`glob`/`list_dir`/`grep` completed with 0 approvals and 0
  writes. `write_file`, `create_agent`, `create_skill`, shell redirect, and a
  corrected `apply_patch` call were denied or failed before workspace writes.
- MCP read-only external/network guard:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sw-mcp-readonly-clbieE/.sparkwright/sessions/session_mqxsvmowmpoh1r4z/trace.jsonl`.
  A concrete MCP tool configured with `defaultPolicy.risk=safe` still requested
  approval because its governance side effects were external/network; the
  non-interactive run denied it, completed no MCP tool, and wrote nothing.
- TUI ask-mode shell denial:
  `/tmp/sw-tui-approval.k5z7tJ/.sparkwright/sessions/session_tui_mqxsw34v/trace.jsonl`.
  PTY showed the shell approval panel; trace verify passed with 1 denied shell
  approval, 0 writes, and no created target file.
- TUI ask-mode workspace-write approval:
  `/tmp/sw-tui-write-approve.LRQPVy/.sparkwright/sessions/session_tui_mqxszjm4/trace.jsonl`.
  PTY showed a `workspace.write` diff approval; approving produced one
  `workspace.write.completed` and changed the fixture README.
- TUI bypass shell:
  `/tmp/sw-tui-bypass.IknXb7/.sparkwright/sessions/session_tui_mqxt0co6/trace.jsonl`.
  Trace verify passed with `autoApproved=true` for shell approval. The shell
  still failed because mutation audit caught an unmanaged workspace write; the
  target file was rolled back/absent.
- Cron unattended denial:
  `/tmp/sw-cron-ws.GP5ukL/.sparkwright/sessions/cron-3b0f86b03214/trace.jsonl`.
  `cron run` with `deterministic/demo` attempted a write despite a read-only
  prompt; non-interactive approval denial left `lastStatus:"error"`, 0
  `workspace.write.completed`, and the README unchanged.

## Focused Gates

```bash
npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/tools.test.ts -t "spawn_agent|delegate_agent|delegate_parallel|write-capable delegates|read-only configured delegates|parent approval"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegate|agents|spawn_agent|capabilities inspect|read-only access mode"
npm --workspace @sparkwright/core test -- test/policy.test.ts test/trace.test.ts -t "approval|tool|subagent|delegate|workspace.write|run.completed"
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t cron
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "cron|durable"
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "run resume|session resume|resume through the host|replay-derived context|from-trace"
npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "run.resume|session.inspect|compacts completed session|stale compact|unsafe session"
```

## Non-Invariants Observed

- Bypass mode auto-approves approval prompts, but shell mutation audit can still
  fail and roll back unmanaged workspace writes. Do not assert shell completion
  for redirect writes unless the scenario explicitly permits unmanaged
  workspace mutation.
- Cron commands reject short test-only model refs such as `scripted`; use a
  provider/model-shaped ref like `deterministic/demo` for CLI cron smokes.
- Real or deterministic models may attempt edits despite read-only wording; the
  invariant is policy/approval outcome and workspace state, not model intent.

## Remaining Useful Follow-Up

- Add a deterministic regression for MCP `defaultPolicy.risk=safe` plus
  external/network side effects under `--access-mode read-only`.
- Add a cross-run resume test that starts from a write-enabled checkpoint and
  resumes with `--access-mode read-only`, asserting the resumed run metadata and
  write denial. Existing resume gates passed, but this exact access-mode
  transition is still only covered indirectly.
