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
  WorkflowStaleWriteError,
  runWorkflowRunChain,
  workspaceWorkflowRunsDir,
  WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
  workflowRunsDir,
  validateWorkflowRuntimeDefinition,
  type WorkflowRunId,
  type WorkflowDefinition,
} from "../src/index.js";
import {
  publishWorkflowJournalEntry,
  readWorkflowJournal,
  readWorkflowJournalSync,
} from "../src/workflows/journal.js";

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
  it("fences an expired writer after a higher-generation takeover", async () => {
    const root = await tempDir();
    const storeA = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_fenced" as WorkflowRunId;
    let now = new Date("2026-07-11T00:00:00.000Z");
    const writerA = await storeA.acquireWriter(id, {
      owner: "worker-a",
      ttlMs: 1_000,
      now: () => now,
    });
    expect(writerA?.generation).toBe(1);
    const created = await writerA?.create({
      id,
      assetName: "fenced",
      contentHash: "hash",
      now: () => now.toISOString(),
    });
    expect(created).toMatchObject({ generation: 1, recordRevision: 1 });

    now = new Date("2026-07-11T00:00:02.000Z");
    const storeB = new FileWorkflowStore({ rootDir: root });
    const writerB = await storeB.acquireWriter(id, {
      owner: "worker-b",
      ttlMs: 1_000,
      now: () => now,
    });
    expect(writerB?.generation).toBe(2);
    const completed = await writerB?.mutate({
      expectedRevision: 1,
      patch: { status: "completed", now: () => now.toISOString() },
      event: {
        at: now.toISOString(),
        type: "completed",
        workflowRunId: id,
        status: "completed",
      },
    });
    expect(completed).toMatchObject({
      generation: 2,
      recordRevision: 2,
      status: "completed",
    });

    await expect(
      writerA?.mutate({
        expectedRevision: 1,
        patch: { status: "failed" },
        event: {
          at: now.toISOString(),
          type: "failed",
          workflowRunId: id,
          status: "failed",
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowStaleWriteError);
    await expect(
      writerA?.compensate({
        expectedRevision: 1,
        patch: { status: "waiting", wait: { kind: "input" } },
        event: {
          at: now.toISOString(),
          type: "waiting",
          workflowRunId: id,
          status: "waiting",
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowStaleWriteError);
    expect(await writerA?.release()).toBe(false);
    expect(await writerB?.readFresh()).toMatchObject({
      status: "completed",
      recordRevision: 2,
    });
    expect(storeB.eventLog(id).events.map((event) => event.type)).toEqual([
      "created",
      "completed",
    ]);
    await writeFile(join(root, `${id}.json`), "{torn", "utf8");
    await writeFile(join(root, `${id}.events.jsonl`), "{torn\n", "utf8");
    const recovered = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });
    expect(recovered.get(id)).toMatchObject({
      status: "completed",
      generation: 2,
      recordRevision: 2,
    });
    expect(recovered.eventLog(id).events.map((event) => event.type)).toEqual([
      "created",
      "completed",
    ]);
    await writerB?.release();
  });

  it("allows only one canonical mutation for a shared expected revision", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_revision_race" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "worker" });
    const created = await writer!.create({
      id,
      assetName: "race",
      contentHash: "hash",
    });
    const event = (status: "waiting" | "completed") => ({
      at: new Date().toISOString(),
      type: status as "waiting" | "completed",
      workflowRunId: id,
      status,
    });
    const attempts = await Promise.allSettled([
      writer!.mutate({
        expectedRevision: created.recordRevision!,
        patch: { status: "waiting", wait: { kind: "input" } },
        event: event("waiting"),
      }),
      writer!.mutate({
        expectedRevision: created.recordRevision!,
        patch: { status: "completed" },
        event: event("completed"),
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await writer!.readFresh())?.recordRevision).toBe(2);
    expect(store.eventLog(id).events).toHaveLength(2);
    await writer!.release();
  });

  it("rejects record identity that does not match the claimed writer", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_identity" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "worker" });
    await expect(
      writer!.create({
        id: "workflow_other" as WorkflowRunId,
        assetName: "identity",
        contentHash: "hash",
      }),
    ).rejects.toThrow(/cannot create record/);
    expect(await writer!.readFresh()).toBeUndefined();
    await writer!.release();
  });

  it("quarantines a stale-generation physical entry without advancing revision or events", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_stale_entry" as WorkflowRunId;
    let now = new Date("2026-07-11T00:00:00.000Z");
    const writerA = await store.acquireWriter(id, {
      owner: "a",
      ttlMs: 1_000,
      now: () => now,
    });
    const created = await writerA!.create({
      id,
      assetName: "stale",
      contentHash: "hash",
    });
    now = new Date("2026-07-11T00:00:02.000Z");
    const writerB = await store.acquireWriter(id, {
      owner: "b",
      ttlMs: 1_000,
      now: () => now,
    });
    const before = await readWorkflowJournal(root, id);
    await publishWorkflowJournalEntry({
      rootDir: root,
      workflowRunId: id,
      physicalSequence: before!.physicalSequence + 1,
      payload: {
        kind: "mutation",
        token: writerA!.token,
        generation: writerA!.generation,
        expectedRecordRevision: created.recordRevision!,
        recordRevision: created.recordRevision! + 1,
        record: {
          ...created,
          generation: writerA!.generation,
          recordRevision: created.recordRevision! + 1,
          status: "failed",
        },
        event: {
          at: now.toISOString(),
          type: "failed",
          workflowRunId: id,
          status: "failed",
        },
      },
    });
    const quarantined = await readWorkflowJournal(root, id);
    expect(quarantined).toMatchObject({ generation: 2, recordRevision: 1 });
    expect(quarantined!.quarantined).toHaveLength(1);
    expect(quarantined!.events.map((event) => event.type)).toEqual(["created"]);
    const completed = await writerB!.mutate({
      expectedRevision: 1,
      patch: { status: "completed" },
      event: {
        at: now.toISOString(),
        type: "completed",
        workflowRunId: id,
        status: "completed",
      },
    });
    expect(completed).toMatchObject({
      generation: 2,
      recordRevision: 2,
      status: "completed",
    });
    await writerB!.release();
  });

  it("recovers after a torn canonical publication slot", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_torn_publication" as WorkflowRunId;
    const writerA = await store.acquireWriter(id, { owner: "a" });
    const created = await writerA!.create({
      id,
      assetName: "torn",
      contentHash: "hash",
    });
    expect(created.recordRevision).toBe(1);
    const head = await readWorkflowJournal(root, id);
    const tornSequence = head!.physicalSequence + 1;
    await writeFile(
      join(
        root,
        `${id}.journal`,
        `${String(tornSequence).padStart(16, "0")}.json`,
      ),
      '{"schemaVersion":"sparkwright-workflow-journal.v1"',
      "utf8",
    );
    expect(await readWorkflowJournal(root, id)).toMatchObject({
      recordRevision: 1,
      quarantined: [expect.anything()],
    });
    await writerA!.release();
    const writerB = await store.acquireWriter(id, { owner: "b" });
    expect(writerB).toMatchObject({ generation: 2 });
    const completed = await writerB!.mutate({
      expectedRevision: 1,
      patch: { status: "completed" },
      event: {
        at: "recovered",
        type: "completed",
        workflowRunId: id,
        status: "completed",
      },
    });
    expect(completed).toMatchObject({
      generation: 2,
      recordRevision: 2,
      status: "completed",
    });
    expect(store.eventLog(id).events.map((event) => event.type)).toEqual([
      "created",
      "completed",
    ]);
    await writerB!.release();
  });

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

    const writer = await store.acquireWriter(id, { owner: "test" });
    const created = await writer!.create({
      id,
      parentRunId: "run_parent" as RunId,
      sessionId: "sess_one",
      activeRunId: "run_first" as RunId,
      assetName: definition.assetName,
      contentHash: definition.contentHash,
      currentNodeId: "plan",
      attempts: { plan: 1 },
      authorizationSnapshot: {
        targetPath: "README.md",
        confidentialPaths: [".env"],
        confidentialDefaults: false,
        accessMode: "ask",
        backgroundTasks: "foreground-only",
      },
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
      authorizationSnapshot: {
        targetPath: "README.md",
        confidentialPaths: [".env"],
        confidentialDefaults: false,
        accessMode: "ask",
        backgroundTasks: "foreground-only",
      },
      definitionSnapshot: {
        assetName: "test-workflow",
        nodes: [{ id: "plan" }, { id: "patch" }],
      },
    });

    const updated = await writer!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
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
      },
      event: {
        at: "2026-07-04T00:02:00.000Z",
        type: "completed",
        workflowRunId: id,
        status: "completed",
      },
    });
    await writer!.release();

    expect(updated.completedAt).toBe("2026-07-04T00:02:00.000Z");
    expect(updated.transitionLog).toHaveLength(1);

    const reopened = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });
    expect(reopened.get(id)).toMatchObject({
      status: "completed",
      completedAt: "2026-07-04T00:02:00.000Z",
      authorizationSnapshot: {
        targetPath: "README.md",
        confidentialPaths: [".env"],
        confidentialDefaults: false,
        accessMode: "ask",
        backgroundTasks: "foreground-only",
      },
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

  it("reads legacy workflow records without authorization snapshots", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "workflow_legacy.json"),
      JSON.stringify(
        {
          schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
          id: "workflow_legacy",
          assetName: "legacy",
          contentHash: "hash",
          runIds: [],
          status: "running",
          attempts: {},
          evidenceRefs: [],
          verdictLog: [],
          transitionLog: [],
          resume: { verifyOnResume: true },
          createdAt: "2026-07-04T00:00:00.000Z",
          metadata: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const reopened = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });

    expect(reopened.get("workflow_legacy" as WorkflowRunId)).toMatchObject({
      id: "workflow_legacy",
      status: "running",
    });
    expect(
      reopened.get("workflow_legacy" as WorkflowRunId)?.authorizationSnapshot,
    ).toBeUndefined();
  });

  it("resumes an idempotent lazy migration after baseline publication", async () => {
    const root = await tempDir();
    const id = "workflow_migration_retry" as WorkflowRunId;
    const legacy = {
      schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
      id,
      assetName: "legacy",
      contentHash: "hash",
      runIds: [],
      status: "running" as const,
      attempts: {},
      evidenceRefs: [],
      verdictLog: [],
      transitionLog: [],
      resume: { verifyOnResume: true },
      createdAt: "2026-07-04T00:00:00.000Z",
      metadata: {},
    };
    await writeFile(join(root, `${id}.json`), JSON.stringify(legacy), "utf8");
    const legacyEvent = {
      at: legacy.createdAt,
      type: "created" as const,
      workflowRunId: id,
      status: "running" as const,
    };
    await writeFile(
      join(root, `${id}.events.jsonl`),
      `${JSON.stringify(legacyEvent)}\n`,
      "utf8",
    );
    const store = new FileWorkflowStore({ rootDir: root, createRoot: false });
    const record = store.get(id)!;
    expect(
      await publishWorkflowJournalEntry({
        rootDir: root,
        workflowRunId: id,
        physicalSequence: 0,
        payload: {
          kind: "baseline",
          generation: 0,
          recordRevision: 0,
          record: { ...record, generation: 0, recordRevision: 0 },
          legacyEvents: [legacyEvent],
        },
      }),
    ).toBe(true);

    const writer = await store.acquireWriter(id, { owner: "migration-retry" });
    expect(writer).toMatchObject({ generation: 1 });
    expect(await writer!.readFresh()).toMatchObject({
      id,
      generation: 0,
      recordRevision: 0,
    });
    const migrated = await writer!.mutate({
      expectedRevision: 0,
      patch: { metadata: { migrated: true } },
      event: {
        at: "2026-07-04T00:01:00.000Z",
        type: "updated",
        workflowRunId: id,
        status: "running",
        metadata: { migration: true },
      },
    });
    expect(migrated).toMatchObject({
      generation: 1,
      recordRevision: 1,
      metadata: { migrated: true },
    });
    expect(store.eventLog(id).events).toEqual([
      legacyEvent,
      expect.objectContaining({ metadata: { migration: true } }),
    ]);
    await writer!.release();
  });

  it("keeps async and sync replay aligned for a mismatched baseline record", async () => {
    const root = await tempDir();
    const id = "workflow_baseline_identity" as WorkflowRunId;
    const wrongId = "workflow_other_identity" as WorkflowRunId;
    expect(
      await publishWorkflowJournalEntry({
        rootDir: root,
        workflowRunId: id,
        physicalSequence: 0,
        payload: {
          kind: "baseline",
          generation: 0,
          recordRevision: 0,
          record: {
            schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
            id: wrongId,
            assetName: "legacy",
            contentHash: "hash",
            runIds: [],
            status: "running",
            attempts: {},
            evidenceRefs: [],
            verdictLog: [],
            transitionLog: [],
            resume: { verifyOnResume: true },
            createdAt: "2026-07-04T00:00:00.000Z",
            metadata: {},
            generation: 0,
            recordRevision: 0,
          },
          legacyEvents: [],
        },
      }),
    ).toBe(true);

    const asynchronous = await readWorkflowJournal(root, id);
    const synchronous = readWorkflowJournalSync(root, id);
    expect(asynchronous).toEqual(synchronous);
    expect(asynchronous?.record).toBeUndefined();
    expect(asynchronous).toMatchObject({
      quarantined: [
        expect.objectContaining({
          reason: "baseline record identity mismatch",
        }),
      ],
    });
  });

  it("allows only one concurrent lazy-migration claimant", async () => {
    const root = await tempDir();
    const id = "workflow_migration_race" as WorkflowRunId;
    await writeFile(
      join(root, `${id}.json`),
      JSON.stringify({
        schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
        id,
        assetName: "legacy",
        contentHash: "hash",
        runIds: [],
        status: "running",
        attempts: {},
        evidenceRefs: [],
        verdictLog: [],
        transitionLog: [],
        resume: { verifyOnResume: true },
        createdAt: "2026-07-04T00:00:00.000Z",
        metadata: {},
      }),
      "utf8",
    );
    const storeA = new FileWorkflowStore({ rootDir: root });
    const storeB = new FileWorkflowStore({ rootDir: root });
    const claims = await Promise.all([
      storeA.acquireWriter(id, { owner: "a" }),
      storeB.acquireWriter(id, { owner: "b" }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ generation: 1 });
    await claims.find(Boolean)!.release();
  });

  it("treats partial authorization snapshots as absent instead of defaulting privileges", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "workflow_partial_auth.json"),
      JSON.stringify(
        {
          schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
          id: "workflow_partial_auth",
          assetName: "legacy",
          contentHash: "hash",
          runIds: [],
          status: "running",
          attempts: {},
          evidenceRefs: [],
          verdictLog: [],
          transitionLog: [],
          resume: { verifyOnResume: true },
          authorizationSnapshot: {},
          createdAt: "2026-07-04T00:00:00.000Z",
          metadata: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const reopened = new FileWorkflowStore({
      rootDir: root,
      createRoot: false,
    });

    expect(
      reopened.get("workflow_partial_auth" as WorkflowRunId)
        ?.authorizationSnapshot,
    ).toBeUndefined();
  });

  it("can restore a workflow record snapshot after a failed adoption attempt", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_restore" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "test" });
    const original = await writer!.create({
      id,
      assetName: "restore",
      contentHash: "hash",
      currentNodeId: "review",
      attempts: { review: 1 },
      definitionSnapshot: workflow([
        { id: "review", execute: "human", body: "Review." },
      ]),
    });
    const waiting = await writer!.mutate({
      expectedRevision: original.recordRevision!,
      patch: {
        status: "waiting",
        wait: { kind: "input", reason: "Need input." },
      },
      event: {
        at: "2026-07-04T00:00:01.000Z",
        type: "waiting",
        workflowRunId: id,
        status: "waiting",
      },
    });
    const advanced = await writer!.mutate({
      expectedRevision: waiting.recordRevision!,
      patch: {
        status: "running",
        clearWait: true,
        currentNodeId: "finish",
        attempts: { review: 1, finish: 1 },
        verdictLog: [
          {
            at: "2026-07-04T00:00:01.000Z",
            nodeId: "review",
            attempt: 1,
            verdict: { status: "passed" },
          },
        ],
      },
      event: {
        at: "2026-07-04T00:00:01.500Z",
        type: "updated",
        workflowRunId: id,
        status: "running",
      },
    });

    const restored = await writer!.compensate({
      expectedRevision: advanced.recordRevision!,
      patch: {
        status: waiting.status,
        currentNodeId: waiting.currentNodeId,
        wait: waiting.wait,
        attempts: waiting.attempts,
        evidenceRefs: waiting.evidenceRefs,
        verdictLog: waiting.verdictLog,
        transitionLog: waiting.transitionLog,
        metadata: { rollbackReason: "test" },
        now: () => "2026-07-04T00:00:02.000Z",
      },
      event: {
        at: "2026-07-04T00:00:02.000Z",
        type: "waiting",
        workflowRunId: id,
        status: "waiting",
        metadata: { compensation: true },
      },
    });
    await writer!.release();

    expect(restored).toMatchObject({
      status: "waiting",
      currentNodeId: "review",
      wait: { kind: "input", reason: "Need input." },
      attempts: { review: 1 },
      verdictLog: [],
    });
    expect(store.get(id)).toMatchObject({
      status: "waiting",
      currentNodeId: "review",
      wait: { kind: "input", reason: "Need input." },
    });
  });

  it("lists valid records while reporting corrupt entries", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_good" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "test" });
    await writer!.create({
      id,
      assetName: "ok",
      contentHash: "hash",
    });
    await writer!.release();
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

  it("rebuilds event projection from the canonical journal", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_events" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "test" });
    const created = await writer!.create({
      id,
      assetName: "events",
      contentHash: "hash",
      now: () => "2026-07-04T00:00:00.000Z",
    });
    await writer!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
        status: "failed",
        failure: {
          kind: "runtime",
          code: "workflow.runtime",
          message: "projection failed",
        },
        now: () => "2026-07-04T00:01:00.000Z",
      },
      event: {
        at: "2026-07-04T00:01:00.000Z",
        type: "failed",
        workflowRunId: id,
        status: "failed",
      },
    });
    await writer!.release();
    await writeFile(join(root, `${id}.events.jsonl`), "{bad\n", {
      flag: "a",
    });

    const log = store.eventLog(id);

    expect(log.events.map((event) => event.type)).toEqual([
      "created",
      "failed",
    ]);
    expect(log.invalidEntries).toEqual([]);
  });

  it("leases workflow records for single-writer adoption", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_lease" as WorkflowRunId;
    const creator = await store.acquireWriter(id, { owner: "creator" });
    await creator!.create({ id, assetName: "lease", contentHash: "hash" });
    await creator!.release();
    const first = await store.acquireWriter(id, {
      owner: "worker-a",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });
    expect(first).not.toBeNull();

    const second = await store.acquireWriter(id, {
      owner: "worker-b",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:01.000Z"),
    });
    expect(second).toBeNull();

    expect(await first?.release()).toBe(true);
    const afterRelease = await store.acquireWriter(id, {
      owner: "worker-b",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:02.000Z"),
    });
    expect(afterRelease?.generation).toBe(first!.generation + 1);
    await afterRelease?.release();
  });

  it("does not log adoption for fresh pre-create leases and uses the injected release clock", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_fresh_lease" as WorkflowRunId;
    let now = new Date("2026-07-04T00:00:00.000Z");

    const lease = await store.acquireWriter(id, {
      owner: "fresh-worker",
      ttlMs: 60_000,
      now: () => now,
    });
    expect(lease).not.toBeNull();
    expect(store.eventLog(id).events).toEqual([]);

    await lease!.create({
      id,
      assetName: "fresh",
      contentHash: "hash",
      now: () => "2026-07-04T00:01:00.000Z",
    });
    now = new Date("2026-07-04T00:02:00.000Z");
    expect(await lease?.release()).toBe(true);

    expect(store.eventLog(id).events.map((event) => event.type)).toEqual([
      "created",
    ]);
  });

  it("requires waiting records to carry wait.kind and clears wait on terminal", async () => {
    const root = await tempDir();
    const store = new FileWorkflowStore({ rootDir: root });
    const id = "workflow_wait" as WorkflowRunId;
    const writer = await store.acquireWriter(id, { owner: "test" });
    const created = await writer!.create({
      id,
      assetName: "wait",
      contentHash: "hash",
    });
    await expect(
      writer!.mutate({
        expectedRevision: created.recordRevision!,
        patch: { status: "waiting" },
        event: {
          at: "t1",
          type: "waiting",
          workflowRunId: id,
          status: "waiting",
        },
      }),
    ).rejects.toThrow(/wait.kind/);
    const waiting = await writer!.mutate({
      expectedRevision: created.recordRevision!,
      patch: {
        status: "waiting",
        wait: { kind: "input", reason: "need user" },
      },
      event: {
        at: "t1",
        type: "waiting",
        workflowRunId: id,
        status: "waiting",
        metadata: { wait: { kind: "input", reason: "need user" } },
      },
    });
    expect(waiting.wait).toMatchObject({
      id: "workflow_wait_2",
      kind: "input",
      reason: "need user",
    });
    expect(store.eventLog(id).events.at(-1)).toMatchObject({
      type: "waiting",
      status: "waiting",
      metadata: { wait: { kind: "input", reason: "need user" } },
    });
    await expect(
      writer!.mutate({
        expectedRevision: waiting.recordRevision!,
        patch: { status: "waiting", clearWait: true },
        event: {
          at: "t2",
          type: "waiting",
          workflowRunId: id,
          status: "waiting",
        },
      }),
    ).rejects.toThrow(/wait.kind/);
    const cancelled = await writer!.mutate({
      expectedRevision: waiting.recordRevision!,
      patch: { status: "cancelled" },
      event: {
        at: "t3",
        type: "cancelled",
        workflowRunId: id,
        status: "cancelled",
      },
    });
    expect(cancelled.wait).toBeUndefined();
    await writer!.release();
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
