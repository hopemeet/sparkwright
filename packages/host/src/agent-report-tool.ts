import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  FileSessionStore,
  defineTool,
  type ToolDefinition,
} from "@sparkwright/core";
import { findHostRunDirectory } from "./session-queries.js";

export const READ_AGENT_REPORT_TOOL_NAME = "read_agent_report";
const DEFAULT_REPORT_PAGE_CHARS = 4_000;
const MAX_REPORT_PAGE_CHARS = 6_000;
const MAX_REPORT_RESULT_JSON_CHARS = 6_800;
const MAX_CHILD_RUN_ID_CHARS = 256;

export interface CreateReadAgentReportToolInput {
  sessionRootDir: string;
  sessionId: string;
}

export function createReadAgentReportTool(
  input: CreateReadAgentReportToolInput,
): ToolDefinition {
  return defineTool({
    name: READ_AGENT_REPORT_TOOL_NAME,
    description:
      "Read a paginated window from the full persisted report of a child Agent in the current session. Use the childRunId from an Agent receipt; this tool never accepts filesystem paths.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: {
          type: "string",
          maxLength: MAX_CHILD_RUN_ID_CHARS,
          description: "Child run id returned by an Agent receipt.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Zero-based character offset. Defaults to 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_REPORT_PAGE_CHARS,
          description: `Maximum characters to return. Defaults to ${DEFAULT_REPORT_PAGE_CHARS}.`,
        },
      },
      required: ["childRunId"],
      additionalProperties: false,
    },
    resultSize: { maxChars: 7_000, neverPersist: true },
    resultPresentation: {
      kind: "file_read",
      preserveFields: [
        "childRunId",
        "report",
        "offset",
        "returnedChars",
        "totalChars",
        "hasMore",
        "nextOffset",
      ],
      paginationFields: ["offset", "limit", "hasMore", "nextOffset"],
      artifactPolicy: "never",
    },
    delegation: "parent_only",
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "idempotent",
    },
    async execute(args: unknown): Promise<unknown> {
      const request = parseReadAgentReportArgs(args);
      const sessionStore = new FileSessionStore({
        rootDir: input.sessionRootDir,
      });
      const session = await sessionStore.get(input.sessionId).catch(() => null);
      if (!session?.runIds.some((runId) => runId === request.childRunId)) {
        throw reportToolError(
          "AGENT_REPORT_NOT_FOUND",
          `No readable child Agent report exists for ${request.childRunId} in the current session.`,
        );
      }

      const located = await findHostRunDirectory(
        {
          workspaceRoot: input.sessionRootDir,
          sessionRootDir: input.sessionRootDir,
        },
        request.childRunId,
        input.sessionId,
      );
      if (!located.ok || located.agentId === "main") {
        throw reportToolError(
          "AGENT_REPORT_NOT_FOUND",
          `No readable child Agent report exists for ${request.childRunId} in the current session.`,
        );
      }

      const resultPath = await authorizedChildResultPath({
        sessionRootDir: input.sessionRootDir,
        sessionId: input.sessionId,
        runDir: located.runDir,
        agentId: located.agentId,
        childRunId: request.childRunId,
        sessionRunIds: session.runIds as readonly string[],
      });
      const result = await readRunResult(resultPath);
      const report = reportFromRunResult(result);
      if (report === undefined) {
        throw reportToolError(
          "AGENT_REPORT_UNAVAILABLE",
          `Child run ${request.childRunId} has no persisted textual report.`,
        );
      }

      return buildReportPage({
        childRunId: request.childRunId,
        report,
        offset: request.offset,
        limit: request.limit,
      });
    },
  });
}

function parseReadAgentReportArgs(value: unknown): {
  childRunId: string;
  offset: number;
  limit: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reportToolError(
      "AGENT_REPORT_ARGUMENTS_INVALID",
      "read_agent_report expects an object argument.",
    );
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find(
    (key) => key !== "childRunId" && key !== "offset" && key !== "limit",
  );
  if (unexpected) {
    throw reportToolError(
      "AGENT_REPORT_ARGUMENTS_INVALID",
      `Unexpected read_agent_report argument: ${unexpected}.`,
    );
  }
  const childRunId =
    typeof record.childRunId === "string" ? record.childRunId.trim() : "";
  if (!childRunId || childRunId.length > MAX_CHILD_RUN_ID_CHARS) {
    throw reportToolError(
      "AGENT_REPORT_ARGUMENTS_INVALID",
      `childRunId must be a non-empty string of at most ${MAX_CHILD_RUN_ID_CHARS} characters.`,
    );
  }
  const offset = record.offset ?? 0;
  const limit = record.limit ?? DEFAULT_REPORT_PAGE_CHARS;
  if (!Number.isInteger(offset) || (offset as number) < 0) {
    throw reportToolError(
      "AGENT_REPORT_ARGUMENTS_INVALID",
      "offset must be a non-negative integer.",
    );
  }
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_REPORT_PAGE_CHARS
  ) {
    throw reportToolError(
      "AGENT_REPORT_ARGUMENTS_INVALID",
      `limit must be an integer between 1 and ${MAX_REPORT_PAGE_CHARS}.`,
    );
  }
  return {
    childRunId,
    offset: offset as number,
    limit: limit as number,
  };
}

