# Push Test Runbook

This runbook captures the pre-push manual test pass for Sparkwright. Use it
when a change touches more than one package, protocol surfaces, runtime
behavior, host/SDK transport, gateway code, or examples.

## Before You Start

Run from the repository root after installing dependencies:

```bash
npm install
```

Build first if any smoke test uses `npm exec sparkwright`, `node dist/...`, or a
package binary:

```bash
npm run build --workspaces
```

Keep smoke workspaces under `/tmp` unless the test explicitly needs the checked
in `examples/repo-pilot` workspace. `.sparkwright/` is ignored, but using `/tmp`
keeps the repository clean.

## Fast Required Gates

These are the broad pre-push gates. They should all pass before pushing.

```bash
npm run typecheck --workspaces
npm run typecheck:test
npm run build --workspaces
npm test --workspaces
npm run lint
npm run format:check
npm run schema:check
npm run check:internal-imports
npm run check:reserved:strict
```

Expected result:

- TypeScript, Vitest, ESLint, Prettier, schema, internal-import, and reserved
  field checks all exit 0.
- `check:reserved:strict` reports `Possibly unused (0)`. If it finds public
  fields that are intentionally retained for embedders, add a concise
  `@reserved` comment explaining the consumer.

## CLI Golden Path

### Read-Only Run

```bash
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --trace-level minimal
```

Expected result:

- CLI prints `Run completed (final_answer)`.
- CLI prints `No workspace changes were made (read-only run).`
- A session trace is written under
  `examples/repo-pilot/.sparkwright/sessions/<session-id>/trace.jsonl`.
- The session contains `trace.jsonl`, `transcript.jsonl`,
  `agents/main/runs/<run-id>/run.json`, and
  `agents/main/runs/<run-id>/result.json`.

### Approved Write Run

Use a temporary workspace so the repository is not modified:

```bash
rm -rf /tmp/sparkwright-write-smoke
mkdir -p /tmp/sparkwright-write-smoke
printf '# Repo Pilot\n\nA tiny workspace for Sparkwright smoke tests.\n' \
  > /tmp/sparkwright-write-smoke/README.md

npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace /tmp/sparkwright-write-smoke \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

Expected result:

- CLI prints `Workspace writes: 1 applied.`
- Trace contains `workspace.write.requested`, `approval.requested`,
  `approval.resolved`, `artifact.created`, and `workspace.write.completed`.
- The session contains `artifacts/<artifact-id>.diff` and
  `artifacts/<artifact-id>.json`.
- `/tmp/sparkwright-write-smoke/README.md` contains
  `## Sparkwright CLI Golden Path`.

### Non-Interactive Write Denial

```bash
rm -rf /tmp/sparkwright-deny-smoke
mkdir -p /tmp/sparkwright-deny-smoke
printf '# Repo Pilot\n\nA tiny workspace.\n' \
  > /tmp/sparkwright-deny-smoke/README.md

npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace /tmp/sparkwright-deny-smoke \
  --target README.md \
  --write \
  --trace-level standard
```

Expected result:

- CLI prints `Approval denied because stdin is not interactive`.
- CLI prints `Workspace writes: 1 denied.`
- Trace contains `approval.resolved` with `decision: "denied"` and
  `workspace.write.denied`.
- No `artifact.created` or `workspace.write.completed` is expected for the
  denied write.

### Workspace Boundary

```bash
rm -rf /tmp/sparkwright-boundary-smoke
mkdir -p /tmp/sparkwright-boundary-smoke
printf '# Safe\n' > /tmp/sparkwright-boundary-smoke/README.md

npm exec sparkwright -- run "inspect outside" \
  --workspace /tmp/sparkwright-boundary-smoke \
  --target ../outside.md \
  --trace-level standard
```

Expected result:

- The run completes with a final answer, but the tool call fails safely.
- Trace contains `tool.failed` with code `WORKSPACE_PATH_ESCAPED`.
- No workspace changes are made.

### Idempotent No-Op Write

Re-running the same approved write against an already-updated file must trip
the `workspace.write.skipped` path instead of producing a duplicate write.

