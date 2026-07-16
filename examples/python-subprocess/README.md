# Python Subprocess Integration

A Python integration example for Sparkwright that drives the CLI via `subprocess` and parses JSONL trace output. No third-party packages required — only the Python standard library (Python 3.9+).

## Prerequisites

1. **Node.js** ≥ 18 on your PATH.
2. **Sparkwright built locally**:
   ```bash
   cd <sparkwright-root>
   npm install
   npm run build
   ```
   This produces `packages/cli/dist/index.js`, which the Python scripts locate automatically.

## Quick start

### 1. Direct command-line usage

Run the agent and print a result summary:

```bash
python run_agent.py "inspect this repo and suggest improvements" \
    --workspace ../../examples/repo-pilot \
    --trace-level standard
```

Allow the agent to write files (requires approval):

```bash
python run_agent.py "update the README with a getting-started section" \
    --workspace ../../examples/repo-pilot \
    --access-mode bypass \
    --trace-level standard
```

Full option reference:

```
usage: run_agent.py [-h] [--workspace PATH]
                    [--access-mode {read-only,ask,accept-edits,bypass}]
                    [--trace-level {minimal,standard,debug}]
                    [--timeout SECONDS] [--project-root PATH]
                    [--no-trace-summary]
                    goal

positional arguments:
  goal                Natural-language goal to pass to the agent.

options:
  --workspace PATH    Workspace directory the agent will read/write.
                      Defaults to the current working directory.
  --access-mode       Run autonomy preset (default: read-only).
  --trace-level       minimal | standard | debug  (default: standard)
  --timeout SECONDS   Max seconds to wait for the run (default: 300).
  --project-root PATH Path to the Sparkwright monorepo root.
                      Auto-detected by walking up from this script.
  --no-trace-summary  Suppress the key-events block at the end.
```

Exit codes: `0` = completed, `1` = failed/cancelled, `2` = setup/usage error.

### 2. Importing `SparkwrightClient` as a module

```python
from sparkwright_client import SparkwrightClient

client = SparkwrightClient(
    project_root="/path/to/sparkwright",
    workspace="examples/repo-pilot",
)

# Synchronous run — blocks until the agent finishes
result = client.run(
    "inspect this repo and suggest improvements",
    trace_level="standard",
)

if result.succeeded:
    print("Run completed!")
    print(f"Message: {result.message}")
else:
    print(f"Run {result.state}: {result.stop_reason}")

# Inspect specific event types
for event in result.find_events("tool.completed"):
    payload = event.get("payload", {})
    print(f"Tool {payload.get('toolCallId')} → {payload.get('status')}")

# List artifacts produced by this run
for artifact_event in result.get_artifacts():
    payload = artifact_event.get("payload", {})
    print(f"Artifact: {payload.get('name')} ({payload.get('type')})")

# Read the latest run without triggering a new one
latest = client.get_latest_run()
if latest:
    print(f"Latest run: {latest.run_id}  state={latest.state}")

# Read all events for a specific run by ID
events = client.get_run_events("run_abc123")
```

## Typical output

```
Running: npx sparkwright run inspect this repo --workspace /path/to/repo-pilot --trace-level standard
Workspace: /path/to/repo-pilot

[1] run.created
[2] run.started
[3] tool.requested read
[4] tool.completed read
[5] run.completed final_answer

--- Run result ---
  state:       completed
  stopReason:  final_answer
  message:     Read README.md. Re-run with --access-mode ask to exercise approval-gated workspace mutation.
  run dir:     /path/to/repo-pilot/.sparkwright/runs/run_abc123
  trace:       /path/to/repo-pilot/.sparkwright/runs/run_abc123/trace.jsonl
  result.json: /path/to/repo-pilot/.sparkwright/runs/run_abc123/result.json

--- Key trace events ---
  [1] run.created  run_id=run_abc123
  [2] run.started
  [4] tool.completed  tool=...  status=completed
  [5] run.completed  reason=final_answer
```

## Trace and result file format

Each run writes two key files under `.sparkwright/runs/<run-id>/`:

### `trace.jsonl`

One JSON object per line. Each line is a `SparkwrightEvent`:

```jsonc
{
  "id": "evt_...",
  "runId": "run_...",
  "type": "tool.completed",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "sequence": 4,
  "payload": { "toolCallId": "...", "status": "completed", "output": {...} },
  "metadata": {}
}
```

Common `type` values:

| Type                        | Meaning                                      |
| --------------------------- | -------------------------------------------- |
| `run.created`               | Run record created                           |
| `run.started`               | Agent loop started                           |
| `run.completed`             | Run finished successfully                    |
| `run.failed`                | Run ended with a failure                     |
| `tool.requested`            | Model requested a tool call                  |
| `tool.completed`            | Tool executed and returned a result          |
| `artifact.created`          | The agent produced an artifact (e.g. a diff) |
| `approval.requested`        | Agent is waiting for a human approval gate   |
| `approval.resolved`         | Approval was granted or denied               |
| `workspace.write.completed` | A file write was approved and applied        |

### `result.json`

Structured summary of the terminal run state:

```json
{
  "signal": "completed",
  "state": "completed",
  "stopReason": "final_answer",
  "message": "...",
  "metadata": {}
}
```

`state` is one of `completed`, `failed`, or `cancelled`.

`stopReason` values include `final_answer`, `max_steps_exceeded`, `tool_doom_loop`, `manual_cancelled`, and others (see `packages/core/src/types.ts` for the full list).

### Artifacts

Any diff or file artifact produced during the run is written to `.sparkwright/runs/<run-id>/artifacts/`. The `artifact.created` trace events reference the artifact ID and type.

## Limitations

- **Synchronous only.** The Python layer blocks until the CLI process exits. Streaming event delivery and async iteration will be available when a Sparkwright HTTP adapter is implemented.
- **CLI subprocess overhead.** Each `client.run()` call starts a new Node.js process. For high-throughput batch use cases, a future HTTP adapter will be more efficient.
- **No provider configuration from Python.** To use a real model provider (OpenAI etc.) set `OPENAI_API_KEY` in the environment and pass the appropriate flags through `subprocess` directly, or extend `SparkwrightClient._build_command` as needed.
