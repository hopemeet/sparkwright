# Hook Command Telemetry Protocol Proposal

Status: Implemented (P0/P1)
Date: 2026-06-28

> Internal planning document. This proposal does not change runtime behavior by
> itself. It replaces the current process progress JSONL inbox where that inbox
> exists, and adds the same stdio progress parser to live process streams.

## Implementation Status

Implemented on 2026-06-28. `TracedProcessRunner` now injects
`SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1` and
`SPARKWRIGHT_EVENT_TOKEN=SPARKWRIGHT_EVENT`; parses stderr token lines across
raw child processes, sandbox streaming collection, and live
`observeStreaming()`; strips reserved token lines from stderr output surfaces;
and no longer creates or polls `SPARKWRIGHT_TRACE_EVENTS` JSONL inbox files.
Workflow command hooks keep stdout as the `stdoutJson` control plane, while
stderr token lines provide progress observation. The "Current Facts" section
below records the pre-implementation state for historical context.

## Purpose

User-authored scripts need two different channels:

- **control**: tell SparkWright what to do next, such as continue, block,
  rewrite, or skip;
- **observation**: report live progress while the script is running.

SparkWright already has the first channel for configured workflow command hooks:
`resultMode: "stdoutJson"` parses stdout as a final `WorkflowHookResult`. In
the normal traced-process `run()` path, the second channel currently exists
through `SPARKWRIGHT_TRACE_EVENTS`, a temp JSONL inbox that child processes
append to and the host polls. In live streaming paths, especially
`observeStreaming()`, there is no inbox today; stderr chunks are forwarded live.

The proposed replacement is:

- **stdout JSON = control plane** for final workflow-hook decisions;
- **stderr token lines = real-time observation plane** for progress.

Because this project does not yet have external usage depending on
`SPARKWRIGHT_TRACE_EVENTS`, the recommendation is to delete the JSONL inbox
rather than carrying a long compatibility branch.

## Read Before Reviewing

- [project map: host](../project-map/modules/host.md)
- [project map: core](../project-map/modules/core.md)
- [project map: raw trace](../project-map/maps/trace/raw-trace.md)
- [project map: summary/timeline/verify](../project-map/maps/trace/summary-timeline-verify.md)
- [project map: tool orchestration](../project-map/maps/runtime/tool-orchestration.md)
- [project map: capability maps](../project-map/maps/capabilities/README.md)
- [`packages/host/src/traced-process-runner.ts`](../../../packages/host/src/traced-process-runner.ts)
- [`packages/host/src/workflow-hooks.ts`](../../../packages/host/src/workflow-hooks.ts)
- [`packages/core/src/workflow-hooks.ts`](../../../packages/core/src/workflow-hooks.ts)
- [`packages/core/src/trace-store.ts`](../../../packages/core/src/trace-store.ts)
- [`packages/core/src/trace-codec.ts`](../../../packages/core/src/trace-codec.ts)
- [`docs/guides/CONFIGURATION.md`](../../guides/CONFIGURATION.md)

## Current Facts

### `stdoutJson` already exists, but only as hook control

For workflow command actions, `packages/host/src/workflow-hooks.ts` runs the
command through the traced process runner. If `resultMode === "stdoutJson"` and
the command succeeds, stdout is parsed as a `WorkflowHookResult`:

```json
{ "status": "block", "reason": "tests failed" }
```

Accepted statuses are `continue`, `block`, `rewrite`, and `skipped`. Malformed
JSON follows the hook action's `onError` path. Event hooks under
`capabilities.hooks.events` do not control the main run; they emit
`user_hook.*` evidence and are non-blocking.

Stdout is therefore a good final decision channel. It is not a good live
telemetry channel when `stdoutJson` is enabled, because any log line on stdout
corrupts the control result.

### Live script telemetry currently uses a JSONL temp-file inbox

`TracedProcessRunner.run()` currently creates a temp directory and
`events.jsonl`, injects these environment variables, and polls the file while
the child runs:

