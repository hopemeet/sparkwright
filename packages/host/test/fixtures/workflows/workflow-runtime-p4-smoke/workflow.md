---
version: 0.1.0
description: P4 workflow-runtime script/node-API smoke pipeline.
nodes:
  - id: p4-smoke
    execute: script
    script:
      path: scripts/p4-smoke.mjs
      timeoutMs: 300000
      maxOutputBytes: 64000
      capabilities: [read, shell]
    onPass: summarize
    onFail: fail
  - id: summarize
    execute: model
    tools: [read]
---

## p4-smoke

Run the P4 script/node-API smoke gates.

## summarize

Summarize the smoke gate output for the maintainer.
