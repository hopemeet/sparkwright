import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventId, EventType, RunId } from "@sparkwright/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  distillWorkflowFromEvents,
  distillWorkflowFromSession,
} from "../src/workflow-distill.js";
import { parseWorkflowMarkdownAsset } from "../src/workflows.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function tempSessionRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sparkwright-workflow-distill-"));
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
    runId: "run_distill" as RunId,
    type,
    timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    payload,
    metadata: { sessionId: "session_distill", agentId: "main" },
  };
}

describe("workflow distill", () => {
  it("distills a completed session trace into a review-first workflow draft", () => {
    const report = distillWorkflowFromEvents({
      sessionId: "session_distill",
      tracePath: "/tmp/session_distill/trace.jsonl",
      events: [
        event(1, "run.created", { goal: "fix docs and verify" }),
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
          exitCode: 0,
        }),
        event(9, "run.completed", { state: "completed" }),
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.assetName).toBe("distilled-fix-docs-and-verify");
    expect(report.observed.writePaths).toEqual(["README.md"]);
    expect(report.observed.verificationCommands).toEqual([
      { command: "npm test -- docs", toolName: "bash", sequence: 8 },
    ]);
    expect(report.markdown).toContain("## inspect");
    expect(report.markdown).toContain("## implement");
    expect(report.markdown).toContain("kind: diff_scope");
    expect(report.markdown).toContain("kind: todo_clear");
    expect(report.markdown).toContain("npm test -- docs");
    expect(
      parseWorkflowMarkdownAsset({
        assetName: report.assetName,
        dir: "/tmp/distilled",
        sourcePath: "/tmp/distilled/workflow.md",
        raw: report.markdown,
      }).definition.nodes,
    ).toEqual([
      expect.objectContaining({ id: "inspect" }),
      expect.objectContaining({ id: "implement" }),
    ]);
  });

  it("marks non-completed traces as needing review", () => {
    const report = distillWorkflowFromEvents({
      sessionId: "session_distill",
      tracePath: "/tmp/session_distill/trace.jsonl",
      events: [
        event(1, "run.created", { goal: "try workflow" }),
        event(2, "run.completed", { state: "failed" }),
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.warnings).toContain(
      "source session terminal state is failed, not completed",
    );
  });

  it("loads traces from a safe session id", async () => {
    const root = await tempSessionRoot();
    await mkdir(join(root, "session_distill"), { recursive: true });
    await writeFile(
      join(root, "session_distill", "trace.jsonl"),
      [
        JSON.stringify(event(1, "run.created", { goal: "inspect" })),
        JSON.stringify(event(2, "run.completed", { state: "completed" })),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await distillWorkflowFromSession({
      sessionRootDir: root,
      sessionId: "session_distill",
    });

    expect(report.ok).toBe(true);
    expect(report.tracePath).toBe(join(root, "session_distill", "trace.jsonl"));
  });

  it("rejects unsafe session ids before building a trace path", async () => {
    await expect(
      distillWorkflowFromSession({
        sessionRootDir: "/tmp/root",
        sessionId: "../escape",
      }),
    ).rejects.toThrow(/session id/);
  });
});
