# 2026-06-29 Real Mini Tool Surface QA

## Summary

- Scenario: broad real-model QA after built-in tool surface consolidation.
- Coverage: CLI/TUI tool discovery, large-file read paging, trace/session diagnostics, capability panel rendering, and write/edit/bash workflow.
- Result: `partial`
- Reusable lesson: the canonical tool surface works for normal discovery and write flows, but strong large-file paging prompts can still drive repeated `read` loops; recovered verification failures can still make trace reports look unhealthy.

## Test Setup

- Task direction: test recent tool changes with realistic CLI/TUI usage, system prompt/tool guidance, trace integrity, and large-file paging.
- Prompt shape: `strong`
- Model class: real provider/model `openai/gpt-5.4-mini`
- Capabilities: default configured catalog, no MCP servers, built-in/user/project Skills indexed.
- Permission/approval posture: read-only for paging/discovery/TUI; `--write --yes` for the isolated coding fixture.
- Workspace/config isolation: temporary fixtures under `/var/folders/.../T/`; coding and TUI paging fixtures used project `runBudget` caps; repo-root discovery used `/tmp/sparkwright-real-cli-toolsearch-sessions`.
- Trace level: `debug`
- Environment notes: user config provided OpenAI through `https://opencode.ai/zen/v1`; pricing remained `missing_pricing`.

## Commands Or Harness

```bash
npm run build --workspace @sparkwright/protocol
npm run build --workspace @sparkwright/core
npm run build --workspace @sparkwright/project-context
npm run build --workspace @sparkwright/host
npm run build --workspace @sparkwright/tui
npm run build --workspace @sparkwright/cli
npm --workspace @sparkwright/core test -- test/tool-search.test.ts test/context.test.ts test/run.test.ts test/trace.test.ts
npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts
npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx test/tool-request-preview.test.ts test/format-event.test.ts test/transcript.test.ts
npm run schema:check
npm run check:dist-fresh
node packages/cli/dist/index.js capabilities inspect --workspace . --model openai/gpt-5.4-mini --format text
node packages/cli/dist/index.js run "<large-file read + grep prompt>" --workspace <tmp-tool-fixture> --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js run "<tool_search + list_skills prompt>" --workspace . --session-root /tmp/sparkwright-real-cli-toolsearch-sessions --access-mode read-only --model openai/gpt-5.4-mini --trace-level debug
python3 /Users/guowangxie/.codex/skills/sparkwright-tui-real-qa/scripts/tui_screen.py --cmd 'node packages/cli/dist/index.js tui ...'
node packages/cli/dist/index.js run "<fix failing cart tests>" --workspace <tmp-coding-fixture> --write --yes --model openai/gpt-5.4-mini --trace-level debug
```

## Stable Evidence

- Focused gates passed: core 253 tests, host 176 tests, CLI 131 tests, TUI 25 tests; schema check validated 22 schemas and 15 instances; `check:dist-fresh` reported fresh output for 26 workspaces.
- Capability inspect for `openai/gpt-5.4-mini` reported 21 runtime tools with canonical public names (`read`, `write`, `edit`, `bash`, `glob`, `grep`) plus deferred advanced tools and infrastructure `tool_search` / `skill_load`.
- CLI discovery trace `/tmp/sparkwright-real-cli-toolsearch-sessions/session_mqyrchhmqntmlqjy/trace.jsonl` completed with `trace verify ok`, 4 tool calls (`tool_search` x2, `list_skills`, `read`), no approvals, no writes, and final answer listing skills.
- TUI `/capabilities` PTY rendered the active mini model and missing-pricing warning without raw JSON or obvious border overlap.
- TUI paging trace `<tui-readloop-fixture>/.sparkwright/sessions/session_tui_mqyrfowz/trace.jsonl` passed `trace verify` and `session check`; terminal failure was a clean `run.failed` with `MAX_STEPS_EXCEEDED`.
- CLI coding trace `<coding-fixture>/.sparkwright/sessions/session_mqyrizf47rwggdee/trace.jsonl` passed `trace verify`, recorded 1 managed workspace write to `src/cart.js`, 3 auto-approved approvals, and independent `npm test --prefix <fixture>` passed afterward.

## Non-Invariants Observed

- The large-file read loop varied by surface: CLI alternated `offset=1` and `offset=2001` until manually terminated after 23 `read` calls; TUI reached `offset=4001` once, then repeated earlier windows and hit the 6-call budget.
- Mini sometimes issued a redundant second `tool_search select:list_skills` after `list_skills` was already callable; the final discovery run still completed correctly.
- TUI `/capabilities` overview says `5 public` because it excludes risky public-tier `bash`; CLI/catalog report `bash` as `tier=public`, so the TUI wording is ambiguous.

## Failures

- Failure pattern: [../failures/prompt-induced-tool-loop.md](../failures/prompt-induced-tool-loop.md)
- Cause bucket: `product_bug`
- Count update: +2 for CLI and TUI large-file read paging loops under strong prompts.

- Failure pattern: [../failures/trace-recovered-verification-command-failure.md](../failures/trace-recovered-verification-command-failure.md)
- Cause bucket: `product_bug`
- Count update: +1 for `trace report` returning `passed_with_issues` after an expected initial `npm test` failure was recovered by a later successful `npm test`.

## Coverage Update

- Page: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Change: add weak area for recovered verification command failures still downgrading report verdicts.
- Page: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Change: add weak area for capability panel public-vs-high-risk tool grouping wording.

## Follow-Up

- Consider making repeated unchanged `read` feedback key on the full window (`path`, `offset`, `limit`) and collapse repeated `run.health` summaries in selected context.
- Consider a runtime guard or stronger model-visible intervention after repeated read windows when no writes occurred and trace report would already classify low net progress.
- Decide whether `trace report` should treat an initial failed verification command as recovered when a later same-command verification succeeds after a managed write.
- Clarify TUI capability overview wording: either count `defaultExposureTier=public` tools including risky public tools, or label the current count as `safe public`.