```bash
rm -rf /tmp/sparkwright-skip-smoke
mkdir -p /tmp/sparkwright-skip-smoke
printf '# Repo Pilot\n\nA tiny workspace.\n' \
  > /tmp/sparkwright-skip-smoke/README.md

# First run: applies the write.
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace /tmp/sparkwright-skip-smoke \
  --target README.md \
  --write \
  --yes \
  --trace-level standard

# Second run: heading already present → skipped (no-op).
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace /tmp/sparkwright-skip-smoke \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

Expected result:

- First run prints `Workspace writes: 1 applied.`
- Second run prints `Workspace writes: 1 skipped (no-op).`
- Second run's trace contains a `workspace.write.skipped` event with the
  target `path` and a `reason` like `Heading "..." already present`.
- No new `artifact.created` is recorded on the second run.

### Trace Level Comparison

`--trace-level` controls per-event payload verbosity, not the number of
events. Use this smoke when a change touches trace filtering or the
minimal/standard payload helpers.

```bash
for L in minimal standard debug; do
  rm -rf "/tmp/sparkwright-trace-$L"
  mkdir -p "/tmp/sparkwright-trace-$L"
  printf '# T\n' > "/tmp/sparkwright-trace-$L/README.md"
  npm exec --silent sparkwright -- run "inspect this repo" \
    --workspace "/tmp/sparkwright-trace-$L" \
    --target README.md \
    --trace-level "$L" >/dev/null 2>&1
  TRACE=$(find "/tmp/sparkwright-trace-$L/.sparkwright/sessions" \
    -name trace.jsonl | head -1)
  printf '%s: %s events, %s bytes\n' \
    "$L" "$(wc -l <"$TRACE" | tr -d ' ')" "$(wc -c <"$TRACE" | tr -d ' ')"
done
```

Expected result:

- All three runs produce the same event count.
- `minimal` byte count is materially smaller than `standard` and `debug`
  (only structural fields survive minimal redaction).
- `debug` is roughly the same size as `standard` (debug preserves all
  fields; standard is already close to full payload).

## Host And SDK

### Stdio Child Host

```bash
node --input-type=module <<'NODE'
import { createClient } from './packages/sdk-node/dist/index.js';

const client = await createClient({
  spawn: {
    command: process.execPath,
    args: [
      './packages/host/dist/bin.js',
      '--stdio',
      '--workspace',
      process.cwd(),
      '--provider',
      'deterministic',
    ],
    cwd: process.cwd(),
  },
  client: { name: 'manual-stdio-smoke', version: '0.0.0' },
  requestTimeoutMs: 30000,
});

let eventCount = 0;
client.on('run.event', () => eventCount++);
const terminal = new Promise((resolve, reject) => {
  client.on('run.completed', (m) => resolve(m.payload));
  client.on('run.failed', (m) =>
    reject(new Error(m.payload.error?.message ?? 'run failed')),
  );
});
const started = await client.startRun({ goal: 'inspect this repo' });
const done = await terminal;
console.log(JSON.stringify({
  runId: started.runId,
  terminal: done.stopReason,
  eventCount,
}, null, 2));
client.close();
NODE
```

Expected result:

- Output includes a `run_...` id.
- `terminal` is `final_answer`.
- `eventCount` is greater than 0.

### WebSocket Host

```bash
tmpout=/tmp/sparkwright-host-ws.log
node packages/host/dist/bin.js \
  --ws \
  --port 17320 \
  --host 127.0.0.1 \
  --workspace "$PWD" \
  --provider deterministic >"$tmpout" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 30); do
  if grep -q "ws://" "$tmpout" 2>/dev/null; then break; fi
  sleep 0.1
done

node --input-type=module <<'NODE'
import { createClient } from './packages/sdk-node/dist/index.js';

const client = await createClient({
  url: 'ws://127.0.0.1:17320',
  client: { name: 'manual-ws-smoke', version: '0.0.0' },
  requestTimeoutMs: 30000,
});

let runEventCount = 0;
client.on('run.event', () => runEventCount++);
const terminal = new Promise((resolve, reject) => {
  client.on('run.completed', (m) => resolve(m.payload));
  client.on('run.failed', (m) =>
    reject(new Error(m.payload.error?.message ?? 'run failed')),
  );
});
const started = await client.startRun({ goal: 'inspect this repo' });
const done = await terminal;
console.log(JSON.stringify({
  runId: started.runId,
  terminal: done.stopReason,
  runEventCount,
}, null, 2));
client.close();
NODE
```

Expected result:

- WebSocket client handshakes and receives run events.
- `terminal` is `final_answer`.

### Mid-Run Message Injection (protocol v1.1)

Exercises `run.inject_message` end-to-end through sdk-node → stdio host →
run loop. Use whenever protocol message types or the inject path in
`SparkwrightRun.injectUserMessage` change.

```bash
node --input-type=module <<'NODE'
import { createClient } from './packages/sdk-node/dist/index.js';