```txt
SPARKWRIGHT_TRACE_PROTOCOL=extension-jsonl-v1
SPARKWRIGHT_TRACE_INVOCATION_ID=proc_...
SPARKWRIGHT_TRACE_EVENTS=/tmp/.../events.jsonl
```

The child may append JSONL lines such as:

```json
{"type":"progress","message":"running tests","data":{"target":"unit"}}
```

The host reads newly appended bytes by offset, line-splits, validates a bounded
`progress` object, emits `extension.process.progress` by default, and increments
`progressDropped` for invalid, oversized, or over-limit lines.

At standard trace level, `extension.process.progress` is not persisted as raw
rows. `trace-store.ts` folds it into the terminal
`extension.process.completed` / `extension.process.failed` event as
`progressHead`, `progressTail`, `progressCount`, and `progressDropped`. Debug
traces keep the raw progress rows.

External command delegates call the same runner with `emitLifecycle: false`.
Their progress is summarized into delegate/subagent output rather than
persisting `extension.process.*` lifecycle rows.

### Public commitment sweep

The process progress inbox is currently documented in:

- `docs/reference/PROTOCOL.md`
- `docs/reference/TRACE_EXTENSION_EVENTS.md`

Existing `events.jsonl` references in session docs describe the session event
store, not the process progress inbox. Tests also assert the old
`SPARKWRIGHT_TRACE_EVENTS` behavior and should be rewritten with the new stderr
token protocol.

This closes the old-inbox compatibility question: update the two public
reference docs, the map pages, and tests in the same implementation change; do
not keep a legacy inbox mode for external compatibility. The new stdio protocol
should still be future-compatible across workflow hooks, event hooks, Skill
scripts, external delegates, and future process-backed agents.

## Cost Model

This change is not a pure resource win.

The current JSONL inbox has a fixed per-process cost:

- create temp dir and file;
- hold an open file handle;
- start a 50ms polling timer;
- perform positional reads even when the script is quiet;
- keep partial-line state and cleanup logic;
- add sandbox write access for the temp inbox directory.

For `executeRaw()` and sandboxed `collectStreamingResult()`, the stderr-token
path replaces the old inbox and removes the idle polling, temp-file lifecycle,
and sandbox `allowWrite` exception. That is especially useful for sandboxed
process execution.

The tradeoff is that stderr becomes a hot path. Today ordinary stderr chunks are
mostly appended as chunks. To strip reserved telemetry lines, the host must run
stderr through a line-aware parser, maintain per-stream partial-line buffers,
and check line prefixes. The work becomes proportional to stderr volume and
line count. For quiet or structured scripts this is cheaper and simpler; for
very noisy stderr it can cost more CPU than the old idle poller.

For `observeStreaming()` this is not an inbox replacement; it is a new live
stream parser. That path currently appends each stdout/stderr chunk, calls
`onOutput()`, and emits chunk progress immediately. Token parsing means a
partial stderr line may need to be held until newline or stream close before it
can be forwarded. This can add small buffering latency to live task output, and
it is the main UX tradeoff of the design.

The reason to make this change is therefore not "always cheaper". It is:

- fewer process-side channels;
- no temp writable path inside sandboxed runs;
- simpler user authoring;
- one host-owned validation path;
- cost that scales with actual stderr output instead of a timer per process.

## Goals

- Keep hook decisions deterministic and easy to parse.
- Make live progress stream over an already-open process channel.
- Delete the temp JSONL progress inbox where `run()` currently creates it.
- Keep one stdio observation protocol across hooks, Skills, delegates, and
  future process-backed agents.
- Avoid letting scripts forge arbitrary SparkWright trace events.
- Preserve current standard/debug trace folding behavior.
- Give users helpers that express intent: `progress()`, `block()`,
  `rewrite()`, `continue_()`, `skipped()`.

## Compatibility Posture

"Compatible" here means future-compatible, not legacy-inbox compatible.

Keep the wire protocol generic and stable:

