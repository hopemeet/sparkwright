import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventId, EventType, RunId } from "@sparkwright/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  shadowWorkflowFromEvents,
  shadowWorkflowFromSession,
} from "../src/workflow-shadow.js";
import { parseWorkflowMarkdownAsset } from "../src/workflows.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function event(
  sequence: number,
  type: EventType,
  payload: Record<string, unknown> = {},
) {
  return {
    id: `evt_${sequence}` as EventId,
    runId: "run_shadow" as RunId,
    type,
    timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    payload,
    metadata: { sessionId: "session_shadow", agentId: "main" },
  };
}

function workflow(raw: string) {
  return parseWorkflowMarkdownAsset({
    assetName: "shadowed-flow",
    dir: "/tmp/shadowed-flow",
    sourcePath: "/tmp/shadowed-flow/workflow.md",
    raw,
  });
}

function observedEditTrace() {
  return [
    event(1, "run.created", { goal: "update README and verify" }),
    event(2, "tool.requested", {
      id: "read_1",
      toolName: "read_file",
      arguments: { path: "README.md" },
    }),
    event(3, "workspace.read", { path: "README.md" }),
    event(4, "tool.requested", {
      id: "edit_1",
      toolName: "edit_anchored_text",
    }),
    event(5, "workspace.write.completed", { path: "README.md" }),
    event(6, "tool.requested", {
      id: "todo_1",
      toolName: "todo_write",
    }),
    event(7, "tool.requested", {
      id: "bash_1",
      toolName: "bash",
      arguments: { command: "npm test -- docs" },
    }),
    event(8, "tool.completed", {
      toolCallId: "bash_1",
      toolName: "bash",
      status: "completed",
    }),
    event(9, "run.completed", { state: "completed" }),
  ];
}

