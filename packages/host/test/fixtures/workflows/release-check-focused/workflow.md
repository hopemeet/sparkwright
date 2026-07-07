---
version: 0.1.0
description: Focused release-readiness gates for workflow-runtime dogfood.
nodes:
  - id: focused-gates
    execute: script
    script:
      path: scripts/run-focused-gates.mjs
      timeoutMs: 300000
      maxOutputBytes: 64000
      capabilities: [read, shell]
    onPass: summarize
    onFail: { retry: 1, then: fail }
  - id: summarize
    execute: model
    tools: [read]
---

## focused-gates

Run the focused release-readiness gates through the workflow node API.

## summarize

Summarize the focused gate result and call out any follow-up needed before a
full release check.