- token name: `SPARKWRIGHT_EVENT`;
- protocol hint: `SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1`;
- record shape: JSON object with a required `type`;
- P0 accepted type: `progress`;
- unknown future `type` values: dropped and counted through `progressDropped`,
  not treated as process failure.

That leaves room for future agent/workflow use without changing channels. A
later event family can accept `phase`, `diagnostic`, or `metric` over the same
stderr token line if those semantics become real trace contracts.

Versioning rule:

- adding a new record `type` is backward-compatible within `stdio-v1` because
  older hosts drop unknown types and count them;
- changing the line framing, token syntax, JSON envelope, or stdout/stderr
  channel assignment requires a new protocol value such as `stdio-v2`.

## Non-Goals

- Do not make stdout logs valid when `resultMode: "stdoutJson"` is enabled.
  Stdout remains the final control document in that mode.
- Do not let user scripts choose run ids, trace ids, spans, sequence numbers, or
  event type names.
- Do not add a general "write any trace event" API.
- Do not define `phase`, `diagnostic`, or `metric` semantics in P0. Those names
  should wait for either a first-class event family or a deliberate
  forward-compatible telemetry contract.
- Do not require an HTTP server, socket server, or long-lived sidecar process
  for ordinary hook scripts.

## Proposed Protocol

### 1. Control plane: stdout JSON

For workflow command hooks:

```yaml
capabilities:
  hooks:
    workflow:
      - name: guard-shell
        hook: PreToolUse
        action:
          type: command
          command: python3 .sparkwright/hooks/guard_shell.py
          stdin: json
          resultMode: stdoutJson
```

The script prints exactly one JSON object to stdout:

```json
{ "status": "continue" }
```

or:

```json
{
  "status": "block",
  "reason": "Refusing destructive shell command outside the workspace."
}
```

This channel is consumed by `workflow-hooks.ts`. It is authoritative only for
workflow hooks and only after host-side lifecycle/effect validation.

### 2. Observation plane: stderr token lines

Any traced process may write structured progress to stderr with this line shape:

```txt
SPARKWRIGHT_EVENT: {"type":"progress","message":"running eslint"}
```

Grammar:

```txt
record-line = line-start token ":" SP json-object line-end
line-start  = start of stream or immediately after "\n"
line-end    = "\n", "\r\n", or final stream flush
token       = "SPARKWRIGHT_EVENT" by default
json-object = UTF-8 JSON object, bounded by host line/data limits
```

The token is discoverable through an environment variable without embedding
meaningful trailing whitespace:

```txt
SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1
SPARKWRIGHT_EVENT_TOKEN=SPARKWRIGHT_EVENT
```

Accepted P0 record shape:

```ts
type ProcessTelemetryRecord = {
  type: "progress";
  message?: string;
  data?: Record<string, unknown>;
};
```

`stdio-v1` accepts only `type: "progress"` in P0. Other `type` values are
reserved for forward compatibility. They are dropped, counted through
`progressDropped`, and must not fail the process.

Host normalization maps accepted records onto the existing `ProgressChunk`
path:

```ts
{
  channel: "event",
  message: raw.message || "progress",
  data: sanitizedData
}
```

No new core event family is required in P0. Standard traces continue folding
progress into the terminal process event; debug traces can retain raw
`extension.process.progress` rows.

### 3. Reserved token behavior

Lines without `SPARKWRIGHT_EVENT:` remain ordinary stderr output.

Lines with the reserved token are treated as telemetry attempts:

- valid `progress` records are parsed, bounded, and emitted as observations;
- unsupported types, invalid JSON, oversized records, and over-limit records
  increment `progressDropped`;
- reserved token lines are not copied into any normal external stderr surface:
  output previews, output artifacts/logs, `onOutput()` live stream events, or
  chunk-derived task output.

To avoid a DX black box, debug traces should retain a small bounded sample of
dropped token records on the terminal process event. The sample should include a
drop reason and a truncated raw preview, for example:

