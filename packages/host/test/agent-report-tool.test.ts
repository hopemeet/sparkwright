import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "@sparkwright/core";
import {
  createReadAgentReportTool,
  READ_AGENT_REPORT_TOOL_NAME,
} from "../src/agent-report-tool.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("read_agent_report", () => {
  it("reads a session-authorized child report with resumable pagination", async () => {
    const root = await createSessionRoot();
    const sessionId = "session_agent_report";
    const parentRunId = "run_parent";
    const childRunId = "run_child";
    const report = "0123456789".repeat(900);
    await writeChildRun({
      root,
      sessionId,
      parentRunId,
      childRunId,
      agentId: "reviewer",
      result: {
        signal: "completed",
        state: "completed",
        message: report,
        assessment: { health: "clean", issues: [] },
        metadata: {},
      },
    });

    const tool = createReadAgentReportTool({ sessionRootDir: root, sessionId });
    expect(tool.name).toBe(READ_AGENT_REPORT_TOOL_NAME);
    expect(tool.resultPresentation).toMatchObject({ kind: "file_read" });
    const first = (await tool.execute(
      { childRunId, offset: 0, limit: 6_000 },
      {} as never,
    )) as Record<string, unknown>;
    expect(first).toMatchObject({
      childRunId,
      report: report.slice(0, 6_000),
      offset: 0,
      limit: 6_000,
      returnedChars: 6_000,
      totalChars: report.length,
      hasMore: true,
      nextOffset: 6_000,
    });

    const resumedTool = createReadAgentReportTool({
      sessionRootDir: root,
      sessionId,
    });
    await expect(
      resumedTool.execute(
        { childRunId, offset: first.nextOffset, limit: 6_000 },
        {} as never,
      ),
    ).resolves.toMatchObject({
      childRunId,
      report: report.slice(6_000),
      offset: 6_000,
      returnedChars: report.length - 6_000,
      totalChars: report.length,
      hasMore: false,
    });
  });

  it("rejects main, unregistered, cross-session, and path-like run ids", async () => {
    const root = await createSessionRoot();
    const sessionId = "session_authorized";
    const store = new FileSessionStore({ rootDir: root });
    await store.create({ id: sessionId });
    await store.append(sessionId, "run_main" as never);
    await writeRunFiles({
      root,
      sessionId,
      agentId: "main",
      runId: "run_main",
      parentRunId: "run_parent",
      message: "main report",
    });

    await writeChildRun({
      root,
      sessionId: "session_other",
      parentRunId: "run_other_parent",
      childRunId: "run_other_child",
      agentId: "reviewer",
      result: { message: "other session report", metadata: {} },
    });
    await writeRunFiles({
      root,
      sessionId,
      agentId: "reviewer",
      runId: "run_unregistered",
      parentRunId: "run_main",
      message: "unregistered report",
    });

    const tool = createReadAgentReportTool({ sessionRootDir: root, sessionId });
    for (const childRunId of [
      "run_main",
      "run_unregistered",
      "run_other_child",
      "../result.json",
    ]) {
      await expect(
        tool.execute({ childRunId }, {} as never),
      ).rejects.toMatchObject({ code: "AGENT_REPORT_NOT_FOUND" });
    }
  });

  it("rejects a result symlink that escapes the authorized child run", async () => {
    const root = await createSessionRoot();
    const sessionId = "session_report_symlink";
    const parentRunId = "run_parent";
    const childRunId = "run_symlink_child";
    const store = new FileSessionStore({ rootDir: root });
    await store.create({ id: sessionId });
    await store.append(sessionId, parentRunId as never);
    await store.append(sessionId, childRunId as never);
    const runDir = join(
      root,
      sessionId,
      "agents",
      "reviewer",
      "runs",
      childRunId,
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ id: childRunId, metadata: { parentRunId } }),
    );
    const outside = join(root, "outside-result.json");
    await writeFile(outside, JSON.stringify({ message: "secret" }));
    await symlink(outside, join(runDir, "result.json"));

    const tool = createReadAgentReportTool({ sessionRootDir: root, sessionId });
    await expect(
      tool.execute({ childRunId }, {} as never),
    ).rejects.toMatchObject({ code: "AGENT_REPORT_NOT_FOUND" });
  });

  it("rejects a current-session symlink to another session", async () => {
    const root = await createSessionRoot();
    const otherSessionId = "session_report_symlink_target";
    const childRunId = "run_other_child";
    await writeChildRun({
      root,
      sessionId: otherSessionId,
      parentRunId: "run_other_parent",
      childRunId,
      agentId: "reviewer",
      result: { message: "other session secret", metadata: {} },
    });
    const currentSessionId = "session_report_symlink_alias";
    await symlink(
      join(root, otherSessionId),
      join(root, currentSessionId),
      "dir",
    );

    const tool = createReadAgentReportTool({
      sessionRootDir: root,
      sessionId: currentSessionId,
    });
    await expect(
      tool.execute({ childRunId }, {} as never),
    ).rejects.toMatchObject({ code: "AGENT_REPORT_NOT_FOUND" });
  });

  it("validates offset and limit even when invoked directly", async () => {
    const root = await createSessionRoot();
    const tool = createReadAgentReportTool({
      sessionRootDir: root,
      sessionId: "session_validation",
    });
    for (const args of [
      {},
      { childRunId: "run_child", offset: -1 },
      { childRunId: "run_child", offset: 1.5 },
      { childRunId: "run_child", limit: 0 },
      { childRunId: "run_child", limit: 6_001 },
      { childRunId: "run_child", path: "/tmp/result.json" },
    ]) {
      await expect(tool.execute(args, {} as never)).rejects.toMatchObject({
        code: "AGENT_REPORT_ARGUMENTS_INVALID",
      });
    }
  });

  it("reads terminal summaries and failure messages when no run message exists", async () => {
    const root = await createSessionRoot();
    const sessionId = "session_report_fallbacks";
    const parentRunId = "run_parent";
    await writeChildRun({
      root,
      sessionId,
      parentRunId,
      childRunId: "run_terminal",
      agentId: "reviewer",
      result: {
        metadata: {
          terminalResult: { output: { summary: "terminal summary" } },
        },
      },
    });
    const store = new FileSessionStore({ rootDir: root });
    await store.append(sessionId, "run_failure" as never);
    await writeRunFiles({
      root,
      sessionId,
      agentId: "reviewer",
      runId: "run_failure",
      parentRunId,
      result: { failure: { message: "failure report" } },
    });

    const tool = createReadAgentReportTool({ sessionRootDir: root, sessionId });
    await expect(
      tool.execute({ childRunId: "run_terminal" }, {} as never),
    ).resolves.toMatchObject({ report: "terminal summary", hasMore: false });
    await expect(
      tool.execute({ childRunId: "run_failure" }, {} as never),
    ).resolves.toMatchObject({ report: "failure report", hasMore: false });
  });

  it("keeps escape-heavy pages inside the serialized result budget without skipping text", async () => {
    const root = await createSessionRoot();
    const sessionId = "session_report_escape_budget";
    const childRunId = "run_escape_child";
    const report = "\u0000".repeat(6_000);
    await writeChildRun({
      root,
      sessionId,
      parentRunId: "run_parent",
      childRunId,
      agentId: "reviewer",
      result: { message: report, metadata: {} },
    });

    const tool = createReadAgentReportTool({ sessionRootDir: root, sessionId });
    const first = (await tool.execute(
      { childRunId, limit: 6_000 },
      {} as never,
    )) as {
      report: string;
      returnedChars: number;
      nextOffset: number;
      hasMore: boolean;
    };
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(6_800);
    expect(first.returnedChars).toBe(first.report.length);
    expect(first.returnedChars).toBeGreaterThan(0);
    expect(first.returnedChars).toBeLessThan(6_000);
    expect(first.nextOffset).toBe(first.returnedChars);
    expect(first.hasMore).toBe(true);

    const second = (await tool.execute(
      { childRunId, offset: first.nextOffset, limit: 6_000 },
      {} as never,
    )) as { report: string; offset: number };
    expect(second.offset).toBe(first.returnedChars);
    expect(first.report + second.report).toBe(
      report.slice(0, first.returnedChars + second.report.length),
    );
  });
});

