import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { ModelDialog } from "../src/components/model-dialog.js";

describe("ModelDialog provider catalog", () => {
  it("renders model auth readiness without exposing credentials", async () => {
    const text = await renderToText(
      <ModelDialog
        model="openai/gpt-ready"
        catalog={{
          selectedModel: "openai/gpt-ready",
          providers: [
            {
              id: "openai",
              npm: "@ai-sdk/openai",
              models: [
                {
                  ref: "openai/gpt-ready",
                  providerId: "openai",
                  modelId: "gpt-ready",
                  selected: true,
                },
              ],
              credential: {
                id: "credential_openai",
                providerId: "openai",
                status: "ready",
                source: "config",
                sourceLabel: "config",
                generation: 1,
              },
            },
            {
              id: "anthropic",
              npm: "@ai-sdk/anthropic",
              models: [
                {
                  ref: "anthropic/claude-test",
                  providerId: "anthropic",
                  modelId: "claude-test",
                  selected: false,
                },
              ],
              credential: {
                id: "credential_anthropic",
                providerId: "anthropic",
                status: "logged_out",
                generation: 2,
              },
            },
          ],
        }}
        onCommit={() => {}}
        onCancel={() => {}}
        onAuth={() => {}}
      />,
    );

    expect(text).toContain("✓ openai/gpt-ready");
    expect(text).toContain("× anthropic/claude-test");
    expect(text).toContain(
      "status: ✓ ready · ~ unverified · ○ missing · × disconnected",
    );
    expect(text).toContain("ctrl+l login · ctrl+o logout · ctrl+r refresh");
    expect(text).not.toContain("credential_openai");
  });

  it("keeps the current model selected when the async catalog reorders candidates", async () => {
    const { stdout, stdin } = interactiveIo();
    const onCommit = vi.fn();
    const common = { onCommit, onCancel: () => {} };
    const app = render(
      <ModelDialog
        {...common}
        model="openai/current"
        candidates={[
          "openai/nano",
          "openai/mini",
          "openai/standard",
          "openai/luna",
          "openai/current",
        ]}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await settle();

    app.rerender(
      <ModelDialog
        {...common}
        model="openai/current"
        catalog={{
          selectedModel: "openai/current",
          providers: [
            {
              id: "anthropic",
              npm: "@ai-sdk/anthropic",
              models: [
                {
                  ref: "anthropic/fast",
                  providerId: "anthropic",
                  modelId: "fast",
                  selected: false,
                },
                {
                  ref: "anthropic/smart",
                  providerId: "anthropic",
                  modelId: "smart",
                  selected: false,
                },
              ],
              credential: {
                id: "credential_anthropic",
                providerId: "anthropic",
                status: "ready",
                generation: 1,
              },
            },
            {
              id: "openai",
              npm: "@ai-sdk/openai",
              models: ["standard", "mini", "nano", "luna", "current"].map(
                (modelId) => ({
                  ref: `openai/${modelId}`,
                  providerId: "openai",
                  modelId,
                  selected: modelId === "current",
                }),
              ),
              credential: {
                id: "credential_openai",
                providerId: "openai",
                status: "ready",
                generation: 1,
              },
            },
          ],
        }}
      />,
    );
    await settle();
    stdin.write("\t");
    await settle();
    stdin.write("\r");
    await settle();
    app.unmount();
    stdin.destroy();

    expect(onCommit).toHaveBeenCalledWith("openai/current");
  });

  it("windows a long catalog around the current model", async () => {
    const text = await renderToText(
      <ModelDialog
        model="openai/model-10"
        catalog={{
          selectedModel: "openai/model-10",
          providers: [
            {
              id: "openai",
              npm: "@ai-sdk/openai",
              models: Array.from({ length: 12 }, (_, index) => ({
                ref: `openai/model-${index}`,
                providerId: "openai",
                modelId: `model-${index}`,
                selected: index === 10,
              })),
              credential: {
                id: "credential_openai",
                providerId: "openai",
                status: "ready",
                generation: 1,
              },
            },
          ],
        }}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(text).toContain("❯ ✓ openai/model-10");
    expect(text).toContain("5-12 of 12");
    expect(text).not.toContain("openai/model-0");
  });

  it("shows catalog loading state", async () => {
    const text = await renderToText(
      <ModelDialog
        model=""
        loading={true}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(text).toContain("loading provider catalog");
  });

  it("groups providers and orders favorites before recent models", async () => {
    const text = await renderToText(
      <ModelDialog
        model=""
        candidates={["anthropic/recent", "openai/other", "openai/favorite"]}
        preferences={{
          favorites: ["openai/favorite"],
          recent: [
            {
              ref: "anthropic/recent",
              lastUsedAt: Date.now(),
              useCount: 10,
            },
          ],
        }}
        onCommit={() => {}}
        onCancel={() => {}}
        onToggleFavorite={() => {}}
      />,
    );

    expect(text).toContain("ctrl+f toggle favorite");
    expect(text).toContain("★   openai/favorite");
    expect(text.indexOf("openai/favorite")).toBeLessThan(
      text.indexOf("anthropic/recent"),
    );
  });

  it("toggles the highlighted favorite with ctrl+f", async () => {
    const { stdout, stdin } = interactiveIo();
    const onToggleFavorite = vi.fn();
    const app = render(
      <ModelDialog
        model="openai/current"
        candidates={["openai/current", "openai/other"]}
        onCommit={() => {}}
        onCancel={() => {}}
        onToggleFavorite={onToggleFavorite}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await settle();
    stdin.write("\x06");
    await settle();
    app.unmount();
    stdin.destroy();

    expect(onToggleFavorite).toHaveBeenCalledWith("openai/current");
  });
});

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const stdout = {
    columns: 100,
    rows: 16,
    write(value: string) {
      writes.push(value);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const stdin = {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    addListener() {},
    on() {},
    off() {},
    removeListener() {},
    read() {
      return null;
    },
    ref() {},
    unref() {},
    resume() {},
    pause() {},
  } as unknown as NodeJS.ReadStream;
  const app = render(element, { stdout, stdin, patchConsole: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  app.unmount();
  return writes
    .join("")
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
      "",
    );
}

function interactiveIo(): {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
} {
  const stdout = {
    columns: 100,
    rows: 18,
    write() {
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const stdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return { stdout, stdin };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}
