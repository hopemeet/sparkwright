import { describe, expect, it } from "vitest";
import {
  DIALOG_MAX_WIDTH,
  DIALOG_MIN_WIDTH,
  dialogFrameWidth,
  resolveDialogColumns,
} from "../src/components/dialog-frame.js";

describe("dialogFrameWidth", () => {
  it("caps wide terminals at the dialog max", () => {
    expect(dialogFrameWidth(140)).toBe(DIALOG_MAX_WIDTH);
  });

  it("leaves room for terminal edges on narrow terminals", () => {
    expect(dialogFrameWidth(60)).toBe(58);
  });

  it("keeps a minimal fallback width for missing or tiny column counts", () => {
    expect(dialogFrameWidth(undefined)).toBe(DIALOG_MAX_WIDTH);
    expect(dialogFrameWidth(10)).toBe(DIALOG_MIN_WIDTH);
  });
});

describe("resolveDialogColumns", () => {
  it("uses COLUMNS when PTY stdout columns are implausibly small", () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = "60";
    try {
      expect(resolveDialogColumns(22)).toBe(60);
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it("prefers normal stdout columns over COLUMNS", () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = "60";
    try {
      expect(resolveDialogColumns(100)).toBe(100);
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });
});