const client = await createClient({
  spawn: {
    command: process.execPath,
    args: [
      './packages/host/dist/bin.js',
      '--stdio',
      '--workspace',
      process.cwd(),
      '--provider',
      'deterministic',
    ],
    cwd: process.cwd(),
  },
  client: { name: 'manual-inject-smoke', version: '0.0.0' },
  requestTimeoutMs: 30000,
});

const enqueued = [];
const applied = [];
client.on('run.event', (m) => {
  const ev = m.payload?.event;
  if (!ev) return;
  if (ev.type === 'run.command.enqueued') enqueued.push(ev.payload?.commandType);
  if (ev.type === 'run.command.applied') applied.push(ev.payload?.commandType);
});

const terminal = new Promise((resolve, reject) => {
  client.on('run.completed', (m) => resolve(m.payload));
  client.on('run.failed', (m) =>
    reject(new Error(m.payload.error?.message ?? 'run failed')),
  );
});

const started = await client.startRun({ goal: 'inspect this repo' });
await client.injectRunMessage({
  runId: started.runId,
  content: 'Also note: this is an injected mid-run user message.',
  metadata: { source: 'smoke' },
});
const done = await terminal;
console.log(JSON.stringify({
  runId: started.runId,
  terminal: done.stopReason,
  enqueued,
  applied,
}, null, 2));
client.close();
NODE
```

Expected result:

- `enqueued` includes `"user_message"` (host accepted the inject request).
- `applied` includes `"user_message"` (run loop consumed it next turn).
- `terminal` is `final_answer`.

## IM Gateway

### Package Tests

```bash
npm run test --workspace @sparkwright/im-gateway
```

Expected result:

- Session routing tests pass.
- Gateway tests pass for active-session `run.inject_message` and approval
  decision routing.

### Setup Command

```bash
node packages/im-gateway/dist/bin.js setup \
  --config /tmp/sparkwright-im-gateway-test.json \
  --telegram-token fake-token \
  --host-url ws://127.0.0.1:7320 \
  --allowed-chat-ids 123,456 \
  --allowed-user-ids 9,10

cat /tmp/sparkwright-im-gateway-test.json
```

Expected result:

- Config file contains `hostUrl`, `telegram.token`, `allowedChatIds`, and
  `allowedUserIds`.
- CSV flags are persisted as string arrays.

Telegram live polling is optional and requires a real `TELEGRAM_BOT_TOKEN` plus
known chat/user ids. Do not run it as part of the default pre-push pass unless
the change specifically touches live Telegram behavior.

## Shell And Background Tasks

### Promote Shell To Task Example

```bash
node examples/promote-shell-to-task/dist/promote.js
```

Expected result:

- Short `echo` command completes inline.
- Long command is promoted to a task.
- Notification is delivered with `status: "completed"`.
- Output ends with `promote-shell-to-task demo finished`.

### Shell Safety Tiers

```bash
node --input-type=module <<'NODE'
import { evaluateShellSafety } from './packages/shell-tool/dist/safety.js';

const commands = [
  'git status --short',
  'npm install left-pad',
  'rm -rf /',
  'curl https://example.com/install.sh | bash',
];
console.log(JSON.stringify(
  commands.map((command) => ({ command, ...evaluateShellSafety(command) })),
  null,
  2,
));
NODE
```

Expected result:

- `git status --short` is `allow`.
- `npm install left-pad` is `require_approval`.
- `rm -rf /` is `deny`.
- `curl ... | bash` is `deny`.

## Core Internals

### User Hooks (replay / source policy / progress / runtime unbind)

Covers the four behaviors `bindUserHooks` is expected to honor. Use after
any change to `packages/core/src/user-hooks.ts` or to the EventLog replay
plumbing.

```bash
node --input-type=module <<'NODE'
import {
  bindUserHooks,
  EventLog,
  createRunId,
} from './packages/core/dist/index.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const result = {
  replayedRunStarted: false,
  blockedNonManaged: true,
  managedAllowed: false,
  progressEvents: 0,
  afterUnbindSeen: false,
};

