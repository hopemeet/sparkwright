# Environment Notes

## Local Tooling

Current project default:

- Node.js
- npm workspaces
- TypeScript
- Vitest

## Execution Environment Boundary

The core package exposes a small execution boundary for agent loops:

- `ShellExecutionRequest` describes a shell command, arguments, cwd, selected
  env, stdin, timeout, and caller metadata.
- `ShellExecutionResult` returns status, exit code, output streams, timing, and
  policy-ready metadata.
- `ExecutionEnvironment` is the backend-facing interface an agent loop can call
  without knowing whether execution is local, remote, containerized, mocked, or
  approval-gated.
- `LocalProcessEnvironment` is a safety-first skeleton for local shell
  execution. It denies shell execution by default and only delegates to an
  injected executor when an injected policy explicitly allows the request.

This keeps shell execution outside the run loop and tool registry for now. The
metadata shape is intentionally policy-ready: requests are normalized into the
`shell.execute` action with a `shell` resource and request metadata such as
command, args, cwd, timeout, stdin presence, and env key names. Future backend,
frontend, or extension hosts can adapt this interface to stricter policy,
approval, sandboxing, and audit layers without changing the agent loop contract.

### Foreground → Background Promotion

`@sparkwright/shell-tool` always runs commands through
`ExecutionEnvironment.executeShellStreaming(request)`, which returns a
`LiveShellHandle` (stdout/stderr async iterables, `abort()`) plus a
`completed` promise. When a foreground command exceeds
`ShellToolOptions.foregroundTimeoutMs`, the live process is **not killed** —
the tool calls `ShellToolOptions.onPromote({ handle, partialStdout,
partialStderr, ... })`, which is expected to adopt the process (typically by
registering it with `@sparkwright/agent-runtime`'s `TaskManager`) and return a
`taskId`. The tool resolves with `{ promoted: true, taskId }` so the agent
can monitor completion via `task(action="get")` / `task(action="output")`.

Pair the promotion bridge with `TaskNotificationSink`
(`@sparkwright/agent-runtime`) so the agent's next turn observes terminal
state instead of polling — see [`examples/promote-shell-to-task`](../../examples/promote-shell-to-task).

### Durable Background Task Wiring

Single-process hosts can use `InMemoryTaskStore` and
`InMemoryTaskNotificationQueue`, but durable hosts should persist both task
state and terminal notifications:

```ts
import {
  FileTaskNotificationOutbox,
  FileTaskStore,
  TaskManager,
  TaskWatchdog,
  pidTaskHealthProbe,
  recoverRunningTasks,
} from "@sparkwright/agent-runtime";

const store = new FileTaskStore({ rootDir: ".sparkwright/tasks" });
const outbox = new FileTaskNotificationOutbox({
  rootDir: ".sparkwright/tasks",
});
const manager = new TaskManager({
  store,
  notificationSink: outbox,
});

await recoverRunningTasks({ manager, probe: pidTaskHealthProbe });

const watchdog = new TaskWatchdog({
  manager,
  probe: pidTaskHealthProbe,
  idleTimeoutMs: 60_000,
  wallTimeoutMs: 60 * 60_000,
  intervalMs: 30_000,
});
const watchdogHandle = watchdog.start();
```

Map `outbox.drain()` into `createStreamingRun({ notificationSources })` so
terminal task notifications are injected into the next model turn. The file
outbox stores one JSON file per pending notification and removes it only when
drained or acknowledged, so a host restart does not lose a completed/failed
task signal.

Recovery guidance:

- Long silence from stdout/stderr should trigger a health probe, not an
  immediate failure. Some useful jobs are quiet by design.
- On startup, call `recoverRunningTasks()` before accepting new work. Tasks
  with live PIDs continue under the watchdog; missing PIDs become
  `TASK_PROCESS_MISSING`.
- If a task directory was manually deleted while the external job is still
  known to the host, write a tombstone with `FileTaskStore.writeTombstone()`
  rather than silently forgetting the task.

Design notes:

- **One foreground budget.** SparkWright hosts use
  `foregroundTimeoutMs` as the foreground shell budget. The exported
  `RECOMMENDED_FOREGROUND_TIMEOUT_MS` is 300000 ms (5 min), and
  `MAX_FOREGROUND_TIMEOUT_MS` caps accepted values at 600000 ms (10 min).
  When the budget fires, a host with a task manager promotes the live process;
  a host without promotion aborts and reports `timedOut: true`.
- **Required options.** `environment` (with `executeShellStreaming`),
  `foregroundTimeoutMs`, and `onPromote` are all required by
  `createShellTool`. Missing any of them throws at construction with a
  pointer to this section. The legacy batch-only `executeShell` path is no
  longer used by the tool — hosts that need one-shot batch execution should
  call `environment.executeShell` directly.
- **Promotion failure ≠ leak.** If `onPromote` throws, the tool calls
  `handle.abort()` and reports `timedOut: true` so a flaky task queue can't
  orphan processes.
- **Layer cleanly.** `@sparkwright/shell-tool` has no dependency on
  `@sparkwright/agent-runtime` — the promotion handler is a host-supplied
  callback. Wire `TaskManager.spawn` inside it.

## Verification Status

The current workspace has Node.js and npm available.

Dependency installation was attempted with:

```bash
npm install
```

The sandboxed attempt failed because DNS resolution for `registry.npmjs.org` was unavailable. Escalated install approval was requested twice but did not complete before its deadline.

During v0 kernel hardening, `npm install` was attempted again. The sandboxed run failed with:

```txt
getaddrinfo ENOTFOUND registry.npmjs.org
```

Escalated installation was requested again, but approval review did not complete before its deadline.

Dependencies were later installed successfully after network access became available.

The dependency audit initially reported moderate dev-dependency vulnerabilities through the Vitest/Vite/esbuild chain. `npm audit fix --force` upgraded Vitest to `3.2.4`, after which `npm audit --audit-level=moderate` reported zero vulnerabilities.

Verification now passes in this environment:

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
```

## Expected Setup

Once network access is available:

```bash
npm install
npm run typecheck
npm test
```