```ts
progressDroppedSamples?: Array<{
  reason: "invalid_json" | "unsupported_type" | "line_too_large" | "data_too_large" | "limit_exceeded";
  preview: string;
}>;
```

Standard traces should keep only the count. Debug samples must be bounded,
truncated, and run through the same trace redaction/sanitization policy as other
debug process payload.

The terminal process output still reports normal stderr text. Telemetry counts
and drops are reported through existing process summary fields.

### 4. Line-start behavior

The token is line-start anchored. A raw script that writes:

```txt
partial stderr without newlineSPARKWRIGHT_EVENT: {...}
```

has not emitted a valid progress record; the whole line is ordinary stderr.

The recommended helper should protect users from this by writing a leading
newline before each token line, then the token line, then a trailing newline.
That may add a line break to ordinary live stderr if the script previously wrote
a partial line, but it avoids leaking token JSON into user/model-facing output
and makes the progress record reliable.

### 5. Forgery boundary

A child process can emit false progress about itself, because progress is
untrusted process output. The host must treat it as an observation, not an
independent fact.

The child still cannot forge arbitrary SparkWright trace events: the host owns
event type, run id, trace id, span id, sequence, timestamp, lifecycle placement,
redaction, and standard/debug trace filtering.

## Runtime Flow

```txt
configured hook / skill inline shell / external delegate
  -> TracedProcessRunner
       -> stdout collector
            -> parsed as WorkflowHookResult only when resultMode=stdoutJson
       -> stderr telemetry parser
            -> token line: normalize progress -> onProgress()
            -> normal line: append to stderr collector
       -> process lifecycle result
            -> standard trace folds progress into terminal event
            -> debug trace keeps raw progress rows
```

The parser must be a shared host helper with per-stream state. There are three
stderr pipelines today:

- `executeRaw()` child-process stderr events;
- `observeStreaming()` live sandbox/shell stream observation;
- `collectStreamingResult()` sandbox streaming collection.

Each path needs its own parser instance and half-line buffer. Final process
cleanup must flush a final unterminated line so a script does not need to end
with a newline to report its last progress record.

The helper should return two outputs for each stderr input chunk:

- forwardable stderr text, with reserved token lines removed;
- normalized progress chunks to emit through `onProgress`.

`observeStreaming()` must use the forwardable text for every external live
surface: collector append, `onOutput()`, and chunk-derived progress/task output.
Token records must not leak into live delegate/task output.

Close ordering matters. Any progress parsed from final flushes, plus any
async `onProgress` work, must complete before `extension.process.completed` or
`extension.process.failed` is emitted, preserving the old `drainChain` /
final-drain guarantee.

For workflow hooks, the control result and observations are independent:

- stderr progress can stream while the command runs;
- stdout is parsed once after success;
- a malformed progress line does not corrupt the control result;
- a malformed stdout JSON control result still follows `onError`.

## Concrete Example

### Config

```yaml
capabilities:
  hooks:
    workflow:
      - name: block-dangerous-shell
        hook: PreToolUse
        onError: block
        action:
          type: command
          command: python3 .sparkwright/hooks/block_dangerous_shell.py
          stdin: json
          resultMode: stdoutJson
```

### Script

```python
#!/usr/bin/env python3
import json
import os
import sys

TOKEN = os.environ.get("SPARKWRIGHT_EVENT_TOKEN", "SPARKWRIGHT_EVENT")


def progress(message, data=None):
    record = {"type": "progress", "message": message}
    if data:
        record["data"] = data
    sys.stderr.write("\n" + f"{TOKEN}: " + json.dumps(record, separators=(",", ":")) + "\n")
    sys.stderr.flush()


def finish(result):
    print(json.dumps(result, separators=(",", ":")), flush=True)


payload = json.load(sys.stdin)
hook_payload = payload.get("payload", {})
tool_name = hook_payload.get("toolName")
args = hook_payload.get("arguments", {})
command = args.get("command", "")

progress("checking shell policy", {"toolName": tool_name})

if "rm -rf /" in command or "curl " in command and "| sh" in command:
    progress("blocked dangerous shell command", {"code": "dangerous_shell"})
    finish({
        "status": "block",
        "reason": "Shell command matches the project's dangerous-command policy.",
    })
else:
    progress("shell policy passed")
    finish({"status": "continue"})
```