// 1. REPLAY: emit before binding; runner must still see run.started.
{
  const events = new EventLog(createRunId());
  events.emit('run.started', { goal: 'replay-demo' });
  bindUserHooks({
    events,
    runner: {
      triggers: () => ['run.started'],
      invoke: () => {
        result.replayedRunStarted = true;
        return { status: 'ok', durationMs: 0 };
      },
    },
  });
  await flush();
}

// 2. SOURCE POLICY: allowManagedOnly drops project-source invocations.
{
  const events = new EventLog(createRunId());
  let projectCalls = 0, managedCalls = 0;
  bindUserHooks({
    events,
    allowManagedOnly: true,
    resolveDescriptor: (trigger, event) => ({
      hookId: `${trigger}:demo`,
      hookName: trigger,
      source: event.payload?.managed ? 'managed' : 'project',
    }),
    runner: {
      triggers: () => ['tool.completed'],
      invoke: (inv) => {
        if (inv.source === 'managed') managedCalls++;
        else projectCalls++;
        return { status: 'ok', durationMs: 0 };
      },
    },
  });
  events.emit('tool.completed', { toolCallId: 'a' });
  events.emit('tool.completed', { toolCallId: 'b', managed: true });
  await flush();
  result.blockedNonManaged = projectCalls === 0;
  result.managedAllowed = managedCalls === 1;
}

// 3. PROGRESS: reportProgress emits user_hook.progress per chunk.
{
  const events = new EventLog(createRunId());
  bindUserHooks({
    events,
    runner: {
      triggers: () => ['tool.completed'],
      invoke: async (inv) => {
        inv.reportProgress({ stdout: '1\n', output: '1\n' });
        inv.reportProgress({ stdout: '2\n', output: '2\n' });
        inv.reportProgress({ stdout: '3\n', output: '3\n' });
        return { status: 'ok', durationMs: 1 };
      },
    },
  });
  events.emit('tool.completed', { toolCallId: 'x' });
  await flush();
  result.progressEvents = events
    .all()
    .filter((e) => e.type === 'user_hook.progress').length;
}

// 4. RUNTIME ADD/REMOVE: unbind() must stop further deliveries.
{
  const events = new EventLog(createRunId());
  let calls = 0;
  const unbind = bindUserHooks({
    events,
    runner: {
      triggers: () => ['tool.completed'],
      invoke: () => {
        calls += 1;
        return { status: 'ok', durationMs: 0 };
      },
    },
  });
  events.emit('tool.completed', { toolCallId: 'first' });
  await flush();
  unbind();
  events.emit('tool.completed', { toolCallId: 'after-unbind' });
  await flush();
  result.afterUnbindSeen = calls === 1;
}

console.log(JSON.stringify(result, null, 2));
NODE
```

Expected result:

- `replayedRunStarted` is `true` (late binder still observed `run.started`).
- `blockedNonManaged` is `true`, `managedAllowed` is `true`.
- `progressEvents` is `3`.
- `afterUnbindSeen` is `true` (no calls observed after unbind).

### Anchored Edits

`coding-tools` and the deterministic CLI write path both depend on the
anchored-edit primitives in `@sparkwright/core`. Use this smoke after
changing `anchored-edit.ts` or any consumer.

```bash
node --input-type=module <<'NODE'
import {
  createAnchoredText,
  applyAnchoredEdits,
} from './packages/core/dist/index.js';

const original = `# Title\n\none\ntwo\nthree\n`;
const anchored = createAnchoredText('notes.md', original);
const twoAnchor = anchored.lines.find((l) => l.content === 'two').anchor;
const threeAnchor = anchored.lines.find((l) => l.content === 'three').anchor;

const replaceResult = applyAnchoredEdits({
  path: 'notes.md',
  content: original,
  edits: [{ op: 'replace', anchor: twoAnchor, lines: ['TWO!'] }],
});
const appendResult = applyAnchoredEdits({
  path: 'notes.md',
  content: replaceResult.content,
  edits: [{ op: 'append', anchor: threeAnchor, lines: ['four'] }],
});

let mismatchCaught = false;
try {
  applyAnchoredEdits({
    path: 'notes.md',
    content: appendResult.content,
    edits: [{ op: 'delete', anchor: 'not-a-real-anchor' }],
  });
} catch (err) {
  mismatchCaught = /anchor/i.test(err?.message ?? '');
}

