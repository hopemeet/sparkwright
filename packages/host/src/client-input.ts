import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import type {
  RunInputPart,
  RunInputPayload,
  RunMediaInputPart,
} from "@sparkwright/protocol";

export const MAX_RUN_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_RUN_IMAGE_INPUT_TYPES = "png, jpg, jpeg, gif, or webp";

export type RunInputSummary = {
  attachmentCount: number;
  imageCount?: number;
};

export type RunImageInputPart = RunMediaInputPart & {
  type: "image";
  data: string;
  mediaType: string;
  name: string;
  metadata: {
    sourcePath: string;
    byteLength: number;
  };
};

export type BuildImageRunInputPartResult =
  | { ok: true; part: RunImageInputPart }
  | {
      ok: false;
      reason: "too_large";
      byteLength: number;
      maxBytes: number;
    }
  | { ok: false; reason: "unsupported_type" };

export function imageMediaTypeForPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

export function buildImageRunInputPart(input: {
  sourcePath: string;
  bytes: Uint8Array;
  resolvedPath?: string;
  maxBytes?: number;
}): BuildImageRunInputPartResult {
  const maxBytes = input.maxBytes ?? MAX_RUN_IMAGE_INPUT_BYTES;
  const byteLength = input.bytes.byteLength;
  if (byteLength > maxBytes) {
    return { ok: false, reason: "too_large", byteLength, maxBytes };
  }

  const mediaType = imageMediaTypeForPath(
    input.resolvedPath ?? input.sourcePath,
  );
  if (!mediaType) return { ok: false, reason: "unsupported_type" };

  return {
    ok: true,
    part: {
      type: "image",
      data: Buffer.from(input.bytes).toString("base64"),
      mediaType,
      name: basename(input.sourcePath),
      metadata: {
        sourcePath: input.sourcePath,
        byteLength,
      },
    },
  };
}

export function createRunInputPayloadFromParts(
  parts: readonly RunInputPart[],
): RunInputPayload | undefined {
  if (parts.length === 0) return undefined;
  const copiedParts = [...parts];
  return {
    parts: copiedParts,
    metadata: summarizeRunInputParts(copiedParts),
  };
}

export function runInputMetadataRecord(
  input: RunInputPayload | undefined,
): Record<string, unknown> {
  const summary = summarizeRunInputParts(input?.parts ?? []);
  return summary.attachmentCount > 0 ? { input: summary } : {};
}

export function summarizeRunInputParts(
  parts: readonly RunInputPart[],
): RunInputSummary {
  const imageCount = parts.filter((part) => part.type === "image").length;
  return {
    attachmentCount: parts.length,
    ...(imageCount > 0 ? { imageCount } : {}),
  };
}