function buildReportPage(input: {
  childRunId: string;
  report: string;
  offset: number;
  limit: number;
}): Record<string, unknown> {
  const offset = Math.min(input.offset, input.report.length);
  const availableChars = Math.min(input.limit, input.report.length - offset);
  const candidate = (returnedChars: number): Record<string, unknown> => {
    const report = input.report.slice(offset, offset + returnedChars);
    const nextOffset = offset + report.length;
    const hasMore = nextOffset < input.report.length;
    return {
      childRunId: input.childRunId,
      report,
      offset,
      limit: input.limit,
      returnedChars: report.length,
      totalChars: input.report.length,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    };
  };

  const fullPage = candidate(availableChars);
  if (JSON.stringify(fullPage).length <= MAX_REPORT_RESULT_JSON_CHARS) {
    return fullPage;
  }

  let low = 0;
  let high = availableChars;
  let best = candidate(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const page = candidate(middle);
    if (JSON.stringify(page).length <= MAX_REPORT_RESULT_JSON_CHARS) {
      best = page;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

async function authorizedChildResultPath(input: {
  sessionRootDir: string;
  sessionId: string;
  runDir: string;
  agentId: string;
  childRunId: string;
  sessionRunIds: readonly string[];
}): Promise<string> {
  try {
    const sessionRootDir = await realpath(input.sessionRootDir);
    const sessionDir = await realpath(
      join(input.sessionRootDir, input.sessionId),
    );
    if (sessionDir !== join(sessionRootDir, input.sessionId)) {
      throw new Error("session directory alias");
    }

    const runDir = await realpath(input.runDir);
    if (
      runDir !==
      join(sessionDir, "agents", input.agentId, "runs", input.childRunId)
    ) {
      throw new Error("run directory alias");
    }

    const runRecordPath = await realpath(join(runDir, "run.json"));
    if (runRecordPath !== join(runDir, "run.json")) {
      throw new Error("run record alias");
    }
    const runRecord = JSON.parse(await readFile(runRecordPath, "utf8")) as {
      id?: unknown;
      metadata?: { parentRunId?: unknown };
    };
    const parentRunId = runRecord.metadata?.parentRunId;
    if (
      runRecord.id !== input.childRunId ||
      typeof parentRunId !== "string" ||
      !input.sessionRunIds.includes(parentRunId)
    ) {
      throw new Error("not a registered child");
    }

    const resultPath = await realpath(join(runDir, "result.json"));
    if (resultPath !== join(runDir, "result.json")) {
      throw new Error("result record alias");
    }
    return resultPath;
  } catch {
    throw reportToolError(
      "AGENT_REPORT_NOT_FOUND",
      "The requested child Agent report is not available in the current session.",
    );
  }
}

async function readRunResult(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw reportToolError(
      "AGENT_REPORT_UNAVAILABLE",
      "The persisted child Agent result could not be read.",
    );
  }
}

function reportFromRunResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  const terminalResult =
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata) &&
    typeof (record.metadata as Record<string, unknown>).terminalResult ===
      "object" &&
    (record.metadata as Record<string, unknown>).terminalResult !== null &&
    !Array.isArray((record.metadata as Record<string, unknown>).terminalResult)
      ? ((record.metadata as Record<string, unknown>).terminalResult as Record<
          string,
          unknown
        >)
      : undefined;
  const terminalOutput =
    terminalResult?.output &&
    typeof terminalResult.output === "object" &&
    !Array.isArray(terminalResult.output)
      ? (terminalResult.output as Record<string, unknown>)
      : undefined;
  if (typeof terminalOutput?.summary === "string") {
    return terminalOutput.summary;
  }
  const failure =
    record.failure &&
    typeof record.failure === "object" &&
    !Array.isArray(record.failure)
      ? (record.failure as Record<string, unknown>)
      : undefined;
  if (typeof failure?.message === "string") {
    return failure.message;
  }
  return undefined;
}

function reportToolError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