console.log(JSON.stringify({
  anchorCount: anchored.lines.length,
  anchorSetId: anchored.anchorSetId,
  afterReplace: replaceResult.content,
  afterAppend: appendResult.content,
  mismatchCaught,
}, null, 2));
NODE
```

Expected result:

- `anchorSetId` is non-empty and stable for the same input.
- `afterReplace` contains `TWO!` and no longer matches `^two$`.
- `afterAppend` contains `four`.
- `mismatchCaught` is `true` (unknown anchor throws an `AnchoredEditError`).

### Session Fork

`forkSessionFromEvent` underpins "branch from any point in a session"
flows. Smoke after any session-store or fork-protocol change.

```bash
node --input-type=module <<'NODE'
import {
  InMemorySessionStore,
  forkSessionFromEvent,
} from './packages/core/dist/index.js';

const store = new InMemorySessionStore();
const original = await store.create({});
for (let i = 1; i <= 4; i++) {
  await store.appendEvent(original.id, {
    type: 'session.note',
    payload: { i },
    metadata: { idx: i },
  });
}

const fork = await forkSessionFromEvent({
  sourceSessionId: original.id,
  forkAtSequence: 2,
  store,
  metadata: { reason: 'smoke-fork' },
});
const clone = await forkSessionFromEvent({
  sourceSessionId: original.id,
  store,
  metadata: { reason: 'smoke-clone' },
});

const forkedEvents = [];
for await (const ev of store.loadEvents(fork.forked.id)) {
  forkedEvents.push(ev.type);
}

console.log(JSON.stringify({
  originalSessionId: original.id,
  forkedSessionId: fork.forked.id,
  copiedEventCount: fork.copiedEventCount,
  truncatedAtSequence: fork.truncatedAtSequence,
  forkedEventTypes: forkedEvents,
  cloneCopiedCount: clone.copiedEventCount,
}, null, 2));
NODE
```

Expected result:

- `forkedSessionId` differs from `originalSessionId`.
- `truncatedAtSequence` echoes the requested `forkAtSequence` (`2`).
- `copiedEventCount` is strictly less than `cloneCopiedCount` (truncated
  fork drops the tail).
- `cloneCopiedCount` equals the total appended events (`4`).

## Runtimes

### Streaming Runtime

`createStreamingRun` drains `NotificationSource.drain()` at the head of
every step and stitches the results in as user-role context. Smoke after
changing the streaming loop or the notification-source contract.

```bash
node --input-type=module <<'NODE'
import { createStreamingRun } from './packages/streaming-runtime/dist/index.js';

let drainCalls = 0;
let drained = false;
const notificationSource = {
  drain() {
    drainCalls += 1;
    if (drained) return [];
    drained = true;
    return [{
      content: 'task #42 completed in background',
      source: { kind: 'task-notification' },
      metadata: { taskId: '42' },
    }];
  },
};

const model = {
  async complete() { return { message: 'all caught up', stopReason: 'completed' }; },
  async *stream() {
    yield { type: 'text_delta', text: 'all ' };
    yield { type: 'text_delta', text: 'caught up' };
    yield { type: 'stop', stopReason: 'completed' };
  },
};

const handle = createStreamingRun({
  goal: 'drain pending notifications and answer',
  model,
  notificationSources: [notificationSource],
});

const result = await handle.start();
const eventTypes = handle.events.all().map((e) => e.type);

console.log(JSON.stringify({
  stopReason: result.stopReason,
  drainCalls,
  eventCount: eventTypes.length,
  hasModelCompleted: eventTypes.includes('model.completed'),
}, null, 2));
NODE
```

Expected result:

- `stopReason` is `final_answer`.
- `drainCalls` is at least `1`.
- `hasModelCompleted` is `true`.

### Server Runtime (Multi-Run + Unsubscribe)

Exercises `createServerRuntime` running two runs concurrently while a
filtered subscriber unsubscribes mid-flight and a late `replay()` recovers
the historical messages.

```bash
node --input-type=module <<'NODE'
import { createServerRuntime } from './packages/server-runtime/dist/index.js';

const model = {
  async complete() { return { message: 'ok', stopReason: 'completed' }; },
};

const runtime = createServerRuntime();
const allMsgs = [];
const sub = runtime.hub.subscribe({}, (m) => { allMsgs.push(m.type); });

const earlyMsgs = [];
const earlySub = runtime.hub.subscribe({ types: ['run.created'] }, (m) => {
  earlyMsgs.push(m.type);
});

