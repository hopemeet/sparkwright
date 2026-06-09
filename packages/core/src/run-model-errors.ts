// Model-error normalization for the run loop. Pure, stateless helpers that map
// a raw provider/model error (any shape) into the structured
// `ModelErrorEnvelope` the loop and retry controllers reason over: category,
// retryability, cool-down (retry-after), timeout kind, and recovery hint.
// Extracted from run.ts so the classification logic can be unit-tested in
// isolation; run.ts imports what it needs back.

import type {
  ModelErrorEnvelope,
  ModelRecoveryHint,
  ModelTimeoutKind,
  ToolResult,
} from "./types.js";
import {
  getNestedNumericProperty,
  getNestedStringProperty,
  getStringProperty,
  isRecord,
  nestedRecords,
} from "./record-utils.js";

const RETRYABLE_MODEL_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "RATE_LIMITED",
  "RATE_LIMIT_EXCEEDED",
  "TIMEOUT",
  "TOO_MANY_REQUESTS",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function getErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause)) {
    const message = getStringProperty(cause, "message");
    if (message !== undefined) return message;
  }
  return "Model completion failed.";
}

export class ModelCompletionFailure extends Error {
  readonly cause: unknown;
  readonly attempt: number;
  readonly retryable: boolean;

  constructor(cause: unknown, attempt: number, retryable: boolean) {
    super(getErrorMessage(cause));
    this.name = "ModelCompletionFailure";
    this.cause = cause;
    this.attempt = attempt;
    this.retryable = retryable;
  }
}

export function toModelFailure(cause: unknown): ModelCompletionFailure {
  if (cause instanceof ModelCompletionFailure) return cause;
  return new ModelCompletionFailure(cause, 1, false);
}

/**
 * Heuristic: did this tool failure plausibly leave a side effect dangling?
 *
 * Network / timeout / aborted classes are the dangerous ones — the tool may
 * have already sent its outbound request when the failure surfaced. Pure
 * validation / argument / schema errors are safe to ignore here because the
 * tool never actually executed.
 */
export function isLikelySideEffectFailure(
  error: ToolResult["error"] | undefined,
): boolean {
  if (!error) return false;
  const code = error.code?.toUpperCase?.() ?? "";
  if (RETRYABLE_MODEL_ERROR_CODES.has(code)) return true;
  if (
    code === "TOOL_TIMEOUT" ||
    code === "TOOL_ABORTED" ||
    code === "FETCH_FAILED" ||
    code === "NETWORK_ERROR" ||
    code.startsWith("E") // ECONN*, ETIME*, ENET*, etc.
  ) {
    return true;
  }
  const cause = error.cause;
  if (cause && typeof cause === "object" && !Array.isArray(cause)) {
    const nestedCode = (cause as Record<string, unknown>).code;
    if (typeof nestedCode === "string") {
      const upper = nestedCode.toUpperCase();
      if (RETRYABLE_MODEL_ERROR_CODES.has(upper)) return true;
    }
  }
  return false;
}

export function isRetryableModelFailure(cause: unknown): boolean {
  if (!isRecord(cause)) return false;

  if (hasNonRetryableProviderCode(cause)) return false;

  if (cause.retryable === true) return true;
  if (cause.retryable === false) return false;

  const status = getNestedNumericProperty(cause, ["status", "statusCode"]);
  if (status !== undefined) {
    return (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    );
  }

  const code = getNestedStringProperty(cause, ["code"])?.toUpperCase();
  return code !== undefined && RETRYABLE_MODEL_ERROR_CODES.has(code);
}

