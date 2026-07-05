# 2026-06-29 Real Mini Remaining Tool QA

## Summary

- Scenario: continued QA for uncertain/untested tool and TUI areas after the
  initial tool-surface follow-up.
- Coverage: large read pagination, prompt/tool visibility, trace report
  diagnostics, recovered verification, and TUI slash panels.
- Result: `partial-pass`
- Reusable lesson: the tool transport can be correct while the model-visible
  context is wrong; large-file tests must inspect both `tool.completed` and
  `prompt.built`.

## Test Setup

- Model: real `openai/gpt-5.4-mini`.
- Workspaces: isolated temp fixtures under `/var/folders/.../T/`.
- Trace level: `debug` for model runs.
- TUI harness: `sparkwright-tui-real-qa/scripts/tui_screen.py` with pyte screen
  reconstruction.

## Commands Or Harness

```bash
node packages/cli/dist/index.js run "<read PROJECT_NOTES.md using nextOffset>" --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<is tool_search callable?>" --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<npm test, fix, npm test>" --access-mode bypass --model openai/gpt-5.4-mini --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --rows 20 --cols 60 --cmd 'node packages/cli/dist/index.js tui --session-root <custom-root> ...' --script '[[1.0,"/sessions"],[0.8,"\r"],[1.5,"__DUMP__"]]'
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --rows 26 --cols 80 --cmd 'node packages/cli/dist/index.js tui ...' --script '[[1.0,"/capabilities"],[0.8,"\r"],[1.0,"d"],[0.5,"__DUMP__"]]'
```

## Stable Evidence

- Failed pre-fix pagination trace:
  `/var/folders/.../sparkwright-mini-pagination-rerun-cUJxxT/.sparkwright/sessions/session_mqz1u8owkgk01glc/trace.jsonl`.
  The fourth read output contained the needle, but `prompt.built` did not.
- Passing post-fix pagination trace:
  `/var/folders/.../sparkwright-mini-pagination-visible-KwW3y9/.sparkwright/sessions/session_mqz1zrfusdr8ok00/trace.jsonl`.
  Read windows advanced `1-1000`, `1001-2000`, `2001-3000`, `3001-4000`,
  `4001-4995`; final answer was `FOUND: line 4300 —
  NEEDLE_PAGE_3=alpha-4300`; `trace report` and `trace verify` were ok.
- Disabled discovery trace:
  `/var/folders/.../sparkwright-mini-disabled-toolsearch-1mSpwo/.sparkwright/sessions/session_mqz24kjtxlqis6pz/trace.jsonl`.
  `tool_descriptors` omitted `tool_search`, `capability_delta` count was 0,
  no tools were called, report/verify were ok.
- Recovered verification bypass trace:
  `/var/folders/.../sparkwright-mini-recovered-verify-bypass-dkrBtm/.sparkwright/sessions/session_mqz263elqya24adr/trace.jsonl`.
  First `npm test` exited 1, final `npm test` exited 0, summary showed
  `verification.unresolved=0`, and report did not emit `COMMAND_FAILURES`.
- TUI `/sessions` at 60 columns showed the custom session root path in the
  empty state and wrapped it without obvious overlap.
- TUI `/capabilities` showed `Tool map: 6 public, 13 on demand, 2
  infrastructure, 5 approval/high-risk`; detail page included
  `bash · risky · public`.
- Noninteractive `accept-edits --yes` coding trace:
  `/var/folders/.../sparkwright-mini-accept-yes-6HIJrk/.sparkwright/sessions/session_mqz6ytrll7inb8et/trace.jsonl`.
  Two bash approvals were auto-approved by `--yes`, first `npm test` exited 1,
  final `npm test` exited 0, report/verify were ok.
- Mixed shell failure trace:
  `/var/folders/.../sparkwright-mini-mixed-shell-3mQn9F/.sparkwright/sessions/session_mqz70gqtiydg6uhj/trace.jsonl`.
  The run intentionally repeated a failing `node -e` probe, recovered `npm test`
  after a write, and also had one unresolved invalid `glob` call. After the fix,
  report keeps `COMMAND_FAILURES` and `REPEATED_COMMAND_FAILURES` but no longer
  emits `UNRESOLVED_VERIFICATION_FAILURES` for the `node -e` probe.
- Standard-trace pagination:
  `/var/folders/.../sparkwright-mini-pagination-standard-9wdjAx/.sparkwright/sessions/session_mqz77t2rvumteui0/trace.jsonl`.
  Mini found `NEEDLE_STANDARD` at line 2500; report/verify were ok. Standard
  trace keeps summarized tool/prompt payloads, so use debug when diagnosing
  exact prompt visibility.
- Tool-search negative path:
  `/var/folders/.../sparkwright-mini-toolsearch-negative-1fqwqK/.sparkwright/sessions/session_mqz78u67iqrc1tdt/trace.jsonl`.
  Mini called `tool_search select:append_file` once, received `matches: []`,
  stopped without writes, and report/verify were ok.

## Failures

- Failure pattern:
  [../failures/paginated-read-context-window-hidden.md](../failures/paginated-read-context-window-hidden.md)
- Cause bucket: `product_bug`
- Count update: +1.

- Failure pattern:
  [../failures/trace-sequential-pagination-low-progress.md](../failures/trace-sequential-pagination-low-progress.md)
- Cause bucket: `product_bug`
- Count update: +1.

- Failure pattern:
  [../failures/node-e-probe-verification-misclassified.md](../failures/node-e-probe-verification-misclassified.md)
- Cause bucket: `product_bug`
- Count update: +1.

## Non-Invariants Observed

- In noninteractive CLI with `--access-mode accept-edits`, bash still requires
  approval and is denied because stdin is not interactive. Use `bypass` for
  fully automated verification fixtures, or test approval UX through TUI.
- In noninteractive CLI with `--access-mode accept-edits --yes`, bash approvals
  are auto-approved and the same coding/verification fixture can complete
  cleanly. Treat missing `--yes` as a harness precondition, not a product bug.
- The recovered-verification real run still produced `LOW_NET_PROGRESS` because
  mini reread the same tiny file window several times and delayed verification
  by two model turns after writing. This is model/process efficiency evidence,
  not a recovered command-failure misclassification.
- Standard trace is sufficient for report/verify and final behavior checks, but
  it intentionally summarizes prompt/tool payloads; use debug trace for
  content-visibility investigations.

## Coverage Update

- Page: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Change: add coverage for recovered verification real trace and sequential
  pagination not triggering duplicate-read low progress; add mixed shell
  failure coverage for `node -e` probes and stale command outcome snapshots.
- Page: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Change: real PTY verification for custom session root empty state and
  `/capabilities` public/high-risk overlays.
- Page: [../coverage/shell.md](../coverage/shell.md)
- Change: clarify noninteractive `accept-edits --yes` auto-approval behavior
  and `node -e` probe classification.

## Follow-Up

- Consider documenting that noninteractive `accept-edits` shell verification
  requires `--yes`; without it, approval denial is expected.
- Keep large-file read regressions checking prompt visibility, not only tool
  payloads.