const runA = runtime.runs.createRun({ goal: 'alpha', model });
const runB = runtime.runs.createRun({ goal: 'beta', model });
earlySub.unsubscribe();
const earlyCountAtUnsubscribe = earlyMsgs.length;

const [resA, resB] = await Promise.all([
  runtime.runs.startRun(runA.record.id),
  runtime.runs.startRun(runB.record.id),
]);

const replayed = runtime.hub.replay({ types: ['run.created'] });
console.log(JSON.stringify({
  runA: resA.stopReason,
  runB: resB.stopReason,
  hubMessageCount: allMsgs.length,
  hubMessageTypes: [...new Set(allMsgs)],
  earlySubReceivedBeforeUnsub: earlyCountAtUnsubscribe,
  earlySubReceivedTotal: earlyMsgs.length,
  replayedRunCreated: replayed.length,
}, null, 2));
sub.unsubscribe();
NODE
```

Expected result:

- Both runs end with `stopReason: "final_answer"`.
- `hubMessageTypes` includes at least `run.created`, `run.event`, and
  `run.result`.
- `earlySubReceivedTotal` equals `earlySubReceivedBeforeUnsub` (no growth
  after unsubscribe).
- `replayedRunCreated` equals `2` (both `run.created` recoverable).

### Agent Runtime (Sub-Agent + Usage Rollup)

`spawnSubAgent` + `attachUsageRollup` keep child tool/model usage on the
parent's tracker, and `deriveChildAgentProfile` is the pure
capability-policy derivation.

```bash
node --input-type=module <<'NODE'
import {
  createRun,
  createUsageTracker,
} from './packages/core/dist/index.js';
import {
  spawnSubAgent,
  deriveChildAgentProfile,
} from './packages/agent-runtime/dist/index.js';

const model = {
  async complete() {
    return {
      message: 'done',
      stopReason: 'completed',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    };
  },
};

const parent = createRun({ goal: 'parent run', model });
const parentTracker = createUsageTracker({ runId: parent.record.id });
const sub = spawnSubAgent({
  parent,
  goal: 'child task',
  model,
  parentUsageTracker: parentTracker,
  metadata: { reason: 'smoke' },
});

const childResult = await sub.run.start();
const parentResult = await parent.start();
const parentUsage = parentTracker.snapshot();

const derived = deriveChildAgentProfile({
  parentAgent: { id: 'p', capabilities: { tools: ['read_file'] } },
  childAgent: { id: 'c', capabilities: { tools: ['read_file', 'write_file'] } },
});

console.log(JSON.stringify({
  parentRunId: parent.record.id,
  childRunId: sub.run.record.id,
  childTerminal: childResult.stopReason,
  parentTerminal: parentResult.stopReason,
  spanId: sub.spanId,
  parentTokens: parentUsage.tokens,
  parentModelCalls: parentUsage.modelCalls,
  effectivePolicyEntries: derived.effectivePolicy.length,
}, null, 2));
NODE
```

Expected result:

- Both runs end `final_answer`.
- `spanId` is non-empty and `sub.parentRunId === parent.record.id`.
- `parentTokens.total` is at least `8` (child usage rolled up).
- `parentModelCalls` is at least `1`.
- `effectivePolicyEntries` is a number (the derivation produced a policy).

## Skills

```bash
rm -rf /tmp/sparkwright-skills-smoke
mkdir -p /tmp/sparkwright-skills-smoke/reviewer
cat > /tmp/sparkwright-skills-smoke/reviewer/SKILL.md <<'EOF'
---
name: code-reviewer
description: Reviews diffs for risk and missing tests.
license: Apache-2.0
metadata:
  version: 1.0.0
---
Read the diff. Call out risky changes and missing tests.
EOF

node --input-type=module <<'NODE'
import {
  prepareSkillsForRun,
  loadSkillsFromDirectory,
  SkillRegistry,
  skillsToCapabilities,
} from './packages/skills/dist/index.js';

