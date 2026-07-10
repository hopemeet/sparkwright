import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { WorkflowRunSnapshot } from "@sparkwright/protocol";
import { WorkflowPanel } from "../src/components/workflow-panel.js";

function stripAnsi(text: string): string {
  return text.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
    "",
  );
}

function workflow(
  id: string,
  assetName: string,
  status: WorkflowRunSnapshot["status"] = "running",
): WorkflowRunSnapshot {
  return {
    id,
    assetName,
    status,
    contentHash: `${assetName}-hash`,
    runIds: [],
    attempts: {},
    resume: { verifyOnResume: true },
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

async function renderPanel(element: React.ReactElement): Promise<{
  input: (value: string) => Promise<void>;
  text: () => string;
  unmount: () => void;
}> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean;
  };
  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = () => fakeStdin;
  fakeStdin.ref = () => fakeStdin;
  fakeStdin.unref = () => fakeStdin;
  const instance = render(element, {
    stdout: fakeStdout,
    stdin: fakeStdin,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  return {
    input: async (value: string) => {
      fakeStdin.write(value);
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
    text: () => stripAnsi(writes.join("")),
    unmount: () => {
      instance.unmount();
      fakeStdin.destroy();
    },
  };
}

describe("WorkflowPanel", () => {
  it("lets keyboard navigation move away from the attached workflow", async () => {
    const selected: string[] = [];
    const panel = await renderPanel(
      <WorkflowPanel
        workflows={[
          workflow("workflow_alpha", "alpha"),
          workflow("workflow_beta", "beta", "waiting"),
        ]}
        selectedWorkflowId="workflow_alpha"
        loading={false}
        onClose={() => {}}
        onSelect={(id) => selected.push(id)}
        onRefresh={() => {}}
      />,
    );

    await panel.input("j");
    await panel.input("\r");
    // Read the rendered frame after unmount: under CI, Ink defers writes to
    // the final frame emitted on unmount, so reading before it yields "".
    panel.unmount();
    const text = panel.text();

    expect(selected).toEqual(["workflow_beta"]);
    expect(text).toContain("beta");
  });
});
