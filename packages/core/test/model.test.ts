import { describe, expect, it } from "vitest";
import {
  createAbortableModelAdapter,
  createFallbackModelAdapter,
  createRoutingModelAdapter,
  type ModelAdapter,
  type ModelInput,
} from "../src/index.js";

describe("model adapter helpers", () => {
  it("falls back across model adapters", async () => {
    const failures: string[] = [];
    const model = createFallbackModelAdapter(
      [
        {
          id: "primary",
          adapter: failingModel("primary failed"),
        },
        {
          id: "backup",
          adapter: messageModel("backup done"),
        },
      ],
      {
        onFailure(event) {
          failures.push(`${event.adapterId}:${event.attempt}`);
        },
      },
    );

    await expect(model.complete(input("use backup"))).resolves.toMatchObject({
      message: "backup done",
    });
    expect(failures).toEqual(["primary:1"]);
  });

  it("routes model calls by structured input", async () => {
    const model = createRoutingModelAdapter(
      [
        {
          id: "coding",
          when(input) {
            return input.run.goal.includes("code");
          },
          adapter: messageModel("coding route"),
        },
      ],
      {
        fallback: messageModel("fallback route"),
      },
    );

    await expect(model.complete(input("write code"))).resolves.toMatchObject({
      message: "coding route",
    });
    await expect(model.complete(input("summarize"))).resolves.toMatchObject({
      message: "fallback route",
    });
  });

  it("aborts model calls before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const model = createAbortableModelAdapter(
      {
        async complete() {
          called = true;
          return { message: "never" };
        },
      },
      { signal: controller.signal },
    );

    await expect(model.complete(input("abort"))).rejects.toMatchObject({
      name: "AbortError",
      message: "Model operation aborted.",
    });
    expect(called).toBe(false);
  });
});

function failingModel(message: string): ModelAdapter {
  return {
    async complete() {
      throw new Error(message);
    },
  };
}

function messageModel(message: string): ModelAdapter {
  return {
    async complete() {
      return { message };
    },
  };
}

function input(goal: string): ModelInput {
  const now = new Date().toISOString();
  return {
    run: {
      id: "run_model_test" as ModelInput["run"]["id"],
      goal,
      state: "running",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    context: [],
    tools: [],
    events: [],
    step: 1,
  };
}
