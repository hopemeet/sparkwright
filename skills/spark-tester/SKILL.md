---
name: spark-tester
description: Test skill for Sparkwright TUI. Use when the user mentions spark tester, skill smoke test, or verifying that skills load.
allowed-tools: shell
metadata:
  version: 0.1.0
---

# Spark Tester

Use this skill when the user wants to confirm that Sparkwright discovered,
indexed, or loaded skills correctly.

When this skill is active:

- Say that the `spark-tester` skill is loaded.
- Keep the response short.
- If the user asks for a smoke test, suggest checking `/skills` or
  `/capabilities` in the TUI to confirm the skill appears as loaded.

Example trigger prompts:

- "run a spark tester skill smoke test"
- "verify that skills load"
- "test the spark-tester skill"