const prepared = await prepareSkillsForRun({
  goal: 'review this diff for risk',
  skillRoots: ['/tmp/sparkwright-skills-smoke'],
  includeLoaderTool: true,
  loadSelectedSkills: true,
});
const discovered = await loadSkillsFromDirectory('/tmp/sparkwright-skills-smoke');
const registry = new SkillRegistry(discovered.skills);
const matched = registry.match('review risk tests', { limit: 1 });
console.log(JSON.stringify({
  indexed: prepared.indexedSkills.map((s) => s.name),
  loaded: prepared.loadedSkills.map((s) => s.name),
  contextCount: prepared.context.length,
  toolNames: prepared.tools.map((t) => t.name),
  discoveryErrors: discovered.loadErrors.length,
  matched: matched.map((m) => m.skill.name),
  capabilities: skillsToCapabilities(registry.list()).map((c) => c.name),
}, null, 2));
NODE
```

Expected result:

- `indexed`, `loaded`, `matched`, and `capabilities` include `code-reviewer`.
- `toolNames` includes `skill.load`.
- `discoveryErrors` is 0.

## MCP Adapter

```bash
node --input-type=module <<'NODE'
import { prepareMcpToolsForRun } from './packages/mcp-adapter/dist/index.js';

const prepared = await prepareMcpToolsForRun({
  servers: [
    {
      type: 'stdio',
      name: 'disabled-demo',
      command: 'node',
      enabled: false,
    },
  ],
  defaultTimeoutMs: 1000,
  namePrefix: 'mcp',
});
console.log(JSON.stringify({
  statuses: prepared.statuses,
  toolCount: prepared.tools.length,
  toolNameMap: prepared.toolNameMap,
}, null, 2));
await prepared.close();
NODE
```

Expected result:

- `statuses.disabled-demo.status` is `disabled`.
- `toolCount` is 0.
- `toolNameMap` is empty.

Use a real MCP server only when changing MCP startup, transport, or tool-call
normalization.

## Provider Edge And Registry

### Provider Registry

```bash
node --input-type=module <<'NODE'
import {
  ProviderRegistry,
  resolveModel,
} from './packages/provider-registry/dist/index.js';

const registry = new ProviderRegistry([
  {
    id: 'fake',
    models: [
      {
        id: 'mini',
        aliases: ['alias-mini'],
        capabilities: {
          completion: true,
          streaming: false,
          toolCalling: true,
        },
      },
    ],
    createAdapter() {
      return { complete: async () => ({ message: 'ok' }) };
    },
  },
]);

const resolved = await resolveModel(registry, 'fake:alias-mini');
const alias = await registry.resolveModel('alias-mini');
const adapter1 = await registry.getAdapter('fake:mini');
const adapter2 = await registry.getAdapter('fake:mini');
console.log(JSON.stringify({
  resolved: resolved.model.id,
  alias: alias.model.id,
  adapterMessage: (await adapter1.complete({
    goal: 'x',
    context: [],
    tools: [],
  })).message,
  models: (await registry.listModels()).length,
  cacheReused: adapter1 === adapter2,
}, null, 2));
NODE
```

Expected result:

- `resolved` and `alias` are `mini`.
- `adapterMessage` is `ok`.
- `models` is 1.
- `cacheReused` is true.

### Model Pricing (UsageTracker `byModel` + `costUsd`)

`createAiSdkModelAdapter` now accepts `id` and `pricing`; `createOpenAiProvider`
in `@sparkwright/provider-ai-sdk` ships a curated `OPENAI_MODEL_PRICING` table
and wires both into the adapter via `ProviderRegistry.getAdapter`. Smoke this
when changing the registry, the adapter, or the pricing table.

```bash
node --input-type=module <<'NODE'
import { createUsageTracker } from './packages/core/dist/usage.js';
import {
  createOpenAiProvider,
  OPENAI_MODEL_PRICING,
} from './packages/provider-ai-sdk/dist/index.js';
import { ProviderRegistry } from './packages/provider-registry/dist/index.js';

// Fake LanguageModel: returns one assistant message with realistic usage.
const fakeOpenAi = () => ({
  specificationVersion: 'v3',
  modelId: 'gpt-4o-mini',
  provider: 'fake',
  async doGenerate() {
    return {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1000, noCache: 1000 },
        outputTokens: { total: 500, text: 500 },
      },
      warnings: [],
    };
  },
});

const registry = new ProviderRegistry([
  createOpenAiProvider({ openai: fakeOpenAi }),
]);
const adapter = await registry.getAdapter('openai:gpt-4o-mini');

const tracker = createUsageTracker({});
tracker.markStarted();
const out = await adapter.complete({
  run: { id: 'r1', goal: 'x', state: 'running', createdAt: '', updatedAt: '', metadata: {} },
  context: [],
  prompt: [{ role: 'user', content: 'hi', stability: 'turn' }],
  tools: [],
  events: [],
  step: 1,
});
tracker.recordModelUsage({ adapterId: adapter.id, usage: out.usage });