### What happens

1. Host sends hook input on stdin because `stdin: json`.
2. Script writes live progress records to stderr with `SPARKWRIGHT_EVENT:`.
3. Host parses those records as process observations.
4. Script writes the final `WorkflowHookResult` to stdout.
5. `workflow-hooks.ts` parses stdout and returns `block` or `continue`.
6. Standard trace stores a bounded progress summary on the terminal process
   event; debug trace can keep the raw progress rows.

## Helper API

Raw token lines should be documented as the wire format, not the recommended
authoring interface.

Add small helper packages/snippets with these APIs:

```ts
progress(message: string, data?: Record<string, unknown>): void;

continue_(context?: string | Record<string, unknown>): WorkflowHookResult;
block(reason: string, metadata?: Record<string, unknown>): WorkflowHookResult;
rewrite(payload: unknown, reason?: string): WorkflowHookResult;
skipped(reason?: string): WorkflowHookResult;
emitResult(result: WorkflowHookResult): never;
```

`continue_` keeps the helper API usable in both Python and JavaScript/TypeScript
without colliding with the `continue` keyword.

Recommended packaging:

- `@sparkwright/scriptkit` for Node/TypeScript scripts, with generic process
  progress helpers plus workflow-result helpers.
- A tiny vendorable Python module in docs/examples first; promote to a package
  only if real users need package distribution.
- Shell helper functions in docs, not a `sparkwright hook progress` CLI for
  every progress line. A CLI helper is easy to understand but expensive if
  called once per line.

The helper reads `SPARKWRIGHT_EVENT_TOKEN` and writes line-start-safe progress
to stderr. It writes control results to stdout only when the script explicitly
calls `emitResult()`.

## Documentation And Authoring UX Contract

The public authoring docs should be helper-first. Most users and AI-authored
scripts should not need to remember `SPARKWRIGHT_EVENT:` or the line-framing
rules. The raw token line is the wire protocol and debugging escape hatch, not
the preferred daily API.

### Guide docs

Add a short "script authoring model" section near workflow hook configuration:

```txt
stdout = final workflow control result when resultMode: "stdoutJson" is enabled
stderr = live progress through the script helper
```

The primary example should show helpers:

```python
from sparkwright_scriptkit import block, continue_, emit_result, progress

progress("checking policy")

if failed:
    emit_result(block("Policy failed"))

emit_result(continue_())
```

The guide should explicitly warn:

- do not print progress to stdout when `resultMode: "stdoutJson"` is enabled;
- do not hand-author future record types such as `phase` in `stdio-v1`;
- progress is process self-reporting, not an independently verified fact;
- emit one final workflow result on stdout.

### Debugging docs

If progress does not appear, users should be pointed to debug traces. Debug
traces keep bounded dropped-token samples with reasons such as:

- `invalid_json`;
- `unsupported_type`;
- `line_too_large`;
- `data_too_large`;
- `limit_exceeded`.

Standard traces should be described as count-only for dropped progress.

### Reference docs

Reference docs may show the wire protocol:

```txt
SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1
SPARKWRIGHT_EVENT_TOKEN=SPARKWRIGHT_EVENT

SPARKWRIGHT_EVENT: {"type":"progress","message":"running tests"}
```

They should also state the protocol contract:

- `stdio-v1` accepts only `type: "progress"` in P0;
- unknown `type` values are forward-compatible reservations and are dropped
  with `progressDropped`;
- adding a record type is compatible within `stdio-v1`;
- changing framing, token syntax, envelope, or channel assignment requires a
  protocol bump;
