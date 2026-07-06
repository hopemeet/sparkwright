import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type WorkflowEvidenceRef,
  type WorkflowNodeDefinition,
  type WorkflowNodeVerdict,
  type WorkflowScriptNodeDefinition,
} from "@sparkwright/agent-runtime";
import type { WorkflowHookInput, WorkflowHookResult } from "@sparkwright/core";
import {
  createPlatformShellSandboxRuntime,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import type { CapabilityWorkflowHookConfig } from "./config.js";
import {
  inferProcessRuntime,
  TracedProcessRunner,
  type JsonRpcRequest,
  type ProgressContext,
} from "./traced-process-runner.js";

export interface WorkflowScriptNodeRunInput {
  workflowRunId: string;
  assetName: string;
  sourceDir?: string;
  node: WorkflowNodeDefinition;
  attempt: number;
  hookInput: WorkflowHookInput;
  workspaceRoot: string;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  allowWrite: boolean;
  getEvidence(nodeId: string): readonly WorkflowEvidenceRef[];
  invokePrimitive(
    action: CapabilityWorkflowHookConfig["action"],
  ): Promise<WorkflowHookResult>;
}

export interface WorkflowScriptNodeRunResult {
  verdict: WorkflowNodeVerdict;
  evidenceRefs: WorkflowEvidenceRef[];
}

type ScriptCompletion =
  | { kind: "complete"; result?: unknown }
  | { kind: "fail"; reason: string; metadata?: Record<string, unknown> };

export async function runWorkflowScriptNode(
  input: WorkflowScriptNodeRunInput,
): Promise<WorkflowScriptNodeRunResult> {
  const script = input.node.script;
  if (!script) {
    return runtimeError(
      input,
      `Workflow script node "${input.node.id}" has no script definition.`,
    );
  }
  if (!input.sourceDir) {
    return runtimeError(
      input,
      `Workflow script node "${input.node.id}" cannot resolve its asset directory.`,
    );
  }
  const authorization = authorizeScript(script, input.allowWrite);
  if (!authorization.ok) return runtimeError(input, authorization.message);
  const resolved = resolveWorkflowScriptInvocation(input.sourceDir, script);
  if (!resolved.ok) return runtimeError(input, resolved.message);

  let completion: ScriptCompletion | undefined;
  const runner = new TracedProcessRunner();
  const result = await runner.runJsonRpc({
    emitter: input.hookInput.events!,
    runId: input.hookInput.run.id,
    name: `workflow:${input.workflowRunId}:${input.node.id}`,
    kind: "custom",
    runtime: inferProcessRuntime(resolved.command),
    command: resolved.command,
    args: resolved.args,
    cwd: resolved.cwd,
    env: {
      ...script.env,
      SPARKWRIGHT_WORKFLOW_RUN_ID: input.workflowRunId,
      SPARKWRIGHT_WORKFLOW_NODE_ID: input.node.id,
      SPARKWRIGHT_WORKFLOW_ASSET: input.assetName,
    },
    timeoutMs: script.timeoutMs,
    sandbox: resolveScriptSandbox(input),
    sandboxRuntime: input.sandboxRuntime ?? createPlatformShellSandboxRuntime(),
    outputLimits: {
      previewBytes: script.maxOutputBytes,
      artifactBytes: script.maxOutputBytes,
      maxStdoutBytes: script.maxOutputBytes,
      maxStderrBytes: script.maxOutputBytes,
    },
    onRequest: async (request, context) => {
      const handled = await handleNodeApiRequest(input, request, context);
      if (handled.completion) completion = handled.completion;
      return handled.result;
    },
  });

  const evidenceRef: WorkflowEvidenceRef = {
    kind: "fact",
    ref: `workflow-script:${input.workflowRunId}:${input.node.id}:${result.invocationId}`,
    nodeId: input.node.id,
    metadata: {
      attempt: input.attempt,
      execute: "script",
      invocationId: result.invocationId,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      rpcRequests: result.rpcRequests,
      rpcErrors: result.rpcErrors,
      output: result.output,
    },
  };
  if (
    completion?.kind === "complete" &&
    result.exitCode === 0 &&
    result.rpcErrors === 0
  ) {
    return {
      verdict: {
        status: "passed",
        reason: "script_completed",
        metadata: {
          execute: "script",
          result: completion.result,
          invocationId: result.invocationId,
        },
      },
      evidenceRefs: [evidenceRef],
    };
  }
  if (completion?.kind === "fail") {
    return {
      verdict: {
        status: "failed",
        reason: completion.reason,
        metadata: {
          execute: "script",
          ...(completion.metadata ? { script: completion.metadata } : {}),
        },
      },
      evidenceRefs: [evidenceRef],
    };
  }
  return {
    verdict: {
      status: "runtime_error",
      reason:
        result.error?.message ??
        (result.exitCode === 0
          ? "Workflow script exited without nodeApi.complete()."
          : `Workflow script exited with ${result.exitCode ?? "no exit code"}.`),
      metadata: {
        execute: "script",
        invocationId: result.invocationId,
        rpcErrors: result.rpcErrors,
      },
    },
    evidenceRefs: [evidenceRef],
  };
}

async function handleNodeApiRequest(
  input: WorkflowScriptNodeRunInput,
  request: JsonRpcRequest,
  context: ProgressContext,
): Promise<{ result: unknown; completion?: ScriptCompletion }> {
  switch (request.method) {
    case "initialize":
      return {
        result: {
          protocol: "workflow-node-api.v1",
          workflowRunId: input.workflowRunId,
          nodeId: input.node.id,
          capabilities: input.node.script?.capabilities ?? [],
          methods: [
            "initialize",
            "progress",
            "getEvidence",
            "invoke",
            "complete",
            "fail",
          ],
        },
      };
    case "progress": {
      const params = recordParams(request.params);
      context.emit("extension.process.progress", {
        invocationId: context.invocationId,
        channel: "event",
        message: stringField(params, "message") ?? "workflow script progress",
        ...(isRecord(params.data) ? { data: params.data } : {}),
      });
      return { result: { ok: true } };
    }
    case "getEvidence": {
      const params = recordParams(request.params);
      const nodeId = stringField(params, "nodeId");
      if (!nodeId) throw new Error("getEvidence requires params.nodeId.");
      return { result: input.getEvidence(nodeId) };
    }
    case "invoke": {
      const action = primitiveActionFromParams(
        request.params,
        input.node.script,
      );
      const result = await input.invokePrimitive(action);
      return { result: result.metadata ?? { status: result.status } };
    }
    case "complete":
      return {
        result: { accepted: true },
        completion: {
          kind: "complete",
          result: isRecord(request.params)
            ? request.params.result
            : request.params,
        },
      };
    case "fail": {
      const params = recordParams(request.params);
      return {
        result: { accepted: true },
        completion: {
          kind: "fail",
          reason: stringField(params, "reason") ?? "workflow_script_failed",
          ...(isRecord(params.metadata) ? { metadata: params.metadata } : {}),
        },
      };
    }
    default:
      throw new Error(
        `Unsupported workflow node API method "${request.method}".`,
      );
  }
}

function primitiveActionFromParams(
  params: unknown,
  script: WorkflowScriptNodeDefinition | undefined,
): CapabilityWorkflowHookConfig["action"] {
  const record = recordParams(params);
  const type = stringField(record, "type");
  if (type === "command") {
    if (!script?.capabilities?.includes("shell")) {
      throw new Error("Script node did not declare shell capability.");
    }
    const command = stringField(record, "command");
    if (!command) throw new Error("invoke command requires params.command.");
    return {
      type: "command",
      command,
      args: stringArrayField(record.args) ?? [],
      ...(stringField(record, "cwd")
        ? { cwd: stringField(record, "cwd") }
        : {}),
      ...(nonNegativeInteger(record.timeoutMs) !== undefined
        ? { timeoutMs: nonNegativeInteger(record.timeoutMs) }
        : {}),
      ...(nonNegativeInteger(record.maxOutputBytes) !== undefined
        ? { maxOutputBytes: nonNegativeInteger(record.maxOutputBytes) }
        : {}),
      injectOutput: "never",
    };
  }
  throw new Error(
    `Unsupported workflow node API primitive "${type ?? "(missing)"}".`,
  );
}

function resolveWorkflowScriptInvocation(
  sourceDir: string,
  script: WorkflowScriptNodeDefinition,
):
  | { ok: true; command: string; args: string[]; cwd: string }
  | { ok: false; message: string } {
  const scriptPath = resolveInside(sourceDir, script.path);
  if (!scriptPath) {
    return {
      ok: false,
      message: "Workflow script path escapes the workflow asset directory.",
    };
  }
  const cwd = script.cwd ? resolveInside(sourceDir, script.cwd) : sourceDir;
  if (!cwd) {
    return {
      ok: false,
      message: "Workflow script cwd escapes the workflow asset directory.",
    };
  }
  if (
    scriptPath.endsWith(".js") ||
    scriptPath.endsWith(".mjs") ||
    scriptPath.endsWith(".cjs")
  ) {
    return {
      ok: true,
      command: process.execPath,
      args: [scriptPath, ...(script.args ?? [])],
      cwd,
    };
  }
  if (scriptPath.endsWith(".sh")) {
    return {
      ok: true,
      command: "bash",
      args: [scriptPath, ...(script.args ?? [])],
      cwd,
    };
  }
  return {
    ok: true,
    command: scriptPath,
    args: script.args ?? [],
    cwd,
  };
}

function resolveInside(root: string, value: string): string | undefined {
  if (isAbsolute(value) || value.includes("\0")) return undefined;
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, value);
  const rel = relative(resolvedRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return resolved;
}

function authorizeScript(
  script: WorkflowScriptNodeDefinition,
  allowWrite: boolean,
): { ok: true } | { ok: false; message: string } {
  const supportedCapabilities = new Set(["read", "write", "shell"]);
  const unsupported = (script.capabilities ?? []).filter(
    (capability) => !supportedCapabilities.has(capability),
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `Workflow script node requested unsupported capability: ${unsupported.join(", ")}.`,
    };
  }
  if (script.capabilities?.includes("write") && !allowWrite) {
    return {
      ok: false,
      message:
        "Workflow script node requested write capability in a read-only run.",
    };
  }
  return { ok: true };
}

function resolveScriptSandbox(
  input: WorkflowScriptNodeRunInput,
): ResolvedShellSandboxConfig {
  if (input.sandbox && "forcedDenyWrite" in input.sandbox) {
    return input.sandbox;
  }
  return resolveShellSandboxConfig({
    workspaceRoot: input.workspaceRoot,
    config: input.sandbox,
    skillRoots: input.skillRoots,
    extraForcedDenyWrite: input.configPaths,
  });
}

function runtimeError(
  input: WorkflowScriptNodeRunInput,
  reason: string,
): WorkflowScriptNodeRunResult {
  return {
    verdict: {
      status: "runtime_error",
      reason,
      metadata: { execute: "script" },
    },
    evidenceRefs: [],
  };
}

function recordParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return out.length > 0 ? out : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