const snap = tracker.snapshot();
console.log(JSON.stringify({
  adapterId: adapter.id,
  outputCostUsd: out.usage?.costUsd,
  byModel: snap.byModel,
  totalCostUsd: snap.costUsd,
  pricingRow: OPENAI_MODEL_PRICING['gpt-4o-mini'],
}, null, 2));
NODE
```

Expected result:

- `adapterId` is `openai:gpt-4o-mini`.
- `outputCostUsd` is `0.00045` (= 1000 × 0.15/M + 500 × 0.6/M).
- `byModel["openai:gpt-4o-mini"]` reports `calls: 1`, `inputTokens: 1000`,
  `outputTokens: 500`, and matching `costUsd`.
- `totalCostUsd` equals `outputCostUsd`.
- `pricingRow` contains `inputPerMTokUsd`, `outputPerMTokUsd`, and
  `cacheReadPerMTokUsd` for `gpt-4o-mini`.

When verifying the live OpenAI run (the optional smoke at the end of
[Missing OpenAI Key](#missing-openai-key)), the resulting trace's
`usage.updated` events must include the same `byModel["openai:<model>"]`
key and a non-zero `costUsd`.

### Missing OpenAI Key

```bash
env -u OPENAI_API_KEY npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model smoke-model \
  --trace-level standard
```

Expected result:

- Command exits non-zero.
- Output says `OPENAI_API_KEY is required when using --provider openai.`
- No provider-backed run is created.

Provider-backed live smoke is optional. Run it only when credentials are
available and provider-edge behavior is in scope:

```bash
OPENAI_API_KEY=... \
OPENAI_BASE_URL=https://your-openai-compatible-gateway.example.com/v1 \
npm exec sparkwright -- run "inspect this repo" \
  --workspace examples/repo-pilot \
  --target README.md \
  --provider openai \
  --model <model-name> \
  --trace-level standard
```

## Trace Perfetto

Use a real trace from the approved write smoke:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { PerfettoTrace } from './packages/trace-perfetto/dist/index.js';

const tracePath =
  '/tmp/sparkwright-write-smoke/.sparkwright/sessions/<session-id>/trace.jsonl';
const trace = new PerfettoTrace();
const lines = readFileSync(tracePath, 'utf8').trim().split('\n');
for (const line of lines) trace.ingest(JSON.parse(line));
trace.finalize();
const doc = trace.toJSON();
console.log(JSON.stringify({
  inputEvents: lines.length,
  perfettoEvents: doc.traceEvents.length,
  hasCompleteSpan: doc.traceEvents.some((e) => e.ph === 'X'),
  displayTimeUnit: doc.displayTimeUnit,
}, null, 2));
NODE
```

Replace `<session-id>` with the session printed by the approved write smoke.

Expected result:

- `inputEvents` is greater than 0.
- `perfettoEvents` is greater than 0.
- `hasCompleteSpan` is true.
- `displayTimeUnit` is `ms`.

## Examples

Run after `npm run build --workspaces`:

```bash
node examples/custom-tool/dist/register-tool.js
node examples/capability-runtime/dist/run.js
node examples/promote-shell-to-task/dist/promote.js
```

Expected result:

- Custom tool example completes with `Package scripts inspected.`
- Capability runtime example completes with a code-review style final answer.
- Promote shell example completes with task promotion and notification output.

If `examples/capability-runtime` fails with an AJV strict-mode error for
`x-sparkwrightProtocolVersion`, make sure the example registers that custom
schema annotation keyword before adding schemas to AJV.

### Python Subprocess

Validates the Python-stdlib client that drives the CLI via `subprocess` and
parses the JSONL trace. Requires `python3` (>= 3.9) on PATH.

```bash
cd examples/python-subprocess
python3 run_agent.py "inspect this repo" \
  --workspace ../../examples/repo-pilot \
  --trace-level minimal
cd ../..
```

Expected result:

- Script prints a summary block with `trace:` and `result.json:` paths.
- The "Key trace events" section ends with `run.completed  reason=final_answer`.

## Final Cleanliness Check

```bash
git status --short
git diff --stat
```

Expected result:

- Only intended source, test, and documentation files are modified.
- No `/tmp` files are relevant.
- No generated `.sparkwright/`, `dist/`, or config smoke files are staged or
  reported as repository changes.