async function createSessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-agent-report-"));
  tempDirs.push(root);
  return root;
}

async function writeChildRun(input: {
  root: string;
  sessionId: string;
  parentRunId: string;
  childRunId: string;
  agentId: string;
  result: Record<string, unknown>;
}): Promise<void> {
  const store = new FileSessionStore({ rootDir: input.root });
  await store.create({ id: input.sessionId });
  await store.append(input.sessionId, input.parentRunId as never);
  await store.append(input.sessionId, input.childRunId as never);
  await writeRunFiles({
    root: input.root,
    sessionId: input.sessionId,
    agentId: input.agentId,
    runId: input.childRunId,
    parentRunId: input.parentRunId,
    result: input.result,
  });
}

async function writeRunFiles(input: {
  root: string;
  sessionId: string;
  agentId: string;
  runId: string;
  parentRunId: string;
  message?: string;
  result?: Record<string, unknown>;
}): Promise<void> {
  const runDir = join(
    input.root,
    input.sessionId,
    "agents",
    input.agentId,
    "runs",
    input.runId,
  );
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      id: input.runId,
      metadata: { parentRunId: input.parentRunId },
    }),
  );
  await writeFile(
    join(runDir, "result.json"),
    JSON.stringify(input.result ?? { message: input.message, metadata: {} }),
  );
}
