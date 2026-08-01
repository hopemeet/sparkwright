import { htmlToText } from "html-to-text";
import { WebFetchError } from "./safe-http.js";

const MAX_HTML_INPUT_CHARS = 2 * 1024 * 1024;
const MAX_RENDERED_LINK_CHARS = 512;

export interface ReadableWebContent {
  content: string;
  contentType: string;
}

export function extractReadableWebContent(
  body: Buffer,
  contentTypeHeader: string | undefined,
  baseUrl?: string,
): ReadableWebContent {
  const parsed = parseContentType(contentTypeHeader);
  if (!isSupportedTextType(parsed.mediaType)) {
    throw new WebFetchError(
      "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE",
      contentTypeHeader
        ? `Unsupported response content type: ${parsed.mediaType}.`
        : "The web response did not declare a supported text content type.",
      { contentType: parsed.mediaType || undefined },
    );
  }

  let decoded: string;
  try {
    decoded = new TextDecoder(parsed.charset ?? "utf-8").decode(body);
  } catch (cause) {
    throw new WebFetchError(
      "WEB_FETCH_UNSUPPORTED_CHARSET",
      `Unsupported response charset: ${parsed.charset}.`,
      { charset: parsed.charset },
      { cause },
    );
  }

  const content = isHtmlType(parsed.mediaType)
    ? htmlToText(decoded, {
        wordwrap: false,
        preserveNewlines: false,
        selectors: [
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "noscript", format: "skip" },
          { selector: "template", format: "skip" },
          { selector: "svg", format: "skip" },
          { selector: "canvas", format: "skip" },
          { selector: "form", format: "skip" },
          { selector: "input", format: "skip" },
          { selector: "button", format: "skip" },
          { selector: "select", format: "skip" },
          { selector: "textarea", format: "skip" },
          { selector: "nav", format: "skip" },
          { selector: "[hidden]", format: "skip" },
          { selector: '[aria-hidden="true"]', format: "skip" },
          {
            selector: "img",
            format: "image",
            options: { pathRewrite: () => "" },
          },
          {
            selector: 'a[href^="mailto:"]',
            format: "anchor",
            options: { ignoreHref: true },
          },
          {
            selector: 'a[href^="tel:"]',
            format: "anchor",
            options: { ignoreHref: true },
          },
          {
            selector: 'a[href^="javascript:"]',
            format: "anchor",
            options: { ignoreHref: true },
          },
          {
            selector: 'a[href^="data:"]',
            format: "anchor",
            options: { ignoreHref: true },
          },
          {
            selector: "a",
            format: "anchor",
            options: {
              hideLinkHrefIfSameAsText: true,
              noAnchorUrl: true,
              pathRewrite: (path) => rewriteWebLink(path, baseUrl),
            },
          },
        ],
        limits: {
          maxInputLength: MAX_HTML_INPUT_CHARS,
          maxChildNodes: 100_000,
          maxDepth: 100,
          ellipsis: "…",
        },
      })
    : decoded;

  return {
    content: normalizeReadableText(content),
    contentType: parsed.mediaType,
  };
}

function parseContentType(header: string | undefined): {
  mediaType: string;
  charset?: string;
} {
  if (!header) return { mediaType: "" };
  const [rawMediaType = "", ...parameters] = header.split(";");
  const mediaType = rawMediaType.trim().toLowerCase();
  for (const parameter of parameters) {
    const match = parameter.match(
      /^\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/i,
    );
    const charset = match?.[1] ?? match?.[2] ?? match?.[3];
    if (charset) return { mediaType, charset };
  }
  return { mediaType };
}

function isHtmlType(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function isSupportedTextType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml")
  );
}

function normalizeReadableText(value: string): string {
  const normalized = value.split("\0").join("�").replace(/\r\n?/g, "\n");
  let withoutControls = "";
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    const removableControl =
      (code >= 1 && code <= 31 && code !== 9 && code !== 10) || code === 127;
    if (!removableControl) withoutControls += character;
  }
  return withoutControls
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function rewriteWebLink(path: string, baseUrl: string | undefined): string {
  try {
    const url = baseUrl ? new URL(path, baseUrl) : new URL(path);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    const rendered = url.href;
    return rendered.length <= MAX_RENDERED_LINK_CHARS ? rendered : "";
  } catch {
    return "";
  }
}
