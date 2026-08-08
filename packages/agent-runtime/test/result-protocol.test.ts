import { describe, expect, it } from "vitest";
import {
  parseSubAgentResult,
  SUB_AGENT_RESULT_PROMPT,
  validateDeclaredWrites,
} from "../src/concurrency/index.js";

describe("parseSubAgentResult", () => {
  it("parses a bare JSON object", () => {
    const out = parseSubAgentResult(
      JSON.stringify({
        status: "ok",
        writes: ["src/auth/foo.ts"],
        notes: "done",
        retryable: false,
      }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.value.status).toBe("ok");
      expect(out.value.writes).toEqual(["src/auth/foo.ts"]);
    }
  });

  it("parses a fenced ```json block at the end of prose", () => {
    const raw = [
      "I finished the task. Here is the result:",
      "",
      "```json",
      '{"status": "partial", "writes": [], "notes": "loop in progress", "retryable": true}',
      "```",
    ].join("\n");
    const out = parseSubAgentResult(raw);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.value.status).toBe("partial");
  });

  it("parses an embedded {...} after prose with no fence", () => {
    const raw =
      'Summary: implemented auth.\nFinal result:\n{"status":"ok","writes":["src/auth/login.ts"],"notes":"ok","retryable":false}';
    const out = parseSubAgentResult(raw);
    expect(out.kind).toBe("ok");
  });

  it("takes the LAST fenced block when several are present", () => {
    const raw = [
      "```json",
      '{"status":"fail","writes":[],"notes":"first attempt","retryable":true}',
      "```",
      "Then I tried again and got:",
      "```json",
      '{"status":"ok","writes":["x.ts"],"notes":"second attempt","retryable":false}',
      "```",
    ].join("\n");
    const out = parseSubAgentResult(raw);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.value.notes).toBe("second attempt");
  });

  it("returns invalid for empty input", () => {
    expect(parseSubAgentResult("")).toMatchObject({ kind: "invalid" });
    expect(parseSubAgentResult("   \n\n").kind).toBe("invalid");
  });

  it("returns invalid when no JSON object is present", () => {
    expect(parseSubAgentResult("I finished the task.").kind).toBe("invalid");
  });

  it("returns invalid for malformed JSON", () => {
    expect(parseSubAgentResult('{"status": "ok",').kind).toBe("invalid");
  });

  it("returns invalid when required fields are missing or wrong type", () => {
    const bad = [
      '{"writes":[],"notes":"x","retryable":false}', // no status
      '{"status":"maybe","writes":[],"notes":"x","retryable":false}',
      '{"status":"ok","writes":"oops","notes":"x","retryable":false}',
      '{"status":"ok","writes":[],"notes":0,"retryable":false}',
      '{"status":"ok","writes":[],"notes":"x","retryable":"yes"}',
    ];
    for (const raw of bad) {
      expect(parseSubAgentResult(raw).kind, raw).toBe("invalid");
    }
  });
});

describe("validateDeclaredWrites", () => {
  it("flags actual writes outside the declared partition", () => {
    const r = validateDeclaredWrites(
      ["src/auth/**"],
      ["src/auth/foo.ts", "src/billing/bar.ts"],
    );
    expect(r.violations).toEqual(["src/billing/bar.ts"]);
  });

  it("returns no violations when every actual write matches a declared glob", () => {
    const r = validateDeclaredWrites(
      ["src/auth/**", "tests/**"],
      ["src/auth/foo.ts", "tests/auth.test.ts"],
    );
    expect(r.violations).toEqual([]);
  });

  it("reports declared globs that were never used", () => {
    const r = validateDeclaredWrites(
      ["src/auth/**", "tests/**", "docs/**"],
      ["src/auth/foo.ts"],
    );
    expect(r.unused.sort()).toEqual(["docs/**", "tests/**"]);
  });
});

describe("SUB_AGENT_RESULT_PROMPT", () => {
  it("documents the JSON contract", () => {
    expect(SUB_AGENT_RESULT_PROMPT).toContain('"status"');
    expect(SUB_AGENT_RESULT_PROMPT).toContain('"writes"');
    expect(SUB_AGENT_RESULT_PROMPT).toContain('"retryable"');
  });
});
