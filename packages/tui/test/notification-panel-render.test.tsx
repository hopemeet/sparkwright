import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { NotificationPanel } from "../src/components/notification-panel.js";
import type { UiSignal } from "../src/lib/ui-signal.js";

describe("NotificationPanel", () => {
  it("renders durable signal history and closes with Escape", async () => {
    const writes: string[] = [];
    const stdout = {
      columns: 80,
      rows: 24,
      write(value: string) {
        writes.push(value);
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
    const onClose = vi.fn();
    const signal: UiSignal = {
      id: "run_failure_1",
      kind: "error",
      scope: "RunFailure",
      source: "test",
      title: "run failed",
      message: "provider unavailable",
      persistence: "until-resolved",
      attention: "blurred",
      presentation: ["inline", "history"],
      createdAt: 1,
      updatedAt: 1,
      seen: true,
      resolved: false,
    };
    const instance = render(
      <NotificationPanel signals={[signal]} onClose={onClose} />,
      {
        stdout,
        stdin,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    instance.unmount();
    stdin.destroy();
    // eslint-disable-next-line no-control-regex
    const text = writes.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "");
    expect(text).toContain("notifications");
    expect(text).toContain("run failed · RunFailure");
    expect(text).toContain("provider unavailable");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
