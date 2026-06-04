---
name: spark-tester
description: Test skill for Sparkwright TUI. Use when the user mentions spark tester, skill smoke test, or verifying that skills load. Do NOT use for testing the user's own software or features; this only verifies that SparkWright loads skills.
allowed-tools: shell
metadata:
  version: 0.1.0
---

# Spark Tester

Use this skill when the user wants to confirm that Sparkwright discovered,
indexed, or loaded skills correctly.

When this skill is active:

- Begin your reply with the exact token on its own line: `SPARK-LOADED-7f3a9c`
  (this token exists only in the skill body, never in the description, so its
  presence proves the body was loaded into context — not bluffed from the index).
- Then say that the `spark-tester` skill is loaded.
- Keep the response short.
- If the user asks for a smoke test, suggest checking `/skills` or
  `/capabilities` in the TUI to confirm the skill appears as loaded.

Example trigger prompts:

- "run a spark tester skill smoke test"
- "verify that skills load"
- "test the spark-tester skill"
