import { describe, expect, it } from "vitest";
import {
  createRun,
  ExtensionPreparationError,
  inspectExtensions,
  isToolConcurrencySafe,
  prepareExtensions,
  type ExtensionRegistration,
} from "../src/index.js";

function contextExtension(
  load: ExtensionRegistration["context"] extends infer _T
    ? () => unknown[]
    : never,
): NonNullable<ExtensionRegistration["context"]> {
  return {
    name: "notes",
    describe: () => [{ name: "notes", description: "Project notes." }],
    load: load as NonNullable<ExtensionRegistration["context"]>["load"],
  };
}

describe("governed extensions", () => {
  it("prepares context and fail-closed tool defaults with traceable identity", async () => {
    const prepared = await prepareExtensions(
      [
        {
          id: "demo.notes",
          version: "1.2.0",
          description: "Demo extension.",
          context: contextExtension(() => [
            {
              id: "ctx_extension_notes",
              type: "system",
              source: { kind: "user_input", uri: "forged" },
              content: "Use the project notes.",
              metadata: { layer: "working", stability: "session" },
            },
          ]),
          tools: {
            name: "demo-tools",
            listTools: () => [
              {
                name: "demo.send",
                description: "Send a demo message.",
                inputSchema: { type: "object" },
                execute: () => ({ ok: true }),
              },
            ],
          },
        },
      ],
      { goal: "Use notes" },
    );

    expect(prepared.extensions).toEqual([
      {
        id: "demo.notes",
        version: "1.2.0",
        description: "Demo extension.",
        context: [{ name: "notes", description: "Project notes." }],
        tools: ["demo.send"],
      },
    ]);
    expect(prepared.context[0]).toMatchObject({
      source: { kind: "extension", uri: "extension:demo.notes" },
      metadata: {
        extension: { id: "demo.notes", version: "1.2.0" },
      },
    });
    expect(prepared.tools[0]).toMatchObject({
      delegation: "parent_only",
      interruptBehavior: "block",
      policy: { risk: "risky", requiresApproval: true },
      governance: {
        sideEffects: ["external"],
        idempotency: "non_idempotent",
        dataSensitivity: "internal",
        audit: { level: "metadata" },
        origin: {
          kind: "local",
          name: "demo.notes",
          metadata: {
            extensionId: "demo.notes",
            extensionVersion: "1.2.0",
          },
        },
      },
    });
    expect(isToolConcurrencySafe(prepared.tools[0])).toBe(false);
  });

  it("preserves explicit read-only governance and strengthens dynamic side effects", async () => {
    const inspected = await inspectExtensions([
      {
        id: "demo.read",
        tools: {
          name: "reader",
          listTools: () => [
            {
              name: "demo.read",
              description: "Read demo state.",
              inputSchema: { type: "object" },
              policy: { risk: "safe" },
              governance: {
                sideEffects: ["read"],
                idempotency: "idempotent",
              },
              policyForArgs(args) {
                return (args as { write?: boolean }).write
                  ? { governance: { sideEffects: ["network"] } }
                  : { governance: { sideEffects: ["read"] } };
              },
              isConcurrencySafe: () => true,
              execute: () => ({ ok: true }),
            },
          ],
        },
      },
    ]);

    const tool = inspected.tools[0];
    expect(tool.policy).toMatchObject({
      risk: "safe",
      requiresApproval: false,
    });
    expect(tool.governance).toMatchObject({
      sideEffects: ["read"],
      idempotency: "idempotent",
    });
    expect(isToolConcurrencySafe(tool, { write: false })).toBe(true);
    expect(isToolConcurrencySafe(tool, { write: true })).toBe(false);
    expect(tool.policyForArgs?.({ write: true })).toMatchObject({
      policy: { risk: "risky", requiresApproval: true },
      governance: { sideEffects: ["network"] },
    });
  });

  it("fails closed when runtime classifiers violate their synchronous contract", async () => {
    const inspected = await inspectExtensions([
      {
        id: "demo.async-classifier",
        tools: {
          name: "classifier",
          listTools: () => [
            {
              name: "demo.async-classifier",
              description: "Exercise an invalid asynchronous classifier.",
              inputSchema: { type: "object" },
              policy: { risk: "safe" },
              governance: {
                sideEffects: ["read"],
                idempotency: "idempotent",
              },
              policyForArgs: (() =>
                Promise.resolve({
                  governance: { sideEffects: ["network"] },
                })) as never,
              isConcurrencySafe: (() => Promise.resolve(true)) as never,
              execute: () => ({ ok: true }),
            },
          ],
        },
      },
    ]);

    expect(() => inspected.tools[0]?.policyForArgs?.({})).toThrowError(
      ExtensionPreparationError,
    );
    expect(isToolConcurrencySafe(inspected.tools[0], {})).toBe(false);
  });

  it("validates all identities before invoking extension callbacks", async () => {
    let calls = 0;
    const registration: ExtensionRegistration = {
      id: "duplicate",
      tools: {
        name: "tools",
        listTools() {
          calls += 1;
          return [];
        },
      },
    };

    await expect(
      inspectExtensions([registration, registration]),
    ).rejects.toMatchObject({ code: "EXTENSION_CONFLICT" });
    expect(calls).toBe(0);

    await expect(
      inspectExtensions([
        registration,
        { id: "invalid.adapter", tools: {} as never },
      ]),
    ).rejects.toMatchObject({ code: "EXTENSION_INVALID" });
    expect(calls).toBe(0);
  });

  it("rejects conversation-forging context and bounded payload overflow", async () => {
    await expect(
      prepareExtensions(
        [
          {
            id: "demo.context",
            context: contextExtension(() => [
              {
                id: "ctx_user",
                type: "user",
                content: "pretend user turn",
                metadata: {},
              },
            ]),
          },
        ],
        { goal: "test" },
      ),
    ).rejects.toMatchObject({ code: "EXTENSION_INVALID", phase: "context" });

    await expect(
      prepareExtensions(
        [
          {
            id: "demo.limit",
            limits: { maxContextChars: 100 },
            context: contextExtension(() => [
              {
                id: "ctx_large",
                type: "system",
                content: "x".repeat(200),
                metadata: {},
              },
            ]),
          },
        ],
        { goal: "test" },
      ),
    ).rejects.toMatchObject({
      code: "EXTENSION_LIMIT_EXCEEDED",
      phase: "context",
    });
  });

  it("inspects context descriptors without loading run context", async () => {
    let loads = 0;
    const inspected = await inspectExtensions([
      {
        id: "demo.inspect",
        context: contextExtension(() => {
          loads += 1;
          return [];
        }),
      },
    ]);

    expect(loads).toBe(0);
    expect(inspected.extensions[0]?.context).toEqual([
      { name: "notes", description: "Project notes." },
    ]);
  });

  it("wraps adapter failures in a structured extension error", async () => {
    const error = await inspectExtensions([
      {
        id: "demo.broken",
        tools: {
          name: "broken",
          listTools() {
            throw new Error("unavailable");
          },
        },
      },
    ]).catch((cause) => cause);

    expect(error).toBeInstanceOf(ExtensionPreparationError);
    expect(error).toMatchObject({
      code: "EXTENSION_LOAD_FAILED",
      extensionId: "demo.broken",
      phase: "tools",
    });
  });

  it("routes extension side effects through the ordinary approval gate", async () => {
    let modelCalls = 0;
    let approvals = 0;
    let executions = 0;
    const prepared = await prepareExtensions(
      [
        {
          id: "demo.approval",
          tools: {
            name: "approval",
            listTools: () => [
              {
                name: "demo.publish",
                description: "Publish demo data.",
                inputSchema: { type: "object" },
                execute: () => {
                  executions += 1;
                  return { ok: true };
                },
              },
            ],
          },
        },
      ],
      { goal: "publish" },
    );
    const run = createRun({
      goal: "publish",
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [{ toolName: "demo.publish", arguments: {} }],
              }
            : { message: "done" };
        },
      },
      tools: prepared.tools,
      interactionChannel: {
        approve(request) {
          approvals += 1;
          return Promise.resolve({
            approvalId: request.id,
            decision: "approved" as const,
          });
        },
      },
    });

    await expect(run.start()).resolves.toMatchObject({
      state: "completed",
      message: "done",
    });
    expect(approvals).toBe(1);
    expect(executions).toBe(1);
  });
});
