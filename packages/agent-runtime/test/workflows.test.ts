import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  advanceWorkflowState,
  FileWorkflowNotificationOutbox,
  createInitialWorkflowRuntimeState,
  FileWorkflowStore,
  runWorkflowRunChain,
  workspaceWorkflowRunsDir,
  WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
  workflowRunsDir,
  validateWorkflowRuntimeDefinition,
  type WorkflowRunId,
  type WorkflowDefinition,
} from "../src/index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-workflows-"));
}

function workflow(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return {
    assetName: "test-workflow",
    contentHash: "hash",
    nodes,
  };
}

describe("workflow runtime state machine", () => {
  it("advances linearly and completes after the final node", () => {
    const definition = workflow([
      { id: "plan", body: "Plan." },
      { id: "implement", body: "Implement." },
    ]);
    const started = createInitialWorkflowRuntimeState(definition);

    const first = advanceWorkflowState({
      definition,
      state: started,
      verdict: { status: "passed" },
      now: () => "t1",
    });

    expect(first.decision).toMatchObject({
      type: "goto",
      fromNodeId: "plan",
      toNodeId: "implement",
    });
    expect(first.state).toMatchObject({
      status: "running",
      currentNodeId: "implement",
      attempts: { plan: 1, implement: 1 },
    });

    const second = advanceWorkflowState({
      definition,
      state: first.state,
      verdict: { status: "passed" },
      now: () => "t2",
    });

    expect(second.decision).toMatchObject({
      type: "complete",
      fromNodeId: "implement",
    });
    expect(second.state.status).toBe("completed");
    expect(second.state.transitionLog.map((entry) => entry.at)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("honors retry transitions before falling through", () => {
    const definition = workflow([
      {
        id: "verify",
        body: "Verify.",
        onFail: { retry: 1, then: "repair" },
      },
      { id: "repair", body: "Repair." },
    ]);
    const started = createInitialWorkflowRuntimeState(definition);

    const retry = advanceWorkflowState({
      definition,
      state: started,
      verdict: { status: "failed", reason: "check failed" },
    });

    expect(retry.decision).toMatchObject({
      type: "retry",
      nodeId: "verify",
      attempt: 2,
      maxRetries: 1,
    });
    expect(retry.state).toMatchObject({
      status: "running",
      currentNodeId: "verify",
      attempts: { verify: 2 },
    });

    const fallthrough = advanceWorkflowState({
      definition,
      state: retry.state,
      verdict: { status: "failed", reason: "still failing" },
    });

    expect(fallthrough.decision).toMatchObject({
      type: "goto",
      fromNodeId: "verify",
      toNodeId: "repair",
    });
  });

  it("fails on runtime errors", () => {
    const definition = workflow([{ id: "only", body: "Run." }]);
    const started = createInitialWorkflowRuntimeState(definition);

    const result = advanceWorkflowState({
      definition,
      state: started,
      verdict: { status: "runtime_error", reason: "projection exploded" },
    });

    expect(result.decision).toMatchObject({
      type: "fail",
      reason: "projection exploded",
    });
    expect(result.state).toMatchObject({
      status: "failed",
      failure: {
        nodeId: "only",
        reason: "projection exploded",
      },
    });
  });

  it("preserves durable parallel branch state across transitions", () => {
    const definition = workflow([
      { id: "fanout", body: "Fan out.", onPass: "join" },
      { id: "join", body: "Join." },
    ]);
    const started = createInitialWorkflowRuntimeState(definition);

    const result = advanceWorkflowState({
      definition,
      state: {
        ...started,
        parallelBranches: {
          "unit-a": {
            sourceNodeId: "fanout",
            nodeId: "unit-a",
            attempt: 1,
            status: "passed",
            verdict: { status: "passed", reason: "branch_passed" },
            completedAt: "2026-07-04T00:01:30.000Z",
          },
        },
      },
      verdict: { status: "passed" },
    });

    expect(result.state).toMatchObject({
      currentNodeId: "join",
      parallelBranches: {
        "unit-a": {
          sourceNodeId: "fanout",
          nodeId: "unit-a",
          status: "passed",
        },
      },
    });
  });

  it("rejects ask_user transition targets while treating human as a normal node id", () => {
    const issues = validateWorkflowRuntimeDefinition(
      workflow([
        { id: "start", body: "Start.", onPass: "ask_user" },
        { id: "other", body: "Other.", onFail: { goto: "human" } },
      ]),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        code: "WORKFLOW_UNSUPPORTED_TRANSITION_TARGET",
        nodeId: "start",
        target: "ask_user",
      }),
      expect.objectContaining({
        code: "WORKFLOW_UNKNOWN_TRANSITION_TARGET",
        nodeId: "other",
        target: "human",
      }),
    ]);
  });
});