describe("workflow shadow", () => {
  it("matches observed trace coverage against workflow declarations", () => {
    const report = shadowWorkflowFromEvents({
      workflow: workflow(
        [
          "---",
          "version: 1.0.0",
          "nodes:",
          "  - id: implement",
          "    execute: model",
          "    tools: [read, edit, bash, todo_write]",
          "    verify:",
          "      - id: scoped",
          "        kind: diff_scope",
          "        include: [README.md]",
          "      - id: tests",
          "        kind: command",
          "        command: bash",
          '        args: ["-lc", "npm test -- docs"]',
          "        authorized: true",
          "      - id: todos",
          "        kind: todo_clear",
          "---",
          "## implement",
          "Update and verify.",
        ].join("\n"),
      ),
      sessionId: "session_shadow",
      tracePath: "/tmp/session_shadow/trace.jsonl",
      events: observedEditTrace(),
    });

    expect(report.ok).toBe(true);
    expect(report.summary.missing).toBe(0);
    expect(report.observed.writePaths).toEqual(["README.md"]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tool:edit",
          status: "matched",
          nodeId: "implement",
        }),
        expect.objectContaining({
          id: "write:README.md",
          kind: "write_path",
          status: "matched",
        }),
        expect.objectContaining({
          id: "command:8",
          kind: "verification_command",
          status: "matched",
        }),
        expect.objectContaining({
          id: "todo_clear",
          status: "matched",
        }),
      ]),
    );
  });

  it("fails when observed tools, writes, or gates are not covered", () => {
    const report = shadowWorkflowFromEvents({
      workflow: workflow(
        [
          "---",
          "nodes:",
          "  - id: inspect",
          "    execute: model",
          "    tools: [read]",
          "    verify:",
          "      - id: scoped",
          "        kind: diff_scope",
          "        include: [docs/**]",
          "---",
          "## inspect",
          "Inspect only.",
        ].join("\n"),
      ),
      sessionId: "session_shadow",
      tracePath: "/tmp/session_shadow/trace.jsonl",
      events: observedEditTrace(),
    });

    expect(report.ok).toBe(false);
    expect(report.summary.missing).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:edit", status: "missing" }),
        expect.objectContaining({ id: "tool:bash", status: "missing" }),
        expect.objectContaining({ id: "write:README.md", status: "missing" }),
        expect.objectContaining({
          id: "command:8",
          status: "missing",
        }),
        expect.objectContaining({ id: "todo_clear", status: "missing" }),
      ]),
    );
  });

  it("treats declared but unobserved workflow coverage as review-only", () => {
    const report = shadowWorkflowFromEvents({
      workflow: workflow(
        [
          "---",
          "nodes:",
          "  - id: check",
          "    execute: model",
          "    tools: [read, grep]",
          "    verify:",
          "      - id: scoped",
          "        kind: diff_scope",
          "        include: [README.md]",
          "      - id: lint",
          "        kind: command",
          "        command: bash",
          '        args: ["-lc", "npm run lint"]',
          "        authorized: true",
          "      - id: todos",
          "        kind: todo_clear",
          "---",
          "## check",
          "Check without writes.",
        ].join("\n"),
      ),
      sessionId: "session_shadow",
      tracePath: "/tmp/session_shadow/trace.jsonl",
      events: [
        event(1, "run.created", { goal: "inspect README" }),
        event(2, "tool.requested", {
          id: "read_1",
          toolName: "read_file",
        }),
        event(3, "workspace.read", { path: "README.md" }),
        event(4, "run.completed", { state: "completed" }),
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.summary.missing).toBe(0);
    expect(report.summary.unobserved).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool:grep:unobserved" }),
        expect.objectContaining({ id: "command:lint:unobserved" }),
        expect.objectContaining({ id: "todo_clear:todos:unobserved" }),
      ]),
    );
  });

  it("marks non-completed traces as needing review", () => {
    const report = shadowWorkflowFromEvents({
      workflow: workflow(
        [
          "---",
          "nodes:",
          "  - id: inspect",
          "    tools: [read]",
          "---",
          "## inspect",
          "Inspect.",
        ].join("\n"),
      ),
      sessionId: "session_shadow",
      tracePath: "/tmp/session_shadow/trace.jsonl",
      events: [
        event(1, "run.created", { goal: "try shadow" }),
        event(2, "run.completed", { state: "failed" }),
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.warnings).toContain(
      "source session terminal state is failed, not completed",
    );
  });

  it("loads a workflow asset and session trace without creating workflow state", async () => {
    const root = await tempRoot("sparkwright-workflow-shadow-");
    await mkdir(join(root, ".sparkwright", "workflows", "shadowed-flow"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".sparkwright", "workflows", "shadowed-flow", "workflow.md"),
      [
        "---",
        "nodes:",
        "  - id: implement",
        "    execute: model",
        "    tools: [read, edit, bash, todo_write]",
        "    verify:",
        "      - id: scoped",
        "        kind: diff_scope",
        "        include: [README.md]",
        "      - id: tests",
        "        kind: command",
        "        command: bash",
        '        args: ["-lc", "npm test -- docs"]',
        "        authorized: true",
        "      - id: todos",
        "        kind: todo_clear",
        "---",
        "## implement",
        "Implement.",
      ].join("\n"),
      "utf8",
    );
    const sessionDir = join(root, ".sparkwright", "sessions", "session_shadow");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "trace.jsonl"),
      observedEditTrace()
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const report = await shadowWorkflowFromSession({
      workspaceRoot: root,
      sessionRootDir: join(root, ".sparkwright", "sessions"),
      workflowName: "shadowed-flow",
      sessionId: "session_shadow",
    });

    expect(report.ok).toBe(true);
    await expect(access(join(sessionDir, "workflow-runs"))).rejects.toThrow();
    await expect(
      shadowWorkflowFromSession({
        workspaceRoot: root,
        sessionRootDir: join(root, ".sparkwright", "sessions"),
        workflowName: "shadowed-flow",
        sessionId: "../escape",
      }),
    ).rejects.toThrow(/session id/);
  });
});
