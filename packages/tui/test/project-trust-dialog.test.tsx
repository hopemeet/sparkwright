import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import type { ProjectTrustSnapshot } from "@sparkwright/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProjectTrustDialog } from "../src/components/project-trust-dialog.js";

const snapshot: ProjectTrustSnapshot = {
  canonicalWorkspaceRoot: "/workspace/project",
  workspaceId: "workspace_test",
  status: "untrusted",
  manifestHash: "sha256:manifest",
  scopes: [
    {
      scope: "commands",
      status: "untrusted",
      effects: ["process"],
      fileCount: 1,
      byteCount: 42,
      manifestHash: "sha256:commands",
    },
    {
      scope: "skills",
      status: "not_present",
      effects: ["process"],
      fileCount: 0,
      byteCount: 0,
    },
  ],
};

describe("ProjectTrustDialog", () => {
  it("renders scope effects and requires an explicit second confirmation", async () => {
    const { stdout, stdin } = interactiveIo();
    const onGrant = vi.fn();
    const app = render(
      <ProjectTrustDialog
        snapshot={snapshot}
        loading={false}
        onGrant={onGrant}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await settle();

    expect(stripAnsi(stdout.output())).toContain("commands: untrusted");
    expect(stripAnsi(stdout.output())).toContain("process");
    stdin.write("g");
    await settle();
    expect(onGrant).not.toHaveBeenCalled();
    expect(stripAnsi(stdout.output())).toContain(
      "Trust every currently present scope at this exact manifest?",
    );
    stdin.write("y");
    await settle();
    expect(onGrant).toHaveBeenCalledWith("sha256:manifest");

    app.unmount();
    stdin.destroy();
  });

  it("requires confirmation before revoking all scopes", async () => {
    const { stdout, stdin } = interactiveIo();
    const onRevoke = vi.fn();
    const app = render(
      <ProjectTrustDialog
        snapshot={{ ...snapshot, status: "trusted" }}
        loading={false}
        onGrant={() => {}}
        onRevoke={onRevoke}
        onClose={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );
    await settle();

    stdin.write("r");
    await settle();
    expect(onRevoke).not.toHaveBeenCalled();
    stdin.write("\r");
    await settle();
    expect(onRevoke).toHaveBeenCalledTimes(1);

    app.unmount();
    stdin.destroy();
  });
});

function interactiveIo(): {
  stdout: NodeJS.WriteStream & { output(): string };
  stdin: NodeJS.ReadStream & PassThrough;
} {
  const writes: string[] = [];
  const stdout = {
    columns: 100,
    rows: 18,
    write(value: string) {
      writes.push(value);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
    output: () => writes.join(""),
  } as unknown as NodeJS.WriteStream & { output(): string };
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return { stdout, stdin };
}

function stripAnsi(value: string): string {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
    "",
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}