- token lines are stripped from preview, artifacts/logs, `onOutput()`, and task
  output;
- line endings may be `\n`, `\r\n`, or final stream flush;
- token matching is line-start anchored.

### AI-facing examples

Built-in manual/Skill examples should show helpers only, unless the page is
specifically a protocol reference. AI tends to copy example shape; raw token
examples in high-level docs increase the chance of stdout/stderr mixups,
unsupported `type` values, and malformed JSON.

### Internal-only details

Keep these details out of user-facing guide docs unless debugging demands them:

- `executeRaw()`, `observeStreaming()`, and `collectStreamingResult()` wiring;
- parser half-line buffer internals;
- close-ordering implementation;
- trace-store folding internals.

## Implementation Plan

### P0: replace the JSONL inbox and add live stderr progress

- Add a shared `ProcessTelemetryParser` helper owned by host.
- Wire the helper into all three stderr paths:
  - `executeRaw()`;
  - `observeStreaming()`;
  - `collectStreamingResult()`.
- Keep parser state per stderr stream, not global.
- Strip accepted/reserved token lines from all external stderr surfaces:
  previews, output artifacts/logs, `onOutput()` live stream events, and
  chunk-derived task output.
- Accept both `\n` and `\r\n`, and treat final stream flush as a line ending.
- Keep token parsing line-start anchored; rely on helpers to write
  line-start-safe token records.
- In `observeStreaming()`, document and test the intentional buffering of
  partial stderr lines before live forwarding.
- Await final parser flush and async progress emission before process lifecycle
  completion events are emitted.
- Keep a bounded debug-only sample of dropped token records on terminal process
  events; standard traces keep only `progressDropped`.
- Reuse existing progress limits:
  - max progress events;
  - max line bytes;
  - max data bytes;
  - progress dropped count.
- Normalize accepted records to the current `ProgressChunk` shape.
- Inject `SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1` and
  `SPARKWRIGHT_EVENT_TOKEN=SPARKWRIGHT_EVENT`.
- Delete the JSONL inbox implementation:
  - `SPARKWRIGHT_TRACE_PROTOCOL`;
  - `SPARKWRIGHT_TRACE_EVENTS`;
  - `createInbox()`;
  - `drainInbox()`;
  - `parseProgressLine()`;
  - sandbox `withInboxWrite()` special handling.

This is not additive. It is a cleanup replacement, chosen because there is no
external compatibility requirement yet.

### P1: update docs and examples in the same change

- Update `docs/reference/PROTOCOL.md`.
- Update `docs/reference/TRACE_EXTENSION_EVENTS.md`.
- Update `docs/guides/CONFIGURATION.md` with the helper-first
  control/observation authoring model.
- Update built-in manual/Skill references if any have gained process-inbox
  examples by implementation time; keep high-level examples helper-first.
- Rewrite tests that append to `SPARKWRIGHT_TRACE_EVENTS` to write
  `SPARKWRIGHT_EVENT:` stderr lines.
- Remove tests whose only purpose was to prove the temp inbox was reachable
  from a sandbox.

### P2: optional first-class telemetry events

Do not start here.

If progress-only folding proves too lossy, add a new core event family later,
for example `extension.process.telemetry`. That would require updates to event
schemas, trace filtering, summary/timeline/report behavior, and public
reference docs.

Only when that event family exists should the user-facing helper API grow
semantic records such as:

- `phase`;
- `diagnostic`;
- `metric`.

Until then, those names should not be part of the public script protocol.

## Tests

Host runner tests:

- parses valid stderr token records in real time;
- preserves ordinary stderr lines;
- strips accepted/reserved token lines from stderr preview;
- strips accepted/reserved token lines from live `onOutput()` and task output;
- drops malformed, unsupported, oversized, and over-limit records;
- keeps bounded debug-only samples for dropped token records, including invalid
  JSON and unsupported `type`, while standard traces keep only the drop count;