export function normalizeModelError(cause: unknown): ModelErrorEnvelope {
  const status = isRecord(cause)
    ? getNestedNumericProperty(cause, ["status", "statusCode"])
    : undefined;
  const code = isRecord(cause)
    ? getNestedStringProperty(cause, ["code"])
    : undefined;
  const upperCode = code?.toUpperCase();
  const providerCode = isRecord(cause)
    ? getProviderErrorCode(cause)
    : undefined;
  const recoveryHint = extractRecoveryHint(cause);
  const retryable = isRetryableModelFailure(cause);
  const retryAfterMs = extractRetryAfterMs(cause);
  const timeoutKind = extractTimeoutKind(cause, {
    status,
    code: upperCode,
  });
  const configuredTimeoutMs = isRecord(cause)
    ? getNestedNumericProperty(cause, [
        "configuredTimeoutMs",
        "timeoutMs",
        "timeout",
      ])
    : undefined;
  const elapsedMs = isRecord(cause)
    ? getNestedNumericProperty(cause, ["elapsedMs", "durationMs"])
    : undefined;

  return {
    category: modelErrorCategory({
      status,
      code: upperCode,
      providerCode,
      recoveryHint,
      timeoutKind,
    }),
    message: getErrorMessage(cause),
    code,
    providerCode,
    status,
    retryable,
    recoveryHint,
    timeoutKind,
    ...(configuredTimeoutMs !== undefined ? { configuredTimeoutMs } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    withholdOutput:
      recoveryHint === "reduce_input" || recoveryHint === "extend_output",
    safeToRetrySamePrompt: retryable && recoveryHint !== "reduce_input",
  };
}

/**
 * Best-effort extraction of a provider cool-down (in ms) from a raw model
 * error. Recognizes, in priority order:
 *   1. a numeric `retryAfterMs` field (already in ms)
 *   2. a numeric `retryAfter` field (interpreted as seconds)
 *   3. an HTTP `Retry-After` header — either delta-seconds (`"120"`) or an
 *      HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`), converted relative to now
 * All three are searched recursively (covers `error.headers['retry-after']`,
 * `cause.response.headers`, etc). Returns `undefined` when none is found or the
 * value is non-positive / unparseable.
 */
export function extractRetryAfterMs(cause: unknown): number | undefined {
  if (!isRecord(cause)) return undefined;

  const ms = getNestedNumericProperty(cause, ["retryAfterMs"]);
  if (ms !== undefined && Number.isFinite(ms) && ms > 0) return ms;

  const seconds = getNestedNumericProperty(cause, ["retryAfter"]);
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  const header = getNestedStringProperty(cause, ["retry-after", "Retry-After"]);
  if (header !== undefined) {
    const trimmed = header.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.round(numeric * 1000);
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return delta;
    }
  }

  return undefined;
}

export function modelErrorCategory(input: {
  status?: number;
  code?: string;
  providerCode?: string;
  recoveryHint?: ModelRecoveryHint;
  timeoutKind?: ModelTimeoutKind;
}): ModelErrorEnvelope["category"] {
  if (input.recoveryHint === "reduce_input") return "context_overflow";
  if (input.recoveryHint === "extend_output") return "output_truncated";
  if (input.timeoutKind) return "timeout";
  // Provider-specific terminal codes win over raw HTTP status because some
  // providers (e.g. OpenAI) signal billing/quota exhaustion with HTTP 429,
  // which is the same status used for transient rate limiting. Conflating
  // them would push terminal failures through the retry loop unnecessarily.
  if (input.providerCode === "insufficient_quota") return "quota";
  if (input.providerCode === "invalid_api_key") return "auth";
  if (input.providerCode === "model_not_found") return "invalid_request";
  if (input.status === 401 || input.status === 403) return "auth";
  if (input.status === 408) return "timeout";
  if (input.status === 429) return "rate_limited";
  if (input.status !== undefined && input.status >= 500) {
    return "provider_unavailable";
  }
  if (input.code === "CONTENT_FILTER") return "content_filter";
  if (input.code !== undefined && isTimeoutCode(input.code)) return "timeout";
  if (input.code !== undefined && RETRYABLE_MODEL_ERROR_CODES.has(input.code)) {
    return "network";
  }
  return "unknown";
}

