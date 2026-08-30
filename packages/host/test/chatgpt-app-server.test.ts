import type { ModelInput } from "@sparkwright/core";
import { describe, expect, it, vi } from "vitest";
import {
  createChatGptModelAdapter,
  listChatGptModels,
  type ChatGptAppServerNotification,
  type ChatGptAppServerRequest,
  type ChatGptAppServerSession,
} from "../src/chatgpt-app-server.js";

describe("ChatGPT App Server transport", () => {
  it("discovers the account-visible model catalog", async () => {
    const session = fakeSession(async (method) => {
      if (method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              description: "Account-visible model",
              inputModalities: ["text", "image"],
              isDefault: true,
            },
          ],
          nextCursor: null,
        };
      }
      return {};
    });

    await expect(listChatGptModels(async () => session)).resolves.toEqual([
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Account-visible model",
        inputModalities: ["text", "image"],
        isDefault: true,
      },
    ]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("runs in an isolated read-only thread and exposes only SparkWright tools", async () => {
    let notify:
      | ((notification: ChatGptAppServerNotification) => void)
      | undefined;
    let threadParams: Record<string, unknown> | undefined;
    const session = fakeSession(async (method, params) => {
      if (method === "thread/start") {
        threadParams = params as Record<string, unknown>;
        return { thread: { id: "thread_1" } };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          notify?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread_1",
              turnId: "turn_1",
              delta: "Hello from ChatGPT",
            },
          });
          notify?.({
            method: "rawResponse/completed",
            params: {
              threadId: "thread_1",
              turnId: "turn_1",
              usage: {
                inputTokens: 12,
                outputTokens: 4,
                totalTokens: 16,
                cachedInputTokens: 3,
              },
            },
          });
          notify?.({
            method: "turn/completed",
            params: {
              threadId: "thread_1",
              turnId: "turn_1",
              turn: { id: "turn_1", status: "completed", items: [] },
            },
          });
        }, 0);
        return { turn: { id: "turn_1", status: "inProgress" } };
      }
      return {};
    });
    session.onNotification = (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    };
    const adapter = createChatGptModelAdapter({
      modelId: "gpt-5.4",
      factory: async () => session,
    });

    await expect(
      adapter.complete({
        prompt: [
          { role: "system", content: "Follow the project policy." },
          { role: "user", content: "Say hello." },
        ],
        tools: [
          {
            name: "workspace_read",
            description: "Read one workspace file.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      } as ModelInput),
    ).resolves.toEqual({
      message: "Hello from ChatGPT",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
        costStatus: "unavailable",
        costUnavailableReason: "missing_pricing",
      },
      stopReason: "completed",
    });
    expect(threadParams).toMatchObject({
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      config: {
        features: {
          shell_tool: false,
          unified_exec: false,
          browser_use: false,
          multi_agent: false,
        },
      },
      baseInstructions: "Follow the project policy.",
      dynamicTools: [
        {
          type: "function",
          name: "workspace_read",
          description: "Read one workspace file.",
        },
      ],
    });
    expect(String(threadParams?.cwd)).toContain("sparkwright-chatgpt-");
    expect(session.close).toHaveBeenCalledOnce();
  });
});

function fakeSession(
  handler: (method: string, params?: unknown) => Promise<unknown>,
): ChatGptAppServerSession & { close: ReturnType<typeof vi.fn> } {
  return {
    request: handler as ChatGptAppServerSession["request"],
    onNotification() {
      return () => undefined;
    },
    onRequest(
      _listener: (
        request: ChatGptAppServerRequest,
      ) => unknown | Promise<unknown>,
    ) {
      return () => undefined;
    },
    close: vi.fn(async () => undefined),
  };
}