describe("workflow run-chain driver", () => {
  it("runs one episode per continuation and returns the terminal decision", async () => {
    const inputs: Array<{
      continuation?: string;
      continuationCount: number;
    }> = [];

    const result = await runWorkflowRunChain<string, string, string>({
      runOnce(input) {
        inputs.push(input);
        return input.continuation ?? "initial";
      },
      decide({ output, continuationCount }) {
        if (continuationCount >= 2) {
          return {
            kind: "terminal",
            terminal: `done:${output}:${continuationCount}`,
          };
        }
        return {
          kind: "continue",
          continuation: `next-${continuationCount + 1}`,
        };
      },
    });

    expect(inputs).toEqual([
      { continuation: undefined, continuationCount: 0 },
      { continuation: "next-1", continuationCount: 1 },
      { continuation: "next-2", continuationCount: 2 },
    ]);
    expect(result).toEqual({
      terminal: "done:next-2:2",
      continuationCount: 2,
    });
  });
});

describe("FileWorkflowStore", () => {
  it("exposes session legacy and workspace workflow-run roots", () => {
    expect(
      workflowRunsDir({ sessionRootDir: "/state/sessions", sessionId: "sess" }),
    ).toBe(join("/state/sessions", "sess", "workflow-runs"));
    expect(workspaceWorkflowRunsDir({ workspaceRoot: "/workspace" })).toBe(
      join("/workspace", ".sparkwright", "workflow-runs"),
    );
  });

  it("persists workflow run records with pinned definition snapshots", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_test" as WorkflowRunId;
    const definition = workflow([
      { id: "plan", body: "Plan." },
      { id: "patch", body: "Patch." },
    ]);

    const created = store.create({
      id,
      parentRunId: "run_parent" as RunId,
      sessionId: "sess_one",
      activeRunId: "run_first" as RunId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "plan",
      attempts: { plan: 1 },
      definitionSnapshot: definition,
      now: () => "2026-07-04T00:00:00.000Z",
    });

    expect(created).toMatchObject({
      schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
      id,
      status: "running",
      activeRunId: "run_first",
      runIds: ["run_first"],
      resume: { verifyOnResume: true },
      definitionSnapshot: {
        assetName: "test-workflow",
        nodes: [{ id: "plan" }, { id: "patch" }],
      },
    });

    const updated = store.update(id, {
      status: "completed",
      currentNodeId: "patch",
      attempts: { plan: 1, patch: 1 },
      parallelBranches: {
        "unit-a": {
          sourceNodeId: "fanout",
          nodeId: "unit-a",
          attempt: 1,
          status: "passed",
          verdict: { status: "passed", reason: "branch_passed" },
          evidenceRefs: [
            {
              kind: "run",
              ref: "run_branch_a",
              nodeId: "unit-a",
              metadata: { execute: "command" },
            },
          ],
          completedAt: "2026-07-04T00:01:30.000Z",
        },
      },
      transitionLog: [
        {
          at: "2026-07-04T00:01:00.000Z",
          verdict: { status: "passed" },
          decision: {
            type: "complete",
            fromNodeId: "patch",
            reason: "node_passed",
          },
        },
      ],
      now: () => "2026-07-04T00:02:00.000Z",
    });

    expect(updated.completedAt).toBe("2026-07-04T00:02:00.000Z");
    expect(updated.transitionLog).toHaveLength(1);

    const reopened = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });
    expect(reopened.get(id)).toMatchObject({
      status: "completed",
      completedAt: "2026-07-04T00:02:00.000Z",
      definitionSnapshot: { contentHash: "hash" },
      parallelBranches: {
        "unit-a": {
          sourceNodeId: "fanout",
          nodeId: "unit-a",
          status: "passed",
          evidenceRefs: [
            expect.objectContaining({
              ref: "run_branch_a",
              metadata: { execute: "command" },
            }),
          ],
        },
      },
    });
    expect(
      JSON.parse(await readFile(join(root, `${id}.json`), "utf8")),
    ).toMatchObject({
      schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
      id,
    });
  });

  it("lists valid records while reporting corrupt entries", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    store.create({
      id: "workflow_good" as WorkflowRunId,
      assetName: "ok",
      contentHash: "hash",
    });
    await writeFile(join(root, "bad-json.json"), "{", "utf8");
    await writeFile(
      join(root, "bad-shape.json"),
      JSON.stringify({ schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION }),
      "utf8",
    );

    const reopened = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });
    const listed = reopened.list();

    expect(listed.records.map((record) => record.id)).toEqual([
      "workflow_good",
    ]);
    expect(listed.invalidEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_json" }),
        expect.objectContaining({ code: "invalid_document" }),
      ]),
    );
  });

  it("records JSONL store events and skips corrupt event rows", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_events" as WorkflowRunId;
    store.create({
      id,
      assetName: "events",
      contentHash: "hash",
      now: () => "2026-07-04T00:00:00.000Z",
    });
    store.update(id, {
      status: "failed",
      failure: {
        kind: "runtime",
        code: "workflow.runtime",
        message: "projection failed",
      },
      now: () => "2026-07-04T00:01:00.000Z",
    });
    await writeFile(join(root, `${id}.events.jsonl`), "{bad\n", {
      flag: "a",
    });

    const log = store.eventLog(id);

    expect(log.events.map((event) => event.type)).toEqual([
      "created",
      "failed",
    ]);
    expect(log.invalidEntries).toEqual([
      expect.objectContaining({ code: "invalid_json", line: 3 }),
    ]);
  });

  it("leases workflow records for single-writer adoption", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_lease" as WorkflowRunId;
    store.create({ id, assetName: "lease", contentHash: "hash" });

    const first = await store.acquireLease(id, {
      owner: "worker-a",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });
    expect(first).not.toBeNull();

    const second = await store.acquireLease(id, {
      owner: "worker-b",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:01.000Z"),
    });
    expect(second).toBeNull();

    expect(await first?.release()).toBe(true);
    const afterRelease = await store.acquireLease(id, {
      owner: "worker-b",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:02.000Z"),
    });
    expect(afterRelease?.owner).toBe("worker-b");
    await afterRelease?.release();
  });

  it("does not log adoption for fresh pre-create leases and uses the injected release clock", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_fresh_lease" as WorkflowRunId;
    let now = new Date("2026-07-04T00:00:00.000Z");

    const lease = await store.acquireLease(id, {
      owner: "fresh-worker",
      ttlMs: 60_000,
      now: () => now,
    });
    expect(lease).not.toBeNull();
    expect(store.eventLog(id).events).toEqual([]);

    store.create({
      id,
      assetName: "fresh",
      contentHash: "hash",
      now: () => "2026-07-04T00:01:00.000Z",
    });
    now = new Date("2026-07-04T00:02:00.000Z");
    expect(await lease?.release()).toBe(true);

    expect(store.eventLog(id).events.map((event) => event.type)).toEqual([
      "created",
      "released",
    ]);
    expect(store.eventLog(id).events.at(-1)).toMatchObject({
      at: "2026-07-04T00:02:00.000Z",
      type: "released",
      metadata: { owner: "fresh-worker" },
    });
  });

  it("requires waiting records to carry wait.kind and clears wait on terminal", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_wait" as WorkflowRunId;
    store.create({ id, assetName: "wait", contentHash: "hash" });

    expect(() => store.update(id, { status: "waiting" })).toThrow(/wait.kind/);
    const waiting = store.update(id, {
      status: "waiting",
      wait: { kind: "input", reason: "need user" },
    });
    expect(waiting.wait).toEqual({ kind: "input", reason: "need user" });
    expect(store.eventLog(id).events.at(-1)).toMatchObject({
      type: "waiting",
      status: "waiting",
      metadata: { wait: { kind: "input", reason: "need user" } },
    });
    store.appendEvent({
      at: "2026-07-05T00:00:00.000Z",
      type: "input",
      workflowRunId: id,
      status: "running",
      metadata: { wait: waiting.wait },
    });
    expect(store.eventLog(id).events.at(-1)).toMatchObject({
      type: "input",
      metadata: { wait: { kind: "input", reason: "need user" } },
    });
    expect(() =>
      store.update(id, { status: "waiting", clearWait: true }),
    ).toThrow(/wait.kind/);
    expect(store.update(id, { status: "cancelled" }).wait).toBeUndefined();
  });

  it("persists workflow waiting notifications in a file-backed actor outbox", async () => {
    const root = await tempDir();
    const outbox = new FileWorkflowNotificationOutbox({ rootDir: root });

    outbox.asActorSink().deliver({
      source: {
        kind: "workflow",
        id: "workflow_wait_notice",
        runId: "run_parent",
        sessionId: "session_wait",
      },
      routeHint: {
        parentRunId: "run_parent",
        sessionId: "session_wait",
      },
      type: "waiting",
      correlationId: "workflow_wait_notice:waiting:review",
      payload: {
        workflowId: "workflow_wait_notice",
        summary: "Workflow is waiting.",
        wait: { kind: "input", reason: "Need review." },
      },
    });

    const reopened = new FileWorkflowNotificationOutbox({ rootDir: root });
    const inbox = reopened.asActorInbox();
    await inbox.waitUntilAvailable({
      predicate: (notification) => notification.type === "waiting",
    });
    expect(await inbox.peek()).toMatchObject([
      {
        source: {
          kind: "workflow",
          id: "workflow_wait_notice",
          runId: "run_parent",
          sessionId: "session_wait",
        },
        routeHint: {
          parentRunId: "run_parent",
          sessionId: "session_wait",
        },
        type: "waiting",
        qos: "reliable",
        payload: {
          workflowId: "workflow_wait_notice",
          wait: { kind: "input", reason: "Need review." },
        },
      },
    ]);
    expect(await inbox.drain()).toHaveLength(1);
    expect(await inbox.peek()).toHaveLength(0);
  });
});