export function extractTimeoutKind(
  cause: unknown,
  input: { status?: number; code?: string },
): ModelTimeoutKind | undefined {
  if (isRecord(cause)) {
    const explicit = getNestedStringProperty(cause, ["timeoutKind"]);
    if (isModelTimeoutKind(explicit)) return explicit;
  }

  const code = input.code;
  if (code !== undefined) {
    if (code.includes("CONNECT_TIMEOUT")) return "connect";
    if (isTimeoutCode(code)) return "request";
  }
  if (input.status === 408) return "request";

  const message = getErrorMessage(cause).toLowerCase();
  if (!message.includes("timeout") && !message.includes("timed out")) {
    return undefined;
  }
  if (message.includes("first token") || message.includes("ttft")) {
    return "first_token";
  }
  if (message.includes("stream")) return "stream";
  if (message.includes("connect")) return "connect";
  return "request";
}

export function isTimeoutCode(code: string): boolean {
  return (
    code === "TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code.endsWith("_TIMEOUT") ||
    code.includes("TIMEOUT")
  );
}

export function isModelTimeoutKind(
  value: string | undefined,
): value is ModelTimeoutKind {
  return (
    value === "connect" ||
    value === "request" ||
    value === "first_token" ||
    value === "stream" ||
    value === "unknown"
  );
}

export function hasNonRetryableProviderCode(
  value: Record<string, unknown>,
): boolean {
  const providerCode = getProviderErrorCode(value);
  return (
    providerCode === "insufficient_quota" ||
    providerCode === "invalid_api_key" ||
    providerCode === "model_not_found"
  );
}

export function getProviderErrorCode(
  value: Record<string, unknown>,
): string | undefined {
  const direct = getStringProperty(value, "code");
  if (direct !== undefined) return direct;

  const data = value.data;
  if (isRecord(data)) {
    const error = data.error;
    if (isRecord(error)) {
      const code = getStringProperty(error, "code");
      if (code !== undefined) return code;
    }
  }

  const error = value.error;
  if (isRecord(error)) {
    const code = getStringProperty(error, "code");
    if (code !== undefined) return code;
  }

  // Walk one more layer of nested records (e.g. cause/lastError) so that
  // wrappers like ModelCompletionFailure still expose the underlying
  // provider code. Without this, retry-wrapped errors lose `insufficient_quota`
  // and similar terminal signals, falling back to raw HTTP status alone.
  for (const nested of nestedRecords(value)) {
    const found = getProviderErrorCode(nested);
    if (found !== undefined) return found;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Recovery hint helpers (see ModelRecoveryHint). Providers attach
// `recoveryHint` on the error they throw. Common shapes:
//   { recoveryHint: 'reduce_input' }            // 413 / context too long
//   { recoveryHint: 'extend_output' }           // max_output_tokens hit
//   { recoveryHint: 'fallback_model' }          // provider down / quota
// We also recognize a few common HTTP signals so a vanilla provider error
// still routes through the recovery path without bespoke wrapping.
// ---------------------------------------------------------------------------
export function extractRecoveryHint(
  cause: unknown,
): ModelRecoveryHint | undefined {
  if (!isRecord(cause)) return undefined;
  const direct = getStringProperty(cause, "recoveryHint");
  if (
    direct === "reduce_input" ||
    direct === "extend_output" ||
    direct === "fallback_model"
  ) {
    return direct;
  }
  for (const nested of nestedRecords(cause)) {
    const inner = getStringProperty(nested, "recoveryHint");
    if (
      inner === "reduce_input" ||
      inner === "extend_output" ||
      inner === "fallback_model"
    ) {
      return inner;
    }
  }
  // Implicit signals from common provider error shapes:
  const status = getNestedNumericProperty(cause, ["status", "statusCode"]);
  if (status === 413) return "reduce_input";
  const code = getNestedStringProperty(cause, ["code"])?.toUpperCase();
  if (code === "PROMPT_TOO_LONG" || code === "CONTEXT_LENGTH_EXCEEDED") {
    return "reduce_input";
  }
  if (code === "MAX_OUTPUT_TOKENS") return "extend_output";
  return undefined;
}