- accepts `\n`, `\r\n`, and final-flush line endings;
- keeps token matching line-start anchored;
- handles partial token lines split across chunks;
- handles final unterminated lines;
- documents/locks the `observeStreaming()` partial-line live buffering
  behavior;
- awaits progress emission before terminal process lifecycle events;
- covers `executeRaw()`, `observeStreaming()`, and `collectStreamingResult()`;
- does not create inbox files, timers, or sandbox `allowWrite` exceptions.

Name these regression cases explicitly so they are hard to miss during
implementation:

- `observeStreaming strips telemetry token lines from onOutput and task output`;
- `observeStreaming buffers split telemetry lines until newline before forwarding`;
- `parses CRLF telemetry lines`;
- `keeps non-line-start token text as ordinary stderr`.

Workflow hook tests:

- command hook can emit stderr progress and stdout `WorkflowHookResult`;
- stdout logs still invalidate `stdoutJson`;
- malformed progress lines do not invalidate stdout control JSON;
- `onError` still handles malformed stdout JSON;
- lifecycle effect validation still rejects invalid `block`/`rewrite` effects.

Event hook tests:

- event command actions emit `user_hook.*` evidence and parse progress without
  blocking the main run;
- event hook stdout is not treated as workflow control.

Delegate/Skill tests:

- external command delegate progress is summarized without emitting
  `extension.process.*` when `emitLifecycle: false`;
- Skill inline shell progress uses process kind `skill_script`;
- debug trace keeps raw progress rows and standard trace folds them.

Core trace tests:

- standard trace sequence gaps remain valid through existing
  `foldedSequenceSkipBefore` logic;
- timeline still categorizes process observations under extension process
  detail;
- trace report/verify do not treat malformed progress drops as runtime failures
  unless the process itself fails.

## Project Map Updates After Implementation

When this proposal is implemented, update and verify at least:

- `docs/_internal/project-map/modules/host.md`
- `docs/_internal/project-map/modules/core.md`
- `docs/_internal/project-map/maps/trace/raw-trace.md`
- `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`
- `docs/_internal/project-map/maps/runtime/tool-orchestration.md`
- `docs/_internal/project-map/maps/capabilities/README.md`

Public/reference docs likely affected:

- `docs/guides/CONFIGURATION.md`
- `docs/reference/TRACE_EXTENSION_EVENTS.md`
- `docs/reference/RUN_EVENTS.md`
- `docs/reference/PROTOCOL.md`
- `docs/reference/EXTENSION_INTERFACES.md`

Only update map `Last Verified` blocks after source and tests are changed. This
proposal alone should not mark the map as re-verified.

## Remaining Open Questions

1. Helper packaging:
   - proposed: Node package plus Python docs snippet first;
   - unresolved: whether Python needs an installable package immediately.

2. First-class telemetry event:
   - proposed: defer;
   - unresolved: whether diagnostics/reporting need phase/metric semantics that
     cannot fit into current progress folding.

3. Stdout telemetry:
   - proposed: do not parse stdout token lines, even when `stdoutJson` is not
     enabled;
   - reason: keeping observation on stderr preserves one mental model and keeps
     stdout available for either command output or final control JSON.

## Recommendation

Accept the review feedback and simplify the design:

- delete the JSONL inbox instead of maintaining compatibility;
- support only `progress` in P0;
- use `SPARKWRIGHT_EVENT:` as the wire token line and
  `SPARKWRIGHT_EVENT_TOKEN=SPARKWRIGHT_EVENT` as the env hint;
- parse stderr through one shared helper across all process stderr paths;
- treat `observeStreaming()` as the live-stream special case: strip token lines
  from `onOutput()` too, accept the partial-line buffering tradeoff, and flush
  progress before lifecycle close;
- defer `phase`, `diagnostic`, and `metric` until there is a real trace-level
  semantic contract for them.

This keeps the first implementation small and honest: stdout controls the hook
result, stderr carries live progress, and the host owns validation, trace event
identity, folding, redaction, and resource limits.
